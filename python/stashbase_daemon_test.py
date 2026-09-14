import contextlib
import importlib
import io
import json
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

with contextlib.redirect_stdout(io.StringIO()):
    stashbase_daemon = importlib.import_module("stashbase_daemon")


class StashbaseDaemonTests(unittest.TestCase):
    def test_slow_indexing_and_search_leave_status_and_scan_slots_available(self):
        release = threading.Event()
        condition = threading.Condition()
        entered, replies = set(), {}

        def slow(_svc, args):
            with condition:
                entered.add(args["name"])
                condition.notify_all()
            self.assertTrue(release.wait(5))
            return {}

        def emit(reply):
            with condition:
                replies[reply["id"]] = reply
                condition.notify_all()

        handlers = {"upsert": slow, "search": slow, "status": lambda *_: {"indexed": 2},
                    "scan_diff": lambda *_: {"added": []}}
        dispatcher = stashbase_daemon._RequestDispatcher(None, emit=emit, handlers=handlers)
        try:
            for name, op in [("index", "upsert"), ("query1", "search"), ("query2", "search")]:
                dispatcher.submit({"id": name, "op": op, "args": {"name": name}})
            with condition:
                self.assertTrue(condition.wait_for(lambda: len(entered) == 3, 2))
            dispatcher.submit({"id": "status", "op": "status"})
            dispatcher.submit({"id": "scan", "op": "scan_diff"})
            with condition:
                self.assertTrue(condition.wait_for(lambda: "status" in replies and "scan" in replies, 2))
                self.assertTrue(replies["status"]["ok"])
                self.assertNotIn("index", replies)
        finally:
            release.set()
            dispatcher.close()

    def test_dispatch_preserves_write_order_and_exclusive_close_barrier(self):
        release, entered, closed = threading.Event(), threading.Event(), threading.Event()
        events = []

        def upsert(*_args):
            entered.set()
            self.assertTrue(release.wait(5))
            events.append("upsert")
            return {}

        def operation(name):
            def run(*_args):
                events.append(name)
                if name == "after-close":
                    closed.set()
                return {}
            return run

        dispatcher = stashbase_daemon._RequestDispatcher(None, emit=lambda _: None, handlers={
            "upsert": upsert, "delete": operation("delete"),
            "close_store": operation("close"), "status": operation("after-close"),
        })
        try:
            dispatcher.submit({"op": "upsert"})
            self.assertTrue(entered.wait(2))
            for op in ("delete", "close_store", "status"):
                dispatcher.submit({"op": op})
            self.assertEqual(events, [])
            release.set()
            self.assertTrue(closed.wait(3))
            self.assertEqual(events, ["upsert", "delete", "close", "after-close"])
        finally:
            release.set()
            dispatcher.close()

    def test_dispatch_bounds_pending_work_and_shutdown_retires_active_calls(self):
        release, entered, closing = threading.Event(), threading.Event(), threading.Event()
        replies = []

        def slow(*_args):
            entered.set()
            self.assertTrue(release.wait(5))
            return {}

        dispatcher = stashbase_daemon._RequestDispatcher(
            None, emit=replies.append, handlers={"upsert": slow}, max_pending=1,
        )
        try:
            dispatcher.submit({"id": 1, "op": "upsert"})
            self.assertTrue(entered.wait(2))
            dispatcher.submit({"id": 2, "op": "upsert"})
            dispatcher.submit({"id": 3, "op": "upsert"})
            self.assertEqual(replies[-1]["code"], "MFS_DAEMON_BUSY")
            thread = threading.Thread(target=lambda: (dispatcher.close(), closing.set()))
            thread.start()
            self.assertFalse(closing.wait(0.05))
            release.set()
            thread.join(3)
            self.assertTrue(closing.is_set())
            self.assertEqual({r["id"] for r in replies}, {1, 2, 3})
        finally:
            release.set()
            dispatcher.close()

    def test_search_backend_failure_is_not_reported_as_no_matches(self):
        store = types.SimpleNamespace(is_empty=lambda: False,
                                      hybrid_search=mock.Mock(side_effect=RuntimeError("index unavailable")))
        embedder = types.SimpleNamespace(embed=lambda _: [[1.0, 0.0]])
        svc = types.SimpleNamespace(stores=lambda: [("pk", embedder, store)])
        with self.assertRaisesRegex(RuntimeError, "index unavailable"):
            stashbase_daemon.op_search(svc, {"query": "needle"})

    def test_json_scanner_rules_keep_note_bundles_note_only(self) -> None:
        previous = {key: value.copy() if hasattr(value, "copy") else value for key, value in stashbase_daemon._RULES.items()}
        try:
            stashbase_daemon.op_set_rules(None, {
                "include_extensions": [".html", ".htm", ".json", ".txt"],
                "note_extensions": [".md", ".markdown", ".html", ".htm"],
            })
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / "data.JSON").write_text("{ invalid", encoding="utf-8")
                (root / "notes.txt").write_text("plain text", encoding="utf-8")
                bundle = root / "data_files"
                bundle.mkdir()
                (bundle / "child.md").write_text("# Visible", encoding="utf-8")
                scanned = stashbase_daemon._walk_disk(root)
                self.assertIn("data.JSON", scanned)
                self.assertIn("notes.txt", scanned)
                self.assertIn("data_files/child.md", scanned)
        finally:
            stashbase_daemon._RULES.clear()
            stashbase_daemon._RULES.update(previous)

    def test_json_scan_diff_tracks_add_modify_delete_rename_and_admission(self) -> None:
        previous = {key: value.copy() if hasattr(value, "copy") else value for key, value in stashbase_daemon._RULES.items()}
        try:
            stashbase_daemon.op_set_rules(None, {
                "include_extensions": [".html", ".htm", ".json"],
                "note_extensions": [".md", ".markdown", ".html", ".htm"],
                "excluded_dirs": ["node_modules", ".git"],
                "max_indexable_bytes": 32,
            })
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp).resolve()
                added = root / "added.JSON"
                modified = root / "modified.json"
                renamed = root / "renamed.JSON"
                whitespace = root / "space.json"
                added.write_text('{"added":true}', encoding="utf-8")
                modified.write_text('{ malformed', encoding="utf-8")
                renamed.write_text('{"same":true}', encoding="utf-8")
                whitespace.write_text("  \n\t", encoding="utf-8")
                (root / "empty.json").write_text("", encoding="utf-8")
                (root / "large.json").write_text("x" * 33, encoding="utf-8")
                (root / "node_modules").mkdir()
                (root / "node_modules" / "hidden.json").write_text('{"hidden":true}', encoding="utf-8")

                old_rename = (root / "old.json").as_posix()
                deleted = (root / "deleted.json").as_posix()
                indexed = {
                    modified.as_posix(): "old-modified-hash",
                    old_rename: stashbase_daemon.blake3(renamed.read_bytes()).hexdigest(),
                    deleted: stashbase_daemon.blake3(b"deleted").hexdigest(),
                }

                class FakeStore:
                    def get_indexed_files(self, _prefix):
                        return indexed

                class FakeService:
                    def stores(self):
                        return [("pk", None, FakeStore())]

                result = stashbase_daemon.op_scan_diff(FakeService(), {"folder": root.as_posix()})
                self.assertEqual(sorted(result["added"]), sorted([added.as_posix(), whitespace.as_posix()]))
                self.assertEqual(result["modified"], [modified.as_posix()])
                self.assertEqual(result["deleted"], [deleted])
                self.assertEqual(result["renamed"], [{
                    "old": old_rename,
                    "new": renamed.as_posix(),
                    "file_hash": indexed[old_rename],
                }])
                flattened = json.dumps(result)
                self.assertNotIn("empty.json", flattened)
                self.assertNotIn("large.json", flattened)
                self.assertNotIn("hidden.json", flattened)
        finally:
            stashbase_daemon._RULES.clear()
            stashbase_daemon._RULES.update(previous)

    def test_json_real_store_ingestion_search_and_lifecycle(self) -> None:
        """Raw JSON traverses the real chunker + Milvus store lifecycle."""
        try:
            import milvus_lite  # noqa: F401
        except ImportError:
            self.skipTest("milvus_lite is not installed")

        class FakeEmbedder:
            dimension = 3
            model_name = "json-lifecycle-embedder"

            def embed(self, texts):  # noqa: ANN001
                return [[1.0, float("lifecycle_key" in text), 0.0] for text in texts]

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve() / "library"
            root.mkdir()
            store_root = Path(tmp) / "store"
            valid = root / "valid.json"
            malformed = root / "broken.JSON"
            valid_text = '{\n  "lifecycle_key": "first value"\n}\n'
            malformed_text = '{"lifecycle_key": "unfinished"'
            valid.write_text(valid_text, encoding="utf-8")
            malformed.write_text(malformed_text, encoding="utf-8")

            svc = stashbase_daemon.StashbaseStore(str(store_root))
            try:
                embedder = FakeEmbedder()
                svc.bind_root(root.as_posix(), "openai", root_identity=root.as_posix())
                # Materialize the real collection with the deterministic test embedder.
                svc._ensure_store(embedder)
                valid_hash = stashbase_daemon.blake3(valid_text.encode()).hexdigest()
                malformed_hash = stashbase_daemon.blake3(malformed_text.encode()).hexdigest()
                valid_result = stashbase_daemon.op_upsert(svc, {
                    "path": valid.as_posix(), "content": valid_text,
                    "ext": ".json", "file_hash": valid_hash,
                })
                malformed_result = stashbase_daemon.op_upsert(svc, {
                    "path": malformed.as_posix(), "content": malformed_text,
                    "ext": ".JSON", "file_hash": malformed_hash,
                })
                self.assertGreater(valid_result["chunks"], 0)
                self.assertGreater(malformed_result["chunks"], 0)

                store = svc.stores()[0][2]
                fields = ["source", "chunk_text", "content_type", "file_hash"]
                rows = store._query_all(
                    f'source in ["{valid.as_posix()}", "{malformed.as_posix()}"]',
                    output_fields=fields,
                )
                by_source = {}
                for row in rows:
                    by_source.setdefault(row["source"], []).append(row)
                self.assertEqual(
                    "".join(row["chunk_text"] for row in by_source[valid.as_posix()]),
                    valid_text.rstrip("\n"),
                )
                self.assertEqual(
                    "".join(row["chunk_text"] for row in by_source[malformed.as_posix()]),
                    malformed_text,
                )
                self.assertTrue(all(row["content_type"] == "text" for row in rows))
                self.assertEqual(by_source[valid.as_posix()][0]["file_hash"], valid_hash)

                search = stashbase_daemon.op_search(svc, {
                    "query": "lifecycle_key", "folder": root.as_posix(),
                    "extensions": [".json"], "top_k": 10,
                })
                paths = {hit["path"] for hit in search["hits"]}
                self.assertEqual(paths, {valid.as_posix(), malformed.as_posix()})
                self.assertTrue(any("first value" in hit["chunk_text"] for hit in search["hits"]))
                self.assertTrue(any("unfinished" in hit["chunk_text"] for hit in search["hits"]))
                self.assertTrue(stashbase_daemon.op_status(
                    svc, {"folder": root.as_posix()},
                )["up_to_date"])

                modified_text = '{"lifecycle_key":"modified value"}\n'
                valid.write_text(modified_text, encoding="utf-8")
                modified_hash = stashbase_daemon.blake3(modified_text.encode()).hexdigest()
                stashbase_daemon.op_upsert(svc, {
                    "path": valid.as_posix(), "content": modified_text,
                    "ext": ".json", "file_hash": modified_hash,
                })
                modified_hits = stashbase_daemon.op_search(svc, {
                    "query": "modified value", "folder": root.as_posix(),
                    "extensions": [".json"], "top_k": 10,
                })["hits"]
                self.assertTrue(any(
                    hit["path"] == valid.as_posix() and "modified value" in hit["chunk_text"]
                    for hit in modified_hits
                ))

                renamed = root / "renamed.json"
                valid.rename(renamed)
                rename_result = stashbase_daemon.op_rename(svc, {
                    "old": valid.as_posix(), "new": renamed.as_posix(),
                    "content": modified_text, "ext": ".json", "file_hash": modified_hash,
                })
                self.assertTrue(rename_result["fast_path"])
                indexed = stashbase_daemon.op_list(svc, {"folder": root.as_posix()})["files"]
                self.assertNotIn(valid.as_posix(), indexed)
                self.assertEqual(indexed[renamed.as_posix()], modified_hash)
                self.assertTrue(stashbase_daemon.op_status(
                    svc, {"folder": root.as_posix()},
                )["up_to_date"])

                malformed.unlink()
                stashbase_daemon.op_delete(svc, {"path": malformed.as_posix()})
                final_status = stashbase_daemon.op_status(svc, {"folder": root.as_posix()})
                self.assertTrue(final_status["up_to_date"])
                self.assertNotIn(malformed.as_posix(), stashbase_daemon.op_list(
                    svc, {"folder": root.as_posix()},
                )["files"])
                final_hits = stashbase_daemon.op_search(svc, {
                    "query": "unfinished", "folder": root.as_posix(),
                    "extensions": [".json"], "top_k": 10,
                })["hits"]
                self.assertFalse(any(hit["path"] == malformed.as_posix() for hit in final_hits))
            finally:
                svc.close_all()

            cleanup = stashbase_daemon.StashbaseStore(str(store_root))
            try:
                cleanup.bind_root(
                    root.as_posix(),
                    "openai",
                    root_identity=root.as_posix(),
                    dimension=3,
                )
                self.assertIsNone(cleanup._embedder)
                stashbase_daemon.op_delete(cleanup, {"path": renamed.as_posix()})
                self.assertNotIn(
                    renamed.as_posix(),
                    stashbase_daemon.op_list(cleanup, {"folder": root.as_posix()})["files"],
                )
            finally:
                cleanup.close_all()

    def test_openrouter_embedder_uses_openai_compatible_endpoint(self) -> None:
        class FakeOpenAIClient:
            def __init__(self, **kwargs):
                fake_openai.last_kwargs = kwargs

        fake_openai = types.SimpleNamespace(
            OpenAI=FakeOpenAIClient,
            APITimeoutError=RuntimeError,
            APIConnectionError=RuntimeError,
            RateLimitError=RuntimeError,
            InternalServerError=RuntimeError,
            last_kwargs=None,
        )
        previous = sys.modules.get("openai")
        sys.modules["openai"] = fake_openai
        try:
            embedder = stashbase_daemon.make_embedder(
                "openrouter",
                api_key="sk-or-v1-test",
            )
        finally:
            if previous is None:
                sys.modules.pop("openai", None)
            else:
                sys.modules["openai"] = previous

        self.assertEqual(embedder.provider, "openrouter")
        self.assertEqual(embedder.model_name, "openai/text-embedding-3-small")
        self.assertEqual(embedder.dimension, 1536)
        self.assertEqual(
            fake_openai.last_kwargs,
            {
                "api_key": "sk-or-v1-test",
                "timeout": 60.0,
                "base_url": "https://openrouter.ai/api/v1",
            },
        )

    def test_local_embedder_builds_via_onnx_provider_without_api_key(self) -> None:
        class FakeOnnxProvider:
            model_name = "gpahal/bge-m3-onnx-int8"
            dimension = 1024
            def embed(self, texts):
                return [[0.0] * self.dimension for _ in texts]
        calls = []
        def fake_get_provider(name, **kwargs):
            calls.append((name, kwargs))
            return FakeOnnxProvider()
        fake_mfs_embedder = types.SimpleNamespace(get_provider=fake_get_provider)
        previous = sys.modules.get("mfs.embedder")
        sys.modules["mfs.embedder"] = fake_mfs_embedder
        try:
            embedder = stashbase_daemon.make_embedder("onnx")
        finally:
            if previous is None:
                sys.modules.pop("mfs.embedder", None)
            else:
                sys.modules["mfs.embedder"] = previous
        self.assertEqual(embedder.provider, "onnx")
        self.assertEqual(embedder.model_name, "gpahal/bge-m3-onnx-int8")
        self.assertEqual(embedder.dimension, 1024)
        self.assertEqual(embedder.embed(["hi"]), [[0.0] * 1024])
        self.assertEqual(calls, [("onnx", {})])

    def test_onnx_embedder_bounds_a_hanging_download_with_a_timeout(self) -> None:
        # Regression test: get_provider("onnx", ...) does real network I/O
        # synchronously, and the daemon processes one request at a time --
        # a hanging call must not freeze it indefinitely. Patches the
        # timeout down to keep this test fast rather than waiting out the
        # real 120s bound.
        def hanging_get_provider(name, **kwargs):
            time.sleep(5)
            raise AssertionError("should have timed out before returning")
        fake_mfs_embedder = types.SimpleNamespace(get_provider=hanging_get_provider)
        previous = sys.modules.get("mfs.embedder")
        sys.modules["mfs.embedder"] = fake_mfs_embedder
        try:
            with mock.patch.object(stashbase_daemon._OnnxEmbedder, "_INIT_TIMEOUT_SECONDS", 0.2):
                start = time.monotonic()
                with self.assertRaises(RuntimeError) as ctx:
                    stashbase_daemon.make_embedder("onnx")
                elapsed = time.monotonic() - start
            self.assertLess(elapsed, 2.0, "should fail near the timeout bound, not hang")
            self.assertIn("did not become ready within", str(ctx.exception))
        finally:
            if previous is None:
                sys.modules.pop("mfs.embedder", None)
            else:
                sys.modules["mfs.embedder"] = previous

    def test_probe_embedder_reports_local_runtime_without_opening_a_store(self) -> None:
        embedder = types.SimpleNamespace(
            provider="onnx",
            model_name="gpahal/bge-m3-onnx-int8",
            dimension=1024,
        )
        svc = mock.Mock()
        with mock.patch.object(stashbase_daemon, "make_embedder", return_value=embedder) as make:
            result = stashbase_daemon.op_probe_embedder(svc, {
                "provider": "onnx",
                "model": "gpahal/bge-m3-onnx-int8",
                "dimension": 1024,
            })
        self.assertEqual(result, {
            "provider": "onnx",
            "model": "gpahal/bge-m3-onnx-int8",
            "dimension": 1024,
        })
        make.assert_called_once_with(
            "onnx",
            model="gpahal/bge-m3-onnx-int8",
            api_key=None,
            dimension=1024,
            base_url=None,
        )
        svc.assert_not_called()

    def test_collection_name_separates_local_from_openai_at_same_dimension(self) -> None:
        self.assertEqual(stashbase_daemon._collection_name(1536), "vectors_openai_1536")
        self.assertEqual(stashbase_daemon._collection_name(1536, "openai"), "vectors_openai_1536")
        self.assertEqual(stashbase_daemon._collection_name(1536, "openrouter"), "vectors_openai_1536")
        self.assertEqual(stashbase_daemon._collection_name(1536, "stashbase"), "vectors_openai_1536")
        self.assertEqual(stashbase_daemon._collection_name(1536, "onnx"), "vectors_onnx_1536")
        self.assertNotEqual(
            stashbase_daemon._collection_name(1536, "openai"),
            stashbase_daemon._collection_name(1536, "onnx"),
        )

    def test_no_key_local_bind_still_builds_an_embedder(self) -> None:
        # Unlike other providers, "onnx" needs no API key to build an
        # embedder — the no-key branch that only reopens an existing store
        # for other providers must not swallow a local bind.
        class FakeOnnxProvider:
            model_name = "m"
            dimension = 8
            def embed(self, texts):
                return []
        fake_mfs_embedder = types.SimpleNamespace(get_provider=lambda name, **kw: FakeOnnxProvider())
        previous = sys.modules.get("mfs.embedder")
        sys.modules["mfs.embedder"] = fake_mfs_embedder
        try:
            with tempfile.TemporaryDirectory() as tmp:
                svc = stashbase_daemon.StashbaseStore(tmp)
                with mock.patch.object(svc, "_ensure_store") as ensure:
                    svc.bind_root("/library", "onnx", root_identity="/library")
                ensure.assert_called_once()
                built_embedder = ensure.call_args[0][0]
                self.assertEqual(built_embedder.provider, "onnx")
        finally:
            if previous is None:
                sys.modules.pop("mfs.embedder", None)
            else:
                sys.modules["mfs.embedder"] = previous

    def _fake_openai_module(self):
        class FakeEmbeddingsResp:
            def __init__(self, n):
                self.data = [types.SimpleNamespace(embedding=[0.1] * 1536) for _ in range(n)]
        class FakeEmbeddings:
            def create(self, model, input, **kw):
                return FakeEmbeddingsResp(len(input))
        class FakeOpenAIClient:
            def __init__(self, **kwargs):
                self.embeddings = FakeEmbeddings()
        return types.SimpleNamespace(
            OpenAI=FakeOpenAIClient,
            APITimeoutError=RuntimeError,
            APIConnectionError=RuntimeError,
            RateLimitError=RuntimeError,
            InternalServerError=RuntimeError,
        )

    def _fake_mfs_embedder_module(self):
        class FakeOnnxProvider:
            model_name = "gpahal/bge-m3-onnx-int8"
            dimension = 1024
            def embed(self, texts):
                return [[0.0] * self.dimension for _ in texts]
        return types.SimpleNamespace(get_provider=lambda name, **kw: FakeOnnxProvider())

    def test_local_bind_after_no_key_reopen_switches_collection_not_attaches(self) -> None:
        # Regression test: a no-key reopen (leaving _embedder at None) used
        # to let a following local bind attach without ever rechecking
        # collection identity, silently landing local vectors in the
        # OpenAI collection whenever dimensions happened to match.
        try:
            import milvus_lite  # noqa: F401
        except ImportError:
            self.skipTest("milvus_lite is not installed")
        previous_openai = sys.modules.get("openai")
        sys.modules["openai"] = self._fake_openai_module()
        previous_mfs = sys.modules.get("mfs.embedder")
        sys.modules["mfs.embedder"] = self._fake_mfs_embedder_module()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                setup = stashbase_daemon.StashbaseStore(tmp)
                try:
                    setup.bind_root("/library", "openai", root_identity="/library", api_key="sk-fake-test-key")
                finally:
                    setup.close_all()

                svc = stashbase_daemon.StashbaseStore(tmp)
                try:
                    svc.bind_root("/library", "openai", root_identity="/library", dimension=1536)
                    self.assertIsNone(svc._embedder)

                    svc.bind_root("/library", "onnx", root_identity="/library")
                    self.assertEqual(svc._embedder.provider, "onnx")
                    collection = getattr(getattr(svc._store, "_config", None), "collection_name", None)
                    self.assertEqual(collection, "vectors_onnx_1024")
                finally:
                    svc.close_all()
        finally:
            if previous_openai is None:
                sys.modules.pop("openai", None)
            else:
                sys.modules["openai"] = previous_openai
            if previous_mfs is None:
                sys.modules.pop("mfs.embedder", None)
            else:
                sys.modules["mfs.embedder"] = previous_mfs

    def test_no_key_reopen_discovers_the_real_local_collection(self) -> None:
        # Regression test: a credential-less reopen used to always default
        # to the OpenAI collection name, silently opening a different,
        # empty collection for a library indexed with the local provider --
        # list/delete would report zero rows while the real ones sat
        # orphaned in the actual collection.
        try:
            import milvus_lite  # noqa: F401
        except ImportError:
            self.skipTest("milvus_lite is not installed")
        previous_mfs = sys.modules.get("mfs.embedder")
        sys.modules["mfs.embedder"] = self._fake_mfs_embedder_module()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                setup = stashbase_daemon.StashbaseStore(tmp)
                try:
                    setup.bind_root("/library", "onnx", root_identity="/library")
                finally:
                    setup.close_all()

                cleanup = stashbase_daemon.StashbaseStore(tmp)
                try:
                    cleanup.bind_root("/library", "openai", root_identity="/library", dimension=1536)
                    collection = getattr(getattr(cleanup._store, "_config", None), "collection_name", None)
                    self.assertEqual(collection, "vectors_onnx_1024")
                finally:
                    cleanup.close_all()
        finally:
            if previous_mfs is None:
                sys.modules.pop("mfs.embedder", None)
            else:
                sys.modules["mfs.embedder"] = previous_mfs

    def test_no_key_reopen_uses_the_active_provider_when_multiple_collections_exist(self) -> None:
        # Node persists the active embedding source and sends its provider and
        # dimension on every bind. When historical collections coexist, that
        # hint is the durable selection -- cleanup must reopen it rather than
        # guessing or refusing all list/delete work.
        try:
            import milvus_lite  # noqa: F401
        except ImportError:
            self.skipTest("milvus_lite is not installed")
        previous_openai = sys.modules.get("openai")
        sys.modules["openai"] = self._fake_openai_module()
        previous_mfs = sys.modules.get("mfs.embedder")
        sys.modules["mfs.embedder"] = self._fake_mfs_embedder_module()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                setup1 = stashbase_daemon.StashbaseStore(tmp)
                try:
                    setup1.bind_root("/library", "openai", root_identity="/library", api_key="sk-fake-test-key")
                finally:
                    setup1.close_all()

                setup2 = stashbase_daemon.StashbaseStore(tmp)
                try:
                    setup2.bind_root("/library", "onnx", root_identity="/library")
                finally:
                    setup2.close_all()

                cleanup = stashbase_daemon.StashbaseStore(tmp)
                try:
                    cleanup.bind_root("/library", "openai", root_identity="/library", dimension=1536)
                    collection = getattr(getattr(cleanup._store, "_config", None), "collection_name", None)
                    self.assertEqual(collection, "vectors_openai_1536")
                finally:
                    cleanup.close_all()

                local_cleanup = stashbase_daemon.StashbaseStore(tmp)
                try:
                    local_cleanup._ensure_store_for_dimension(1024, provider="onnx")
                    collection = getattr(getattr(local_cleanup._store, "_config", None), "collection_name", None)
                    self.assertEqual(collection, "vectors_onnx_1024")
                    stores = local_cleanup.mutation_stores()
                    self.assertEqual(
                        {getattr(store._config, "collection_name", None) for _, _, store in stores},
                        {"vectors_openai_1536", "vectors_onnx_1024"},
                    )
                    for _, _, store in stores:
                        store.delete_by_prefix = mock.Mock(wraps=store.delete_by_prefix)
                    stashbase_daemon.op_delete_prefix(local_cleanup, {"prefix": "/library"})
                    for _, _, store in stores:
                        store.delete_by_prefix.assert_called_once_with("/library/")
                finally:
                    local_cleanup.close_all()
        finally:
            if previous_openai is None:
                sys.modules.pop("openai", None)
            else:
                sys.modules["openai"] = previous_openai
            if previous_mfs is None:
                sys.modules.pop("mfs.embedder", None)
            else:
                sys.modules["mfs.embedder"] = previous_mfs

    def test_stashbase_embedder_marks_query_purpose_for_loopback_broker(self) -> None:
        captured = {}

        class FakeEmbeddings:
            def create(self, **kwargs):
                captured.update(kwargs)
                return types.SimpleNamespace(data=[types.SimpleNamespace(embedding=[1.0, 0.0])])

        class FakeOpenAIClient:
            def __init__(self, **kwargs):
                captured["client"] = kwargs
                self.embeddings = FakeEmbeddings()

        fake_openai = types.SimpleNamespace(
            OpenAI=FakeOpenAIClient,
            APITimeoutError=type("APITimeoutError", (Exception,), {}),
            APIConnectionError=type("APIConnectionError", (Exception,), {}),
            RateLimitError=type("RateLimitError", (Exception,), {}),
            InternalServerError=type("InternalServerError", (Exception,), {}),
        )
        previous = sys.modules.get("openai")
        sys.modules["openai"] = fake_openai
        try:
            embedder = stashbase_daemon.make_embedder(
                "stashbase",
                api_key="loopback-secret",
                base_url="http://127.0.0.1:1234/v1",
            )
            self.assertEqual(embedder.embed(["query"], purpose="query"), [[1.0, 0.0]])
        finally:
            if previous is None:
                sys.modules.pop("openai", None)
            else:
                sys.modules["openai"] = previous

        self.assertEqual(captured["client"]["api_key"], "loopback-secret")
        self.assertEqual(captured["extra_headers"], {"X-StashBase-Purpose": "query"})

    def test_index_listing_pages_past_1000_rows_without_primary_key_order(self) -> None:
        try:
            import milvus_lite  # noqa: F401
        except ImportError:
            self.skipTest("milvus_lite is not installed")

        from milvus_lite.engine.collection import Collection
        from milvus_lite.storage import manifest as manifest_module
        from mfs.store import ChunkRecord

        class FakeEmbedder:
            dimension = 3
            model_name = "test-embedder"

            def embed(self, texts):  # noqa: ANN001
                return [[float(len(text)), 1.0, 0.0] for text in texts]

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "library"
            store_root = Path(tmp) / "store"
            root.mkdir()
            # The Node -> Python protocol retains absolute POSIX spelling on
            # every platform, independently of the native Path used for I/O.
            root_source = root.as_posix()
            original_manifest_save = manifest_module.Manifest.save
            # Keep the two flushed segments separate. Their local ordering is
            # valid, but their combined physical ordering is not global PK
            # ordering; that is the real shape that exposed the live bug.
            with mock.patch.object(Collection, "_schedule_bg_maintenance", lambda self: None):
                svc = stashbase_daemon.StashbaseStore(str(store_root))
                try:
                    store = svc._ensure_store(FakeEmbedder())
                    svc.bind_root(root_source, "openai", root_identity=root_source)
                    records = []
                    # The first page ends on the lexicographically greatest id;
                    # the final physical row has a smaller id. A primary-key
                    # cursor therefore loses it when the storage response itself
                    # is not primary-key ordered.
                    physical_ids = [f"{n:04d}" for n in range(1, 1001)] + ["0000"]
                    for chunk_id in physical_ids:
                        note = root / f"note-{chunk_id}.md"
                        content = f"# Note {chunk_id}\n"
                        note.write_text(content, encoding="utf-8")
                        records.append(ChunkRecord(
                            id=chunk_id,
                            source=note.as_posix(),
                            parent_dir=root_source,
                            chunk_index=0,
                            start_line=1,
                            end_line=1,
                            chunk_text=content,
                            dense_vector=[1.0, 0.0, 0.0],
                            content_type="markdown",
                            file_hash=stashbase_daemon.blake3(
                                content.encode("utf-8")
                            ).hexdigest(),
                            is_dir=False,
                            embed_status="complete",
                            metadata={},
                            account_id="",
                        ))
                    store.insert_chunks(records[:1000])
                    stashbase_daemon._flush_store(store)
                    store.insert_chunks(records[1000:])
                    stashbase_daemon._flush_store(store)

                    indexed = store.get_indexed_files(root_source + "/")
                    self.assertEqual(set(indexed), {record.source for record in records})

                    self.assertEqual(
                        stashbase_daemon.op_status(svc, {"folder": root_source})["pending"],
                        [],
                    )

                    svc.close_all(clear_bindings=False)
                    reopened = svc._ensure_store(FakeEmbedder())
                    self.assertIsNot(reopened, store)
                finally:
                    svc.close_all()
                    manifest_module.Manifest.save = original_manifest_save

    def test_close_all_releases_shared_milvus_lite_resources(self) -> None:
        try:
            from milvus_lite.server_manager import server_manager_instance
            from pymilvus.client.connection_manager import ConnectionManager
        except ImportError:
            self.skipTest("milvus_lite is not installed")

        store = mock.Mock()
        connection_manager = mock.Mock()
        with tempfile.TemporaryDirectory() as tmp:
            svc = stashbase_daemon.StashbaseStore(tmp)
            svc._store = store

            with (
                mock.patch.object(
                    ConnectionManager,
                    "get_instance",
                    return_value=connection_manager,
                ),
                mock.patch.object(
                    server_manager_instance,
                    "release_server",
                ) as release_server,
            ):
                svc.close_all()

            store.close.assert_called_once_with()
            connection_manager.close_all.assert_called_once_with()
            release_server.assert_called_once_with(str(svc._db_path))

    def test_no_key_bind_reopens_an_existing_store_for_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            svc = stashbase_daemon.StashbaseStore(tmp)
            svc._db_path.touch()
            with mock.patch.object(svc, "_ensure_store_for_dimension") as ensure:
                svc.bind_root(
                    "/library",
                    "openai",
                    root_identity="/library",
                    dimension=1536,
                )
            ensure.assert_called_once_with(1536, provider="openai")

    def test_delete_acknowledgements_propagate_store_failures(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            svc = stashbase_daemon.StashbaseStore(tmp)
            store = mock.Mock()
            store.delete_by_source.side_effect = RuntimeError("delete failed")
            store.delete_by_prefix.side_effect = RuntimeError("prefix delete failed")
            svc._store = store
            svc._dim = 1536
            with self.assertRaisesRegex(RuntimeError, "delete failed"):
                stashbase_daemon.op_delete(svc, {"path": "/library/note.md"})
            with self.assertRaisesRegex(RuntimeError, "prefix delete failed"):
                stashbase_daemon.op_delete_prefix(svc, {"prefix": "/library/folder"})

    def test_filesystem_roots_keep_root_semantics(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            posix = stashbase_daemon.StashbaseStore(tmp)
            self.assertEqual(
                posix.bind_root("/", "openai", root_identity="/")["root"],
                "/",
            )
            self.assertEqual(
                posix.root_for_path(
                    "/Folder/File.md",
                    path_identity="/Folder/File.md",
                ),
                "/",
            )
            self.assertEqual(
                stashbase_daemon._join_source_path("/", "Folder/File.md"),
                "/Folder/File.md",
            )
            self.assertEqual(stashbase_daemon._source_child_prefix("/"), "/")

        with tempfile.TemporaryDirectory() as tmp:
            windows = stashbase_daemon.StashbaseStore(tmp)
            self.assertEqual(
                windows.bind_root("C:/", "openai", root_identity="c:/")["root"],
                "C:/",
            )
            self.assertEqual(
                windows.root_for_path(
                    "c:/Folder/File.md",
                    path_identity="c:/folder/file.md",
                ),
                "C:/",
            )
            self.assertEqual(windows.bound_roots(), ["C:/"])
            self.assertEqual(
                stashbase_daemon._join_source_path("C:/", "Folder/File.md"),
                "C:/Folder/File.md",
            )
            self.assertEqual(stashbase_daemon._source_child_prefix("C:/"), "C:/")
            self.assertEqual(
                stashbase_daemon._source_parent("C:/Folder/File.md"),
                "C:/Folder",
            )
            self.assertEqual(
                stashbase_daemon._relative_source_path(
                    "C:/Folder/", "C:/Folder/Nested/File.md"
                ),
                "Nested/File.md",
            )
            self.assertEqual(
                stashbase_daemon._norm_root("//Server/Share"),
                "//Server/Share/",
            )
            self.assertEqual(
                windows.bind_root(
                    "//Server/Share",
                    "openai",
                    root_identity="//server/share/",
                )["root"],
                "//Server/Share/",
            )
            self.assertEqual(
                windows.root_for_path(
                    "//server/share/Folder/File.md",
                    path_identity="//server/share/folder/file.md",
                ),
                "//Server/Share/",
            )

    def test_windows_binding_identity_retains_first_source_spelling(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = stashbase_daemon.StashbaseStore(tmp)
            identity = "c:/users/alice"
            first = store.bind_root(
                "C:/Users/Alice",
                "openai",
                root_identity=identity,
            )
            second = store.bind_root(
                "c:/users/ALICE",
                "openai",
                root_identity=identity,
            )

            self.assertEqual(first["root"], "C:/Users/Alice")
            self.assertEqual(second["root"], "C:/Users/Alice")
            self.assertEqual(store.bound_roots(), ["C:/Users/Alice"])
            self.assertEqual(
                store.root_for_path(
                    "c:/USERS/alice/Folder/File.md",
                    path_identity="c:/users/alice/folder/file.md",
                ),
                "C:/Users/Alice",
            )
            self.assertTrue(
                store.unbind_root(
                    "c:/users/alice",
                    root_identity=identity,
                )["was_bound"],
            )
            self.assertEqual(store.bound_roots(), [])

    def test_python_treats_node_identity_as_opaque(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = stashbase_daemon.StashbaseStore(tmp)
            store.bind_root(
                "C:/Straße",
                "openai",
                root_identity="node-key-1",
            )
            store.bind_root(
                "C:/Strasse",
                "openai",
                root_identity="node-key-2",
            )

            self.assertEqual(store.bound_roots(), ["C:/Strasse", "C:/Straße"])

    def test_reconcile_source_uses_node_selected_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = stashbase_daemon.StashbaseStore(tmp)
            store._store = object()
            store._embedder = object()
            store._dim = 1536
            moves = []
            original_rename = stashbase_daemon._try_rename_without_reembed
            stashbase_daemon._try_rename_without_reembed = (
                lambda _svc, old, new, file_hash: moves.append((old, new, file_hash)) or 1
            )
            try:
                result = stashbase_daemon.op_reconcile_source(store, {
                    "old": "C:/Users/Alice/Docs/File.md",
                    "new": "c:/users/alice/Docs/File.md",
                    "file_hash": "hash-1",
                })
            finally:
                stashbase_daemon._try_rename_without_reembed = original_rename

            self.assertTrue(result["reused"])
            self.assertEqual(
                moves,
                [(
                    "C:/Users/Alice/Docs/File.md",
                    "c:/users/alice/Docs/File.md",
                    "hash-1",
                )],
            )

    def test_reconcile_source_drops_stale_rows_when_vectors_are_not_reusable(self) -> None:
        class FakeStore:
            def __init__(self) -> None:
                self.deleted = []

            def delete_by_source(self, source):  # noqa: ANN001
                self.deleted.append(source)

        with tempfile.TemporaryDirectory() as tmp:
            store = stashbase_daemon.StashbaseStore(tmp)
            fake = FakeStore()
            store._store = fake
            store._embedder = object()
            store._dim = 1536
            original_rename = stashbase_daemon._try_rename_without_reembed
            stashbase_daemon._try_rename_without_reembed = (
                lambda _svc, _old, _new, _file_hash: None
            )
            try:
                result = stashbase_daemon.op_reconcile_source(store, {
                    "old": "C:/Users/Alice/Docs/File.md",
                    "new": "c:/users/alice/Docs/File.md",
                    "file_hash": "hash-1",
                })
            finally:
                stashbase_daemon._try_rename_without_reembed = original_rename

            self.assertFalse(result["reused"])
            self.assertEqual(fake.deleted, ["C:/Users/Alice/Docs/File.md"])

    def test_search_filters_extensions_before_top_k(self) -> None:
        hit = lambda source: types.SimpleNamespace(
            is_dir=False, source=source, chunk_index=0, chunk_text="t",
            start_line=1, end_line=2, content_type="text", score=1.0, metadata={},
        )
        requested = []

        class FakeStore:
            def is_empty(self):
                return False

            def hybrid_search(self, _qvec, _query, path_filter, top_k):  # noqa: ANN001
                requested.append(top_k)
                return [
                    hit("/lib/a.md"), hit("/lib/b.pdf"), hit("/lib/c.md"),
                    hit("/lib/d.PDF"), hit("/lib/e.docx"), hit("/lib/f.pdf"),
                    hit("/lib/data.JSON"),
                ]

        class FakeEmbedder:
            def embed(self, texts):  # noqa: ANN001
                return [[0.0] for _ in texts]

        with tempfile.TemporaryDirectory() as tmp:
            svc = stashbase_daemon.StashbaseStore(tmp)
            svc.stores = lambda: [(None, FakeEmbedder(), FakeStore())]

            filtered = stashbase_daemon.op_search(svc, {
                "query": "q", "top_k": 2, "extensions": [".pdf"],
            })
            self.assertEqual(
                [h["path"] for h in filtered["hits"]],
                ["/lib/b.pdf", "/lib/d.PDF"],
            )

            unfiltered = stashbase_daemon.op_search(svc, {"query": "q", "top_k": 2})
            self.assertEqual(len(unfiltered["hits"]), 2)

            data = stashbase_daemon.op_search(svc, {
                "query": "q", "top_k": 2, "extensions": [".json"],
            })
            self.assertEqual([h["path"] for h in data["hits"]], ["/lib/data.JSON"])

            # Filtered call over-fetches; unfiltered keeps the caller's k.
            self.assertEqual(requested, [50, 2, 50])

    def test_search_filters_legacy_derived_rows_by_visible_source_type(self) -> None:
        hit = lambda source: types.SimpleNamespace(
            is_dir=False, source=source, chunk_index=0, chunk_text="t",
            start_line=1, end_line=2, content_type="text", score=1.0, metadata={},
        )

        class FakeStore:
            def __init__(self, hits) -> None:  # noqa: ANN001
                self.hits = hits

            def is_empty(self):
                return False

            def hybrid_search(self, _qvec, _query, path_filter, top_k):  # noqa: ANN001
                return self.hits[:top_k]

        class FakeEmbedder:
            def embed(self, texts):  # noqa: ANN001
                return [[0.0] for _ in texts]

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "paper.pdf"
            legacy = root / ".paper.pdf.md"
            image_source = root / "scan.png"
            extensionless_legacy = root / ".scan.md"
            docx_source = root / "report.docx"
            hidden_note = root / ".report.md"
            note = root / "note.md"
            source.write_text("pdf", encoding="utf-8")
            legacy.write_text("legacy derived text", encoding="utf-8")
            image_source.write_text("image", encoding="utf-8")
            extensionless_legacy.write_text(
                "extensionless legacy text", encoding="utf-8",
            )
            docx_source.write_text("docx", encoding="utf-8")
            hidden_note.write_text("user hidden note", encoding="utf-8")
            note.write_text("ordinary note", encoding="utf-8")

            svc = stashbase_daemon.StashbaseStore(tmp)
            svc.stores = lambda: [(
                None,
                FakeEmbedder(),
                FakeStore([
                    hit(legacy.as_posix()),
                    hit(extensionless_legacy.as_posix()),
                    hit(hidden_note.as_posix()),
                    hit(note.as_posix()),
                ]),
            )]

            pdf = stashbase_daemon.op_search(svc, {
                "query": "q", "top_k": 10, "extensions": [".pdf"],
            })
            self.assertEqual([h["path"] for h in pdf["hits"]], [legacy.as_posix()])

            images = stashbase_daemon.op_search(svc, {
                "query": "q", "top_k": 10, "extensions": [".png"],
            })
            self.assertEqual(
                [h["path"] for h in images["hits"]],
                [extensionless_legacy.as_posix()],
            )

            notes = stashbase_daemon.op_search(svc, {
                "query": "q", "top_k": 10, "extensions": [".md"],
            })
            self.assertEqual(
                [h["path"] for h in notes["hits"]],
                [hidden_note.as_posix(), note.as_posix()],
            )

    def test_search_extension_filter_normalizes_suffixes(self) -> None:
        f = stashbase_daemon._search_extension_filter
        self.assertEqual(f([".md", ".PDF"]), (".md", ".pdf"))
        self.assertIsNone(f(None))
        self.assertIsNone(f([]))
        self.assertIsNone(f("not-a-list"))
        self.assertIsNone(f(["md", ".", 42]))
        self.assertEqual(f(["md", ".docx"]), (".docx",))

    def test_termination_signals_skip_missing_sighup(self) -> None:
        fake_signal = types.SimpleNamespace(SIGTERM=15, SIGINT=2)

        self.assertEqual(
            stashbase_daemon._termination_signals(fake_signal),
            (15, 2),
        )

    def test_termination_signals_include_sighup_when_available(self) -> None:
        fake_signal = types.SimpleNamespace(SIGTERM=15, SIGINT=2, SIGHUP=1)

        self.assertEqual(
            stashbase_daemon._termination_signals(fake_signal),
            (15, 2, 1),
        )

    def test_milvus_manifest_patch_supports_legacy_and_fixed_upstream(self) -> None:
        try:
            from milvus_lite.storage import manifest as manifest_module
        except ImportError:
            self.skipTest("milvus_lite is not installed")

        installed_save = manifest_module.Manifest.save
        original_save = getattr(installed_save, "__stashbase_original__", installed_save)
        original_rename = manifest_module.os.rename
        manifest_module.Manifest.save = original_save
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = manifest_module.Manifest(str(root))
            manifest.save()

            def windows_rename(src, dst):  # noqa: ANN001
                if Path(dst).exists():
                    raise FileExistsError(
                        183,
                        "Cannot create a file when that file already exists",
                        str(src),
                        str(dst),
                    )
                return original_rename(src, dst)

            manifest_module.os.rename = windows_rename
            try:
                save_names = set(
                    getattr(getattr(original_save, "__code__", None), "co_names", ())
                )
                if "rename" in save_names and "replace" not in save_names:
                    with self.assertRaises(FileExistsError):
                        manifest.save()
                else:
                    # Milvus Lite 3.1+ already uses os.replace, so the
                    # simulated Windows rename failure is never reached.
                    manifest.save()

                self.assertTrue(
                    stashbase_daemon._patch_milvus_manifest_windows_replace(force=True)
                )
                expected_version = manifest._version + 1
                manifest.save()

                payload = json.loads(
                    (root / "manifest.json").read_text(encoding="utf-8")
                )
                self.assertEqual(payload["version"], expected_version)
                self.assertEqual(manifest._version, expected_version)
            finally:
                manifest_module.os.rename = original_rename
                manifest_module.Manifest.save = installed_save


if __name__ == "__main__":
    unittest.main()
