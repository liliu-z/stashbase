import contextlib
import importlib
import io
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

with contextlib.redirect_stdout(io.StringIO()):
    stashbase_daemon = importlib.import_module("stashbase_daemon")


class StashbaseDaemonTests(unittest.TestCase):
    def test_index_listing_pages_past_1000_rows_without_primary_key_order(self) -> None:
        try:
            import milvus_lite  # noqa: F401
        except ImportError:
            self.skipTest("milvus_lite is not installed")

        from milvus_lite.engine.collection import Collection
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
            root_source = str(root)
            # Keep the two flushed segments separate. Their local ordering is
            # valid, but their combined physical ordering is not global PK
            # ordering; that is the real shape that exposed the live bug.
            with mock.patch.object(Collection, "_schedule_bg_maintenance", lambda self: None):
                svc = stashbase_daemon.StashbaseStore(str(store_root))
                store = svc._ensure_store(FakeEmbedder())
                svc.bind_root(root_source, "openai", root_identity=root_source)
                try:
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
                            source=str(note),
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
                finally:
                    svc.close_all()

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

            # Filtered call over-fetches; unfiltered keeps the caller's k.
            self.assertEqual(requested, [50, 2])

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

    def test_milvus_manifest_patch_overwrites_existing_target(self) -> None:
        try:
            from milvus_lite.storage import manifest as manifest_module
        except ImportError:
            self.skipTest("milvus_lite is not installed")

        original_save = manifest_module.Manifest.save
        original_rename = manifest_module.os.rename
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
                with self.assertRaises(FileExistsError):
                    manifest.save()

                self.assertTrue(
                    stashbase_daemon._patch_milvus_manifest_windows_replace(force=True)
                )
                manifest.save()

                payload = json.loads(
                    (root / "manifest.json").read_text(encoding="utf-8")
                )
                self.assertEqual(payload["version"], 2)
                self.assertEqual(manifest._version, 2)
            finally:
                manifest_module.os.rename = original_rename
                manifest_module.Manifest.save = original_save


if __name__ == "__main__":
    unittest.main()
