from __future__ import annotations

import json
import concurrent.futures
import threading
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from mfs import ByDocumentId, DocumentId

from python import stashbase_daemon


class TinyEmbedder:
    embedding_space = "stashbase-test/tiny"
    dimension = 3

    def embed_documents(self, texts):
        return [[1.0, 0.0, float("needle" in text)] for text in texts]

    def embed_query(self, text):
        return [1.0, 0.0, float("needle" in text)]


class StashbaseMfsTests(unittest.TestCase):
    """MFS-backed daemon behaviour.

    Paths come back in the daemon's own canonical form, which uses forward
    slashes on every platform: it is the form the namespace keys and document
    ids are built from, and the form the server canonicalizes to before it
    compares anything. Expectations therefore read `Path.as_posix()` rather
    than `str(Path)`, which differ only on Windows and hid this for as long as
    the suite ran on POSIX alone. Arguments passed in stay native, because
    that is what a caller on Windows actually holds.
    """

    def test_internal_projection_uses_one_deterministic_namespace_per_folder(self) -> None:
        with tempfile.TemporaryDirectory() as data, tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "notes" / "hello.md"
            source.parent.mkdir()
            content = "hello from the visible source"
            source.write_text(content, encoding="utf-8")
            service = stashbase_daemon.StashbaseMFS(data)
            try:
                first = service.bind_folder(
                    {"folder": folder, "folder_identity": folder, "provider": "openai"}
                )
                second = service.bind_folder(
                    {"folder": folder, "folder_identity": folder, "provider": "openai"}
                )
                self.assertEqual(first, second)
                self.assertTrue(first["namespace"].startswith("folder-"))
                result = service.upsert({"path": str(source), "content": content})
                self.assertEqual(result["outcome"], "added")
                self.assertEqual(
                    service.upsert({"path": str(source), "content": content})["outcome"],
                    "unchanged",
                )
                self.assertEqual(service.list_documents(folder), [source.as_posix()])
                chunks = service._mfs.grep(
                    first["namespace"],
                    [ByDocumentId(DocumentId(first["namespace"], "notes/hello.md"))],
                    select="chunk",
                    limit=10,
                )
                self.assertEqual([item.value.document_id.doc_id for item in chunks.items], ["notes/hello.md"])
                self.assertEqual(service.delete({"path": str(source)}), {"removed": 1})
                self.assertEqual(service.list_documents(folder), [])
            finally:
                service.close()

    def test_consecutive_save_acceptance_does_not_wait_for_embeddings(self) -> None:
        entered, release = threading.Event(), threading.Event()

        class SlowEmbedder(TinyEmbedder):
            def embed_documents(self, texts):
                entered.set()
                if not release.wait(15):
                    raise TimeoutError("test embedder was not released")
                return super().embed_documents(texts)

        with tempfile.TemporaryDirectory() as data, tempfile.TemporaryDirectory() as folder:
            service = stashbase_daemon.StashbaseMFS(data)
            try:
                with mock.patch.object(stashbase_daemon, "make_embedder", return_value=SlowEmbedder()):
                    service.bind_folder({"folder": folder, "api_key": "fixture-only"})
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    try:
                        source = str(Path(folder) / "note.md")
                        first = pool.submit(service.upsert, {
                            "path": source, "content": "oldneedle", "wait_for_index": False,
                        })
                        self.assertEqual(first.result(timeout=5)["outcome"], "added")
                        # The worker may still be opening its native vector store.
                        # Wait for the barrier independently of the save deadlines.
                        self.assertTrue(entered.wait(30), "embedding worker did not reach the test barrier")
                        second = pool.submit(service.upsert, {
                            "path": source, "content": "newneedle", "wait_for_index": False,
                        })
                        self.assertEqual(second.result(timeout=5)["outcome"], "updated")
                        self.assertFalse(release.is_set())
                        release.set()
                        old = pool.submit(service.grep, {"folder": folder, "query": "oldneedle"})
                        new = pool.submit(service.grep, {"folder": folder, "query": "newneedle"})
                        self.assertEqual(old.result(timeout=5)["total_matches"], 0)
                        self.assertEqual(new.result(timeout=5)["total_matches"], 1)
                    finally:
                        release.set()
            finally:
                release.set()
                service.close()

    def test_internal_namespace_never_scans_the_user_folder(self) -> None:
        with tempfile.TemporaryDirectory() as data, tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "note.md").write_text("note", encoding="utf-8")
            bundle = root / "note_files"
            bundle.mkdir()
            (bundle / "hidden.txt").write_text("hidden", encoding="utf-8")
            service = stashbase_daemon.StashbaseMFS(data)
            try:
                service.bind_folder({"folder": folder, "provider": "openai"})
                self.assertEqual(service.list_documents(folder), [])
            finally:
                service.close()

    def test_prefix_cleanup_uses_mfs_document_status(self) -> None:
        with tempfile.TemporaryDirectory() as data, tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            keep = root / "keep.md"
            removed = root / "archive" / "old.md"
            removed.parent.mkdir()
            service = stashbase_daemon.StashbaseMFS(data)
            try:
                service.bind_folder({"folder": folder, "provider": "openai"})
                service.upsert({"path": str(keep), "content": "keep"})
                service.upsert({"path": str(removed), "content": "remove"})
                self.assertEqual(
                    service.delete_prefix({"prefix": str(removed.parent)}),
                    {"removed": 1},
                )
                self.assertEqual(service.list_documents(folder), [keep.as_posix()])
            finally:
                service.close()

    def test_mfs_owns_unchanged_update_and_rename_projection_outcomes(self) -> None:
        with tempfile.TemporaryDirectory() as data, tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            old = root / "old.md"
            old.write_text("same bytes", encoding="utf-8")
            service = stashbase_daemon.StashbaseMFS(data)
            try:
                service.bind_folder({"folder": folder, "provider": "openai"})
                self.assertEqual(
                    service.upsert({"path": str(old), "content": "same bytes"})["outcome"],
                    "added",
                )
                self.assertEqual(
                    service.upsert({"path": str(old), "content": "same bytes"})["outcome"],
                    "unchanged",
                )
                self.assertEqual(
                    service.upsert({"path": str(old), "content": "changed"})["outcome"],
                    "updated",
                )
                new = root / "new.md"
                old.rename(new)
                service.delete({"path": str(old)})
                result = service.upsert({"path": str(new), "content": "changed"})
                self.assertEqual(result["outcome"], "added")
                self.assertEqual(service.list_documents(folder), [new.as_posix()])
            finally:
                service.close()

    def test_nested_member_folder_owns_its_own_namespace(self) -> None:
        with tempfile.TemporaryDirectory() as data, tempfile.TemporaryDirectory() as folder:
            outer = Path(folder)
            nested = outer / "nested"
            nested.mkdir()
            source = nested / "note.md"
            source.write_text("nested", encoding="utf-8")
            service = stashbase_daemon.StashbaseMFS(data)
            try:
                outer_bind = service.bind_folder({"folder": str(outer), "provider": "openai"})
                nested_bind = service.bind_folder({"folder": str(nested), "provider": "openai"})
                service.upsert({"path": str(source), "content": "nested"})
                self.assertNotEqual(outer_bind["namespace"], nested_bind["namespace"])
                self.assertEqual(service.list_documents(str(outer)), [])
                self.assertEqual(service.list_documents(str(nested)), [source.as_posix()])
            finally:
                service.close()

    def test_search_is_folder_scoped_and_filters_before_top_k(self) -> None:
        with tempfile.TemporaryDirectory() as data, tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            notes = root / "notes"
            notes.mkdir()
            wanted = notes / "wanted.md"
            outside = root / "outside.txt"
            wanted.write_text("semantic needle", encoding="utf-8")
            outside.write_text("semantic needle", encoding="utf-8")
            service = stashbase_daemon.StashbaseMFS(data)
            try:
                with mock.patch.object(stashbase_daemon, "make_embedder", return_value=TinyEmbedder()):
                    service.bind_folder({
                        "folder": folder, "provider": "openai", "api_key": "test-key"
                    })
                for source in (wanted, outside):
                    service.upsert({
                        "path": str(source), "content": source.read_text(encoding="utf-8"),
                    })
                result = service.search({
                    "query": "needle", "folder": folder, "path_prefix": str(notes),
                    "extensions": [".md"], "top_k": 1,
                })
                self.assertEqual([hit["path"] for hit in result["hits"]], [wanted.as_posix()])
                with self.assertRaisesRegex(ValueError, "Folder is not bound"):
                    service.search({"query": "needle", "folder": str(root / "other")})
            finally:
                service.close()

    def test_registering_nested_folder_retires_old_parent_rows_in_either_bind_order(self) -> None:
        for reopen in (False, True):
            with self.subTest(reopen=reopen), tempfile.TemporaryDirectory() as data, tempfile.TemporaryDirectory() as folder:
                nested = str(Path(folder) / "nested")
                source = str(Path(nested) / "note.md")
                service = stashbase_daemon.StashbaseMFS(data)
                try:
                    service.bind_folder({"folder": folder})
                    service.upsert({"path": source, "content": "oldneedle"})
                    if reopen:
                        service.close()
                        service = stashbase_daemon.StashbaseMFS(data)
                        service.bind_folder({"folder": nested})
                        service.bind_folder({"folder": folder})
                    else:
                        service.bind_folder({"folder": nested})
                    service.upsert({"path": source, "content": "newneedle"})
                    self.assertEqual(service.list_documents(folder), [])
                    self.assertEqual(service.status(folder)["total"], 0)
                    self.assertEqual(service.grep({"folder": folder, "query": "oldneedle"})["files"], [])
                    self.assertEqual(service.grep({"folder": nested, "query": "newneedle"})["total_matches"], 1)
                    service.delete({"path": source})
                    self.assertEqual(service.list_documents(), [])
                finally:
                    service.close()

    def test_embedding_activation_keeps_keyword_and_status_responsive(self) -> None:
        entered, release = threading.Event(), threading.Event()

        class SlowEmbedder(TinyEmbedder):
            def embed_documents(self, texts):
                entered.set()
                if not release.wait(15):
                    raise TimeoutError("test embedder was not released")
                return super().embed_documents(texts)

        with tempfile.TemporaryDirectory() as data, tempfile.TemporaryDirectory() as folder:
            other = str(Path(folder) / "other")
            service = stashbase_daemon.StashbaseMFS(data)
            try:
                binding = service.bind_folder({"folder": folder})
                service.bind_folder({"folder": other})
                for root in (folder, other):
                    service.upsert({"path": str(Path(root) / "note.md"), "content": "needle"})
                with concurrent.futures.ThreadPoolExecutor() as pool, mock.patch.object(
                    stashbase_daemon, "make_embedder", return_value=SlowEmbedder()
                ):
                    try:
                        activation = pool.submit(service.bind_folder, {"folder": folder, "api_key": "test-key"})
                        self.assertTrue(entered.wait(8))
                        activation.result(timeout=2)
                        for root in (folder, other):
                            result = pool.submit(service.grep, {"folder": root, "query": "needle"}).result(timeout=2)
                            self.assertEqual(result["total_matches"], 1)
                        pending = pool.submit(service.status, folder).result(timeout=2)
                        self.assertEqual(pending["indexed"], 0)
                        self.assertEqual(pending["pending_count"], 1)
                        self.assertFalse(pending["up_to_date"])
                        self.assertTrue(pool.submit(service.status, other).result(timeout=2)["up_to_date"])
                    finally:
                        release.set()
                service._mfs.wait(binding["namespace"], 15)
                self.assertEqual(service.status(folder)["indexed"], 1)
                self.assertTrue(service.status(folder)["up_to_date"])
            finally:
                release.set()
                service.close()

    def test_grep_uses_mfs_text_without_an_embedding_provider(self) -> None:
        with tempfile.TemporaryDirectory() as data, tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            notes = root / "notes"
            notes.mkdir()
            wanted = notes / "wanted.md"
            other = root / "other.txt"
            service = stashbase_daemon.StashbaseMFS(data)
            try:
                service.bind_folder({"folder": folder, "provider": "openai"})
                service.upsert({
                    "path": str(wanted),
                    "content": "前缀 needle result\nneedles do not count",
                })
                service.upsert({"path": str(other), "content": "needle outside"})

                result = service.grep({
                    "query": "needle",
                    "folder": folder,
                    "path_prefix": str(notes),
                    "extensions": [".md"],
                    "whole_word": True,
                })

                self.assertEqual(result["total_matches"], 1)
                self.assertFalse(result["truncated"])
                self.assertEqual(service.status(folder)["pending_count"], 0)
                self.assertTrue(service.status(folder)["up_to_date"])
                self.assertEqual(result["files"], [{
                    "path": "notes/wanted.md",
                    "matches": [{
                        "line": 1,
                        "text": "前缀 needle result",
                        "ranges": [[3, 9]],
                    }],
                    "total_matches": 1,
                }])
            finally:
                service.close()

    def test_removing_embedding_provider_keeps_mfs_grep_writable(self) -> None:
        with tempfile.TemporaryDirectory() as data, tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "note.md"
            service = stashbase_daemon.StashbaseMFS(data)
            try:
                with mock.patch.object(stashbase_daemon, "make_embedder", return_value=TinyEmbedder()):
                    binding = service.bind_folder({
                        "folder": folder, "provider": "openai", "api_key": "test-key"
                    })
                service.upsert({"path": str(source), "content": "old text"})

                service.bind_folder({"folder": folder, "provider": "openai"})
                service.upsert({"path": str(source), "content": "new exact needle"})

                self.assertEqual(
                    service._mfs.namespace_configuration(binding["namespace"]).indexing,
                    "off",
                )
                self.assertEqual(
                    service.grep({"query": "needle", "folder": folder})["total_matches"],
                    1,
                )
                with mock.patch.object(stashbase_daemon, "make_embedder", return_value=TinyEmbedder()):
                    service.bind_folder({
                        "folder": folder, "provider": "openai", "api_key": "new-key"
                    })
                service._mfs.wait(binding["namespace"], 15)
                self.assertEqual(
                    service._mfs.namespace_configuration(binding["namespace"]).indexing,
                    "hybrid",
                )
            finally:
                service.close()

    def test_openrouter_embedder_uses_openai_compatible_endpoint(self) -> None:
        calls = []

        class Embeddings:
            def create(self, **kwargs):
                calls.append(kwargs)
                return types.SimpleNamespace(
                    data=[types.SimpleNamespace(embedding=[0.1, 0.2, 0.3]) for _ in kwargs["input"]]
                )

        with mock.patch("openai.OpenAI") as client:
            client.return_value.embeddings = Embeddings()
            embedder = stashbase_daemon.make_embedder("openrouter", api_key="secret")
            self.assertEqual(embedder.embedding_space, "stashbase/openrouter/openai/text-embedding-3-small")
            self.assertEqual(embedder.embed_query("query"), [0.1, 0.2, 0.3])
            client.assert_called_once_with(
                api_key="secret", base_url="https://openrouter.ai/api/v1", timeout=60.0
            )
            self.assertEqual(calls, [{"model": "openai/text-embedding-3-small", "input": ["query"]}])

    def test_requesty_embedder_uses_openai_compatible_endpoint(self) -> None:
        calls = []

        class Embeddings:
            def create(self, **kwargs):
                calls.append(kwargs)
                return types.SimpleNamespace(
                    data=[types.SimpleNamespace(embedding=[0.1, 0.2, 0.3]) for _ in kwargs["input"]]
                )

        with mock.patch("openai.OpenAI") as client:
            client.return_value.embeddings = Embeddings()
            embedder = stashbase_daemon.make_embedder("requesty", api_key="secret")
            self.assertEqual(embedder.embedding_space, "stashbase/requesty/openai/text-embedding-3-small")
            self.assertEqual(embedder.embed_query("query"), [0.1, 0.2, 0.3])
            client.assert_called_once_with(
                api_key="secret", base_url="https://router.requesty.ai/v1", timeout=60.0
            )
            self.assertEqual(calls, [{"model": "openai/text-embedding-3-small", "input": ["query"]}])

    def test_removing_key_supersedes_pending_semantic_activation(self) -> None:
        entered, release = threading.Event(), threading.Event()

        class SlowEmbedder(TinyEmbedder):
            def embed_documents(self, texts):
                entered.set()
                if not release.wait(15):
                    raise TimeoutError("test embedder was not released")
                return super().embed_documents(texts)

        with tempfile.TemporaryDirectory() as data, tempfile.TemporaryDirectory() as folder:
            service = stashbase_daemon.StashbaseMFS(data)
            try:
                binding = service.bind_folder({"folder": folder})
                service.upsert({"path": str(Path(folder) / "note.md"), "content": "needle"})
                with mock.patch.object(stashbase_daemon, "make_embedder", return_value=SlowEmbedder()):
                    service.bind_folder({"folder": folder, "api_key": "test-key"})
                self.assertTrue(entered.wait(8))
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    try:
                        pool.submit(service.bind_folder, {"folder": folder}).result(timeout=2)
                        self.assertEqual(service.status(folder)["pending_count"], 0)
                        self.assertEqual(service.grep({"folder": folder, "query": "needle"})["total_matches"], 1)
                    finally:
                        release.set()
                service._mfs.wait(binding["namespace"], 15)
                self.assertEqual(service._mfs.namespace_configuration(binding["namespace"]).indexing, "off")
                self.assertEqual(service.status(folder)["indexed"], 0)
                service.upsert({"path": str(Path(folder) / "note.md"), "content": "newneedle"})
                self.assertEqual(service.grep({"folder": folder, "query": "newneedle"})["total_matches"], 1)
            finally:
                release.set()
                service.close()

    def test_only_byok_providers_are_accepted(self) -> None:
        with self.assertRaisesRegex(ValueError, "requires api_key"):
            stashbase_daemon.make_embedder("openai")
        with self.assertRaisesRegex(ValueError, "unsupported"):
            stashbase_daemon.make_embedder("onnx", api_key="unused")
        with self.assertRaisesRegex(ValueError, "unsupported"):
            stashbase_daemon.make_embedder("stashbase", api_key="unused")

    def test_stdio_daemon_closes_cleanly_after_eof(self) -> None:
        with tempfile.TemporaryDirectory() as data, tempfile.TemporaryDirectory() as folder:
            script = Path(stashbase_daemon.__file__).resolve()
            requests = "\n".join([
                json.dumps({"id": 1, "op": "bind_folder", "args": {"folder": folder, "provider": "openai"}}),
                "",
            ])
            completed = subprocess.run(
                [sys.executable, str(script), "--store-root", data],
                input=requests, text=True, capture_output=True, timeout=20, check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            messages = [json.loads(line) for line in completed.stdout.splitlines()]
            self.assertTrue(any(message.get("event") == "ready" for message in messages))
            replies = {message.get("id"): message for message in messages if "id" in message}
            self.assertTrue(replies[1]["ok"])

    def test_termination_signal_inventory_is_portable(self) -> None:
        signals = types.SimpleNamespace(SIGTERM=15, SIGINT=2)
        self.assertEqual(stashbase_daemon._termination_signals(signals), (15, 2))


if __name__ == "__main__":
    unittest.main()
