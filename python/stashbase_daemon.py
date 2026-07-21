"""StashBase sidecar daemon.

Owns the **single** per-machine, app-data Milvus Lite DB for the whole
app with **one** collection (``vectors_openai_1536``). V1 ships a single
fixed embedder (OpenAI), so the whole library lives in that one collection
— there's no embedder switching, no per-provider collection pool, and no
active/archive distinction. Each opened **folder** (an absolute path
anywhere on disk) is **bound** so the daemon knows it exists; all folders
share the collection and are distinguished by their absolute-path prefix.

The Node side (server/mfs-daemon.ts) spawns this script once and talks
to it over stdin/stdout in line-delimited JSON.

Protocol
--------
Each request is one JSON object on a single stdin line:

    {"id": 7, "op": "<name>", "args": {...}}

Each response is one JSON object on a single stdout line:

    {"id": 7, "ok": true,  "result": ...}
    {"id": 7, "ok": false, "error": "..."}

The daemon also emits unsolicited progress events
(``{"event": "ready" | "starting" | "error", ...}``) — Node treats
events as informational and matches results back to requests by ``id``.

Supported ops
-------------
For wire-compatibility the bind/scope arg is still named ``folder``, but it
now carries an **absolute folder root** (the value changed; the key kept its
name to keep the protocol surface small).

- ``bind_folder {folder, provider, api_key?, model?, dimension?}``
                        — register that the folder root ``folder`` exists.
                          The first bind carrying an ``api_key`` builds the
                          embedder + collection; later binds reuse them.
                          Idempotent; safe to call after a daemon respawn.
- ``unbind_folder {folder}``
                        — forget the folder root ``folder``. Existing rows
                          stay; the root can be re-bound later.
- ``upsert {path, content, ext, file_hash?}``
                        — chunk + embed + insert/replace one file.
                          ``path`` is an **absolute POSIX path** (e.g.
                          ``/Users/me/notes/lecture-01.md``); it must live
                          under a bound root.
- ``delete {path}``     — drop rows for one file.
- ``delete_prefix {prefix}``
                        — drop rows for files under a folder.
- ``rename {old, new, content, ext, file_hash}``
                        — move a file's rows (fast-path reuses vectors
                          when the hash matches; else re-embed).
- ``rename_prefix {old, new, files}``
                        — folder rename: bulk version.
- ``search {query, folder?, top_k}``
                        — hybrid search (dense + BM25 + RRF) in the
                          collection, optionally scoped to one folder root
                          via a ``source like "<root>/%"`` filter.
- ``status {folder?}``   — name-only diff of disk vs index. ``folder``
                          omitted means every bound root.
- ``scan_diff {folder?}`` — content-hash diff. ``folder`` omitted = every
                          bound root.
- ``list {folder?}``     — ``{path: file_hash}`` of every indexed file.
                          Scoped by root prefix when given.
- ``close_store``       — release Milvus Lite's flock so the server can
                          delete or move the DB file.
- ``set_rules {excluded_dirs?, max_indexable_bytes?, include_extensions?}``
                        — receive indexing rules from Node (single source
                          of truth there); built-in constants are only the
                          fallback for an old Node. Echoes effective rules.

Paths
-----
``path`` / ``prefix`` / ``old`` / ``new`` in every op are **absolute
POSIX-spelled paths** (``/Users/me/notes/lecture-01.md`` or
``C:/Users/me/notes/lecture-01.md``). The daemon matches each to the bound
folder root that is its longest identity prefix. Node owns platform/Unicode
identity and sends opaque comparison keys while Python retains the first bound
source spelling. The Node side normalizes every daemon crossing through its
filesystem-path seam.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
import time
import traceback
from collections import defaultdict
from pathlib import Path
from typing import Any

# Content + chunk-id hashing. BLAKE3 is ~3-5x SHA256 and streaming-friendly
# — matters for reconcile over large PDFs / videos. The Node side
# (indexer.mfs.ts) and mfs's Scanner (patched below) must use the SAME
# algorithm, or scan_diff would see every file as modified.
from blake3 import blake3

# Defer all heavy imports until after stdout is unbuffered + greeting
# is printed, so the Node side can tell quickly whether Python even
# launched.
print(json.dumps({"event": "starting", "pid": os.getpid()}), flush=True)


# ---------------------------------------------------------------- embedder
#
# V1 ships a single embedder: OpenAI `text-embedding-3-small` (1536d).
# There is no embedder switching and no local fallback — the whole library
# uses one collection. Built lazily on the first bind that carries an
# API key; the daemon may have zero embedders loaded at idle.

def make_embedder(provider: str = "openai", *, model=None, api_key=None, dimension=None):
    """Build the OpenAI embedding provider satisfying MFS's protocol
    (`.embed(texts) -> list[list[float]]`, `.dimension`, `.model_name`).

    Rolled in-house — see `_OpenAIEmbedder`. ``provider`` is accepted for
    protocol compatibility but must be ``openai`` (V1 has no other).
    """
    if provider != "openai":
        raise ValueError(f"unsupported embedder provider {provider!r}; V1 is openai-only")
    if not api_key:
        raise ValueError("openai embedder requires api_key")
    return _OpenAIEmbedder(
        model=model or "text-embedding-3-small",
        api_key=api_key,
        dimension=dimension,
    )


class _OpenAIEmbedder:
    """OpenAI embedding provider, rolled in-house.

    Rolled separately from `mfs.embedder.get_provider('openai')` so we can
    (a) cap the OpenAI client timeout at 60s instead of the SDK default
    of 10 minutes, and (b) wrap retries around transient errors without
    monkey-patching MFS internals.

    Satisfies MFS's `EmbeddingProvider` protocol: `.embed(texts)`,
    `.dimension`, `.model_name`.
    """

    _NATIVE_DIMS = {
        "text-embedding-3-small": 1536,
        "text-embedding-3-large": 3072,
        "text-embedding-ada-002": 1536,
    }

    # OpenAI's embedding endpoint enforces a request-level token ceiling
    # (300k for text-embedding-3* at time of writing). Keep a margin and
    # batch locally so one big folder cannot take the daemon down.
    _MAX_REQUEST_TOKENS = 250_000
    _MAX_BATCH_ITEMS = 128

    def __init__(self, *, model: str, api_key: str, dimension: int | None = None,
                 timeout: float = 60.0, max_retries: int = 3, base_delay: float = 1.5) -> None:
        import openai
        self._openai = openai
        self._client = openai.OpenAI(api_key=api_key, timeout=timeout)
        self.model_name = model
        self.dimension = dimension or self._NATIVE_DIMS.get(model, 1536)
        self._max_retries = max(1, max_retries)
        self._base_delay = base_delay

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        out: list[list[float]] = []
        batch: list[str] = []
        batch_tokens = 0
        for text in texts:
            est = self._estimate_tokens(text)
            if est > self._MAX_REQUEST_TOKENS:
                raise ValueError(
                    f"single embedding input is too large "
                    f"(estimated {est:,} tokens > {self._MAX_REQUEST_TOKENS:,})",
                )
            if batch and (
                batch_tokens + est > self._MAX_REQUEST_TOKENS
                or len(batch) >= self._MAX_BATCH_ITEMS
            ):
                out.extend(self._embed_batch(batch))
                batch = []
                batch_tokens = 0
            batch.append(text)
            batch_tokens += est
        if batch:
            out.extend(self._embed_batch(batch))
        return out

    @staticmethod
    def _estimate_tokens(text: str) -> int:
        # Conservative language-agnostic approximation. English averages
        # ~4 chars/token; CJK is denser, so 3 chars/token leaves margin.
        return max(1, (len(text) + 2) // 3)

    def _embed_batch(self, texts: list[str]) -> list[list[float]]:
        transient = (
            self._openai.APITimeoutError,
            self._openai.APIConnectionError,
            self._openai.RateLimitError,
            self._openai.InternalServerError,
        )
        native = self._NATIVE_DIMS.get(self.model_name)
        kwargs: dict = {"model": self.model_name, "input": texts}
        if native is not None and self.dimension != native:
            kwargs["dimensions"] = self.dimension
        last_err: Exception | None = None
        for attempt in range(self._max_retries):
            try:
                resp = self._client.embeddings.create(**kwargs)
                return [d.embedding for d in resp.data]
            except transient as err:
                last_err = err
                if attempt == self._max_retries - 1:
                    raise
                delay = self._base_delay * (2 ** attempt)
                print(
                    f"[stashbase] openai embed attempt {attempt + 1}/{self._max_retries} "
                    f"failed ({type(err).__name__}); retrying in {delay:.1f}s",
                    file=sys.stderr,
                )
                time.sleep(delay)
        raise RuntimeError(f"embed retry loop exhausted: {last_err}")


# ---------------------------------------------------------------- chunking

def _chunk(path_rel: str, content: str, ext: str):
    """Route to MFS's chunker. Returns list of MFS ``Chunk``.

    HTML is fed in as markdown-shaped plaintext by the Node side (see
    ``server/html.ts``), so we always pass ``.md`` to MFS regardless
    of the on-disk extension — the chunker doesn't know HTML and would
    otherwise fall back to dumb char splits.
    """
    from mfs.ingest.chunker import chunk_file
    effective_ext = ".md" if ext in (".html", ".htm") else ext
    return chunk_file(Path(path_rel), content, effective_ext)


# ---------------------------------------------------------------- store

def _patch_inverted_index_skip() -> None:
    """Drop INVERTED scalar indexes that Milvus Lite refuses.

    MFS adds INVERTED indexes on ``source`` / ``parent_dir`` /
    ``content_type`` / ``is_dir``. Recent pymilvus + Milvus Lite reject
    ``add_index`` calls without ``metric_type``; INVERTED is a scalar
    index with no meaningful metric, so we monkey-patch ``add_index`` to
    swallow them. Affected fields fall back to table-scan filtering,
    which on a single-user library is comfortably under 10ms. Idempotent —
    flagged via a sentinel attribute on the patched function.
    """
    try:
        from pymilvus.milvus_client.index import IndexParams  # type: ignore
    except ImportError:
        return
    if getattr(IndexParams.add_index, "__stashbase_patched__", False):
        return
    original = IndexParams.add_index

    def _add_index(self, field_name, index_type=None, index_name="", **kwargs):
        if index_type == "INVERTED" and not kwargs.get("metric_type"):
            return self
        return original(self, field_name=field_name, index_type=index_type,
                        index_name=index_name, **kwargs)

    _add_index.__stashbase_patched__ = True  # type: ignore[attr-defined]
    IndexParams.add_index = _add_index


def _patch_milvus_manifest_windows_replace(*, force: bool = False) -> bool:
    """Make Milvus Lite manifest saves overwrite atomically on Windows.

    Milvus Lite persists collection/index metadata by writing
    ``manifest.json.tmp`` and renaming it over ``manifest.json``. POSIX
    ``rename`` replaces the target, but Windows raises ``FileExistsError``
    when the target already exists. The first collection save can pass and
    the following index save can then fail during ``bind_folder``. Patch the
    upstream method before opening the store so Windows uses ``os.replace``,
    which preserves the intended atomic-overwrite contract.
    """
    if not force and os.name != "nt":
        return False
    try:
        from milvus_lite.storage import manifest as manifest_module  # type: ignore
    except ImportError:
        return False

    Manifest = manifest_module.Manifest
    if getattr(Manifest.save, "__stashbase_windows_replace__", False):
        return True

    def save(self) -> None:  # noqa: ANN001
        manifest_module.os.makedirs(self._data_dir, exist_ok=True)

        new_version = self._version + 1
        payload = self._to_payload()
        payload["version"] = new_version

        target_path = manifest_module.os.path.join(
            self._data_dir,
            manifest_module.MANIFEST_FILENAME,
        )
        prev_path = manifest_module.os.path.join(
            self._data_dir,
            manifest_module.MANIFEST_PREV_FILENAME,
        )
        tmp_path = manifest_module.os.path.join(
            self._data_dir,
            manifest_module.MANIFEST_TMP_FILENAME,
        )

        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                manifest_module.json.dump(
                    payload,
                    f,
                    indent=2,
                    sort_keys=True,
                    ensure_ascii=False,
                )
                f.flush()
                manifest_module.os.fsync(f.fileno())

            if manifest_module.os.path.exists(target_path):
                try:
                    manifest_module.shutil.copy2(target_path, prev_path)
                except OSError as err:
                    manifest_module.logger.warning(
                        "manifest: failed to create .prev backup: %s",
                        err,
                    )

            manifest_module.os.replace(tmp_path, target_path)
        except BaseException:
            try:
                manifest_module.os.remove(tmp_path)
            except OSError:
                pass
            raise

        self._version = new_version

        try:
            dir_fd = manifest_module.os.open(
                self._data_dir,
                manifest_module.os.O_RDONLY,
            )
            try:
                manifest_module.os.fsync(dir_fd)
            finally:
                manifest_module.os.close(dir_fd)
        except OSError:
            pass

    save.__stashbase_windows_replace__ = True  # type: ignore[attr-defined]
    Manifest.save = save
    return True


def _patch_mfs_local_query_snapshot() -> None:
    """Read local Milvus Lite result sets from one storage snapshot.

    MFS's ``_query_all`` uses pymilvus ``query_iterator``, whose cursor is
    the last primary key in each response. That contract assumes every page
    is globally primary-key ordered. The bundled local Milvus Lite adapter
    returns rows in immutable-segment order instead, so a collection with
    more than one 1,000-row page can silently omit later segments whose keys
    sort before the previous page's cursor. Index status then reports stored
    files as pending and reconcile embeds them again.

    Local Milvus Lite supports an unbounded scalar query. Use that single
    snapshot for MFS's collect-all operations; broad callers request only
    narrow bookkeeping fields, while full-row callers are source-scoped.
    Keep MFS's native iterator for remote Milvus URIs.
    """
    try:
        from mfs.store import MilvusStore  # type: ignore
    except ImportError:
        return
    if getattr(MilvusStore._query_all, "__stashbase_local_snapshot__", False):
        return

    original = MilvusStore._query_all

    def _query_all(  # noqa: ANN001
        self, filter_expr, output_fields, batch_size=1000,
    ):
        uri = str(getattr(self._config, "uri", ""))
        if uri.startswith(("http://", "https://", "tcp://", "unix://")):
            return original(self, filter_expr, output_fields, batch_size)
        self.connect()
        return self.client.query(
            collection_name=self._config.collection_name,
            filter=filter_expr,
            output_fields=output_fields,
        )

    _query_all.__stashbase_local_snapshot__ = True  # type: ignore[attr-defined]
    MilvusStore._query_all = _query_all


def _patch_scanner_blake3() -> None:
    """Make MFS's ``Scanner.compute_file_hash`` use BLAKE3, not SHA256.

    ``scan_diff`` compares a stored ``file_hash`` (which the Node side now
    computes with BLAKE3) against ``scanner.compute_file_hash(path)``
    recomputed from disk. The two MUST use the same algorithm or every
    file would forever look "modified". MFS upstream hard-codes SHA256
    (``mfs/ingest/scanner.py``), so we override the method to stream the
    raw bytes through BLAKE3 instead — same 64-hex-char output width, so
    the stored-hash column is unaffected. Idempotent via a sentinel.

    Migration: existing rows carry SHA256 hashes; after this patch the
    next *full* content reconcile (manual ``/api/sync``) sees them as
    mismatched and re-embeds, replacing them with BLAKE3. The boot-time
    name-only sync leaves them untouched, so queries keep working on the
    old vectors until then. See build-map 04-indexing.
    """
    try:
        from mfs.ingest.scanner import Scanner  # type: ignore
    except ImportError:
        return
    if getattr(Scanner.compute_file_hash, "__stashbase_blake3__", False):
        return

    def compute_file_hash(self, path) -> str:  # noqa: ANN001
        h = blake3()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 16), b""):
                h.update(chunk)
        return h.hexdigest()

    compute_file_hash.__stashbase_blake3__ = True  # type: ignore[attr-defined]
    Scanner.compute_file_hash = compute_file_hash


INDEX_EXCLUDED_DIRS = {
    ".cache",
    ".git",
    ".hg",
    ".next",
    ".nuxt",
    ".output",
    ".parcel-cache",
    ".pnpm-store",
    ".stashbase",
    ".svelte-kit",
    ".turbo",
    ".venv",
    ".vite",
    ".yarn",
    "__pycache__",
    "bower_components",
    "build",
    "coverage",
    "DerivedData",
    "dist",
    "node_modules",
    "out",
    "target",
    "vendor",
}
MAX_INDEXABLE_BYTES = 8 * 1024 * 1024

# Mutable copy of the indexing rules. Node is the single source of truth
# for format/admission knowledge (server/indexable.ts, server/format.ts)
# and pushes its values via the `set_rules` op right after every spawn;
# the constants above are only the fallback for an old Node that doesn't
# know the op. Scanners are created fresh per call (_make_scanner), so a
# rules update takes effect on the next scan with no cache invalidation.
_RULES = {
    "excluded_dirs": set(INDEX_EXCLUDED_DIRS),
    "max_indexable_bytes": MAX_INDEXABLE_BYTES,
    "include_extensions": [".html", ".htm"],
}


def op_set_rules(svc: StashbaseStore, args: dict) -> dict:
    """Receive indexing rules from Node (the single source of truth —
    see Data Correctness & Recovery: Reconcile Rules). Only supplied
    keys are updated; the reply echoes the effective rules so Node can
    verify what landed."""
    if isinstance(args.get("excluded_dirs"), list):
        _RULES["excluded_dirs"] = {str(d) for d in args["excluded_dirs"] if d}
    mib = args.get("max_indexable_bytes")
    if isinstance(mib, int) and mib > 0:
        _RULES["max_indexable_bytes"] = mib
    if isinstance(args.get("include_extensions"), list):
        _RULES["include_extensions"] = [
            str(e) for e in args["include_extensions"] if str(e).startswith(".")
        ]
    return {
        "excluded_dirs": sorted(_RULES["excluded_dirs"]),
        "max_indexable_bytes": _RULES["max_indexable_bytes"],
        "include_extensions": _RULES["include_extensions"],
    }


def _collection_name(dim: int) -> str:
    """The single collection's name. Encodes dim so a `text-embedding-3-
    large` (3072) config wouldn't collide with the default small (1536);
    the default keeps the historical `vectors_openai_1536` name so
    already-indexed KBs aren't orphaned."""
    return f"vectors_openai_{dim}"


def _norm_root(root: str) -> str:
    """Normalize an absolute POSIX-spelled source without destroying a
    filesystem root. ``/``, Windows drive roots such as ``C:/``, and UNC
    share roots keep their trailing slash; other paths drop trailing slashes."""
    r = root.rstrip("/")
    if not r:
        return "/"
    if len(r) == 2 and r[0].isalpha() and r[1] == ":" and len(root) > 2:
        return r + "/"
    if r.startswith("//") and len([part for part in r.split("/") if part]) == 2:
        return r + "/"
    return r


def _source_child_prefix(root: str) -> str:
    source = _norm_root(root)
    return source if source.endswith("/") else source + "/"


def _path_identity_contains(root_identity: str, path_identity: str) -> bool:
    prefix = _source_child_prefix(root_identity)
    return path_identity == root_identity or path_identity.startswith(prefix)


def _join_source_path(root: str, relative: str) -> str:
    return root + relative if root.endswith("/") else root + "/" + relative


def _source_parent(source: str) -> str:
    return "/".join(source.split("/")[:-1])


def _relative_source_path(prefix: str, source: str) -> str:
    return source[len(prefix):] if source.startswith(prefix) else source.rsplit("/", 1)[-1]


class StashbaseStore:
    """Holds the global app-data DB and the **single** ``MilvusStore``
    every folder shares. V1 has one fixed embedder (OpenAI), so the whole
    library lives in one collection — no per-provider pool, no active/archive
    distinction.

    Lifecycle:
        1. ``__init__`` records the resolved global ``milvus.db`` path.
           No daemon-side I/O yet.
        2. ``bind_root(root, ...)`` — first bind carrying an API key
           creates the embedder + collection; later binds reuse them and
           just register the folder root. Roots still get bound so the
           "must bind before writing" contract holds and ``scan_diff`` /
           ``status`` know which folders exist.
        3. ``store_for_path(path)`` / ``stores()`` — return the one
           ``(embedder, store)``; raise if nothing's bound yet.

    A daemon respawn loses the bindings; the Node side re-issues
    ``bind_folder`` for every known folder root on reconnect.
    """

    def __init__(self, store_root: str) -> None:
        # ONE global Milvus DB for the whole app, in per-machine app-data
        # (`--store-root`). Folders register absolute roots; every folder
        # shares this single collection, scoped by absolute-path prefix.
        # `store_root` uses a `.nosync` suffix upstream so iCloud skips the
        # WAL `.arrow` files (corrupting them would break the collection).
        store_parent = Path(store_root).expanduser().resolve()
        self._db_path: Path = store_parent / "milvus.db"
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        # The one embedder + store, created on the first bind with a key.
        self._embedder: Any = None
        self._store: Any = None
        self._dim: int = 0
        # Opaque Node-generated comparison identity -> retained source spelling.
        # Node's filesystem-path module is the single identity owner; Python
        # never repeats Unicode/platform case mapping with a drifting runtime.
        self._bound: dict[str, str] = {}

    def _ensure_store(self, embedder):
        """Open the single Milvus collection. Idempotent: reuses the
        cached store once created."""
        if self._store is not None:
            return self._store
        from mfs.store import MilvusStore
        from mfs.config import MilvusConfig
        os.environ["MFS_HOME"] = str(self._db_path.parent)
        dim = embedder.dimension
        config = MilvusConfig(uri=str(self._db_path), collection_name=_collection_name(dim))
        store = MilvusStore(config, dim)
        _patch_inverted_index_skip()
        _patch_milvus_manifest_windows_replace()
        _patch_mfs_local_query_snapshot()
        try:
            store.connect()
        except Exception as err:
            # pymilvus wraps Milvus Lite's lock error generically, so we
            # walk the exception chain (both __cause__ and __context__)
            # and also pattern-match the wrapper message.
            chain = [err]
            cur = err
            seen = {id(err)}
            for _ in range(20):
                nxt = cur.__cause__ or cur.__context__
                if nxt is None or id(nxt) in seen:
                    break
                seen.add(id(nxt))
                chain.append(nxt)
                cur = nxt
            msg = str(err)
            is_lock = (
                'open local milvus failed' in msg.lower()
                or any('lock' in str(e).lower() or 'DataDirLocked' in type(e).__name__ for e in chain)
            )
            if is_lock:
                raise RuntimeError(
                    f"Milvus DB is locked by another process: {self._db_path}\n"
                    f"  Most likely a stale stashbase_daemon from a previous run.\n"
                    f"  Fix: pkill -f stashbase_daemon, then retry."
                ) from err
            raise
        # Milvus Lite leaves freshly-created (and re-opened) collections
        # in the "released" state — queries fail with code=101 until we
        # explicitly load. MFS's ensure_collection doesn't do this for us.
        try:
            store.client.load_collection(config.collection_name)
        except Exception as err:
            print(f"[stashbase] load_collection warn: {err}", file=sys.stderr)
        self._embedder = embedder
        self._store = store
        self._dim = dim
        return store

    def bind_root(
        self,
        root: str,
        provider: str,
        *,
        root_identity: str | None = None,
        api_key=None,
        model=None,
        dimension=None,
    ) -> dict:
        # First bind with a key builds the embedder + collection; later
        # binds reuse them. Without a key the root is still registered
        # but the collection isn't created — indexing stays disabled until
        # the user supplies an OpenAI key (graceful no-key degrade).
        if self._store is None and api_key:
            embedder = make_embedder(provider, model=model, api_key=api_key, dimension=dimension)
            self._ensure_store(embedder)
        requested = _norm_root(root)
        identity = root_identity or requested
        root = self._bound.setdefault(identity, requested)
        return {
            "root": root,
            "provider": "openai",
            "model": getattr(self._embedder, "model_name", None),
            "dim": self._dim,
            "collection": _collection_name(self._dim) if self._dim else None,
        }

    def unbind_root(self, root: str, *, root_identity: str | None = None) -> dict:
        requested = _norm_root(root)
        identity = root_identity or requested
        retained = self._bound.pop(identity, None)
        had = retained is not None
        root = retained or requested
        return {"root": root, "was_bound": had}

    def root_for_path(self, path: str, *, path_identity: str | None = None) -> str | None:
        """Return the bound absolute root that contains ``path`` (the
        longest matching prefix, so a nested bound root wins), or None."""
        best = None
        best_identity = None
        identity = path_identity or _norm_root(path)
        for root_identity, source in self._bound.items():
            if _path_identity_contains(root_identity, identity):
                if best_identity is None or len(root_identity) > len(best_identity):
                    best = source
                    best_identity = root_identity
        return best

    def store_for_path(self, path: str, *, path_identity: str | None = None):
        """Return ``(embedder, store)`` for ``path`` (absolute POSIX).
        Every folder shares the one collection; the path still has to
        live under a bound root."""
        if self.root_for_path(path, path_identity=path_identity) is None or self._store is None:
            raise RuntimeError(
                f"no bound root matches path '{path}'; call bind_root first "
                "(or set an OpenAI API key)",
            )
        return (self._embedder, self._store)

    def stores(self) -> list[tuple[str, Any, Any]]:
        """The single ``(provider_key, embedder, store)`` as a list (or
        empty before the first keyed bind). Tuple shape kept so call
        sites can unpack uniformly."""
        if self._store is None:
            return []
        return [(f"openai_{self._dim}", self._embedder, self._store)]

    def bound_roots(self) -> list[str]:
        """Absolute folder roots Node has registered, sorted. Used by
        whole-library disk walks."""
        return sorted(self._bound.values())

    def require_current(self):
        """Return ``(embedder, store, dim)``; raise if no embedder is
        bound yet (e.g. no OpenAI key set)."""
        if self._store is None:
            raise RuntimeError(
                "no embedder bound; call bind_folder with an OpenAI API key first",
            )
        return self._embedder, self._store, self._dim

    def close_all(self, *, clear_bindings: bool = True) -> None:
        """Release Milvus Lite's flock. The next ``bind_folder`` reopens."""
        if self._store is not None:
            try:
                self._store.close()
            except Exception:
                pass
        self._store = None
        self._embedder = None
        self._dim = 0
        if clear_bindings:
            self._bound.clear()


# ---------------------------------------------------------------- ops

def _hash_text(text: str) -> str:
    return blake3(text.encode("utf-8", errors="replace")).hexdigest()


def _flush_store(store) -> None:
    """Make successful writes visible to immediate scan/status queries.

    Milvus Lite can acknowledge an upsert before a following scalar query
    observes the rows. Flush after committed inserts/updates and keep failures
    non-fatal: the write already succeeded, and later flushes/reopens may still
    make it visible.
    """
    client = getattr(store, "client", None)
    config = getattr(store, "_config", None)
    collection = getattr(config, "collection_name", None)
    if client is None or not collection or not hasattr(client, "flush"):
        return
    try:
        client.flush(collection_name=collection)
    except TypeError:
        try:
            client.flush(collection)
        except Exception as err:
            print(f"[stashbase] flush warn: {err}", file=sys.stderr)
    except Exception as err:
        print(f"[stashbase] flush warn: {err}", file=sys.stderr)


def _embed_with_cache(svc: "StashbaseStore", path: str, embedder, texts: list[str]) -> list:
    return embedder.embed(texts)


def _require(args: dict, *keys: str) -> None:
    missing = [k for k in keys if args.get(k) is None]
    if missing:
        raise ValueError(f"missing field(s): {', '.join(missing)}")


def op_bind_folder(svc: StashbaseStore, args: dict) -> dict:
    """Register a folder root (``folder`` carries its absolute path) →
    ``provider`` mapping. Creates the collection if first use; idempotent."""
    _require(args, "folder", "provider")
    return svc.bind_root(
        args["folder"],
        args["provider"],
        root_identity=args.get("folder_identity"),
        api_key=args.get("api_key"),
        model=args.get("model"),
        dimension=args.get("dimension"),
    )


def op_unbind_folder(svc: StashbaseStore, args: dict) -> dict:
    _require(args, "folder")
    return svc.unbind_root(
        args["folder"],
        root_identity=args.get("folder_identity"),
    )


def op_upsert(svc: StashbaseStore, args: dict) -> dict:
    """Replace all rows for ``path`` with freshly-embedded chunks.

    Args: ``path`` (absolute POSIX), ``content`` (raw text /
    pre-flattened HTML-as-markdown), ``ext``, optional ``file_hash``.
    Routes to the bound provider for the folder root containing ``path``.
    """
    from mfs.store import ChunkRecord

    _require(args, "path", "content")
    path = args["path"]
    content = args["content"]
    if len(content.encode("utf-8", errors="replace")) > _RULES["max_indexable_bytes"]:
        raise ValueError(
            f"file is too large to index ({len(content):,} chars; "
            f"limit {_RULES['max_indexable_bytes']:,} bytes)",
        )
    ext = args.get("ext", ".md")
    # File-level metadata (user front-matter / HTML <meta> + the agent's
    # file-metadata.md sidecar), resolved Node-side. Used as the base for
    # every chunk's metadata; per-chunk keys (e.g. heading_text) win.
    file_metadata = args.get("metadata") or {}
    if not isinstance(file_metadata, dict):
        file_metadata = {}
    embedder, store = svc.store_for_path(
        path,
        path_identity=args.get("path_identity"),
    )
    chunks = _chunk(path, content, ext)
    file_hash = args.get("file_hash") or _hash_text(content)
    t0 = time.time()

    # Defensive: also wipe the same source from OTHER collections, so
    # if a user switched providers we don't accidentally retain stale
    # rows under the old collection that'd surface in search hits.
    for _pk, _emb, other in svc.stores():
        if other is store:
            continue
        try:
            other.delete_by_source(path)
        except Exception:
            pass
    store.delete_by_source(path)
    if not chunks:
        return {"chunks": 0, "embed_ms": 0, "total_ms": int((time.time() - t0) * 1000)}

    texts = [c.text for c in chunks]
    te0 = time.time()
    vectors = _embed_with_cache(svc, path, embedder, texts)
    embed_ms = int((time.time() - te0) * 1000)

    parent = _source_parent(path)
    records = []
    for i, (ch, vec) in enumerate(zip(chunks, vectors)):
        records.append(ChunkRecord(
            id=blake3(
                f"{path}:{ch.start_line}:{ch.end_line}:{_hash_text(ch.text)}".encode(),
            ).hexdigest()[:32],
            source=path,
            parent_dir=parent,
            chunk_index=i,
            start_line=ch.start_line,
            end_line=ch.end_line,
            chunk_text=ch.text,
            dense_vector=vec,
            content_type=ch.content_type,
            file_hash=file_hash,
            is_dir=False,
            embed_status="complete",
            metadata={**file_metadata, **(ch.metadata or {})},
            account_id="stashbase",
        ))
    store.insert_chunks(records)
    _flush_store(store)
    return {
        "chunks": len(records),
        "embed_ms": embed_ms,
        "total_ms": int((time.time() - t0) * 1000),
    }


def op_delete(svc: StashbaseStore, args: dict) -> dict:
    """Drop rows whose ``source`` equals ``path`` from every open
    collection — a file may have rows in any collection if the user
    switched providers."""
    _require(args, "path")
    path = args["path"]
    n = 0
    for _pk, _emb, store in svc.stores():
        try:
            n += int(store.delete_by_source(path))
        except Exception:
            pass
    return {"removed": n}


def op_rename(svc: StashbaseStore, args: dict) -> dict:
    """Rename a file's chunks across all collections.

    Fast path (no embedding) when the caller-supplied ``file_hash``
    matches every stored row's ``file_hash`` for the old source: copy
    each row with the new source / id / parent_dir, keep the cached
    ``dense_vector``, then drop the old rows. Saves the embedding round
    trip for true renames (huge PDFs, mass folder moves) — the common
    case once scan_diff pairs adds + deletes by hash.

    Falls back to delete-and-reinsert when the hash differs (content
    actually changed alongside the rename) or when the stored row data
    is incomplete.
    """
    from mfs.store import ChunkRecord

    _require(args, "old", "new", "content")
    old = args["old"]
    new = args["new"]
    arg_hash = args.get("file_hash")

    if arg_hash:
        try:
            copied = _try_rename_without_reembed(svc, old, new, arg_hash)
            if copied is not None:
                return {"chunks": copied, "embed_ms": 0, "fast_path": True}
        except Exception:
            # Any failure in the fast path falls back to the safe
            # re-embed path below — never leaves the store half-renamed.
            pass

    for _pk, _emb, store in svc.stores():
        try:
            store.delete_by_source(old)
        except Exception:
            pass
    return op_upsert(svc, {
        "path": new,
        "path_identity": args.get("new_identity"),
        "content": args["content"],
        "ext": args.get("ext", ".md"),
        "file_hash": arg_hash,
        "metadata": args.get("metadata") or {},
    })


def _try_rename_without_reembed(
    svc: StashbaseStore, old: str, new: str, expected_hash: str,
) -> int | None:
    """Copy each row of ``old`` to ``new`` while keeping cached vectors.

    Returns ``None`` (caller should fall back to re-embed) when:
      - no rows for the old source exist in any collection
      - any row's stored ``file_hash`` differs from ``expected_hash``
        (content drifted; we'd embed stale text otherwise)
      - any row lacks a ``dense_vector`` we can re-insert

    Otherwise returns the number of chunks moved. Old rows are dropped
    only after every collection's copy succeeded, so a partial failure
    leaves the index unchanged.
    """
    from mfs.store import ChunkRecord

    new_parent = _source_parent(new)
    fields = [
        "id", "source", "parent_dir", "chunk_index", "start_line", "end_line",
        "chunk_text", "dense_vector", "content_type", "file_hash",
        "is_dir", "embed_status", "metadata", "account_id",
    ]
    per_store_records: list[tuple[Any, list[ChunkRecord]]] = []
    total = 0
    for _pk, _emb, store in svc.stores():
        try:
            rows = store._query_all(
                f'source == "{old}"', output_fields=fields,
            )
        except Exception:
            return None
        if not rows:
            continue
        records: list[ChunkRecord] = []
        for r in rows:
            stored_hash = r.get("file_hash", "")
            if stored_hash and stored_hash != expected_hash:
                # Content drifted since we last embedded — re-embed.
                return None
            vec = r.get("dense_vector")
            if vec is None:
                return None
            new_id = blake3(
                f"{new}:{r['start_line']}:{r['end_line']}:"
                f"{_hash_text(r.get('chunk_text', ''))}".encode(),
            ).hexdigest()[:32]
            records.append(ChunkRecord(
                id=new_id,
                source=new,
                parent_dir=new_parent,
                chunk_index=int(r.get("chunk_index", 0)),
                start_line=int(r.get("start_line", 0)),
                end_line=int(r.get("end_line", 0)),
                chunk_text=r.get("chunk_text", ""),
                dense_vector=vec,
                content_type=r.get("content_type", ""),
                file_hash=expected_hash,
                is_dir=bool(r.get("is_dir", False)),
                embed_status=r.get("embed_status", "complete"),
                metadata=r.get("metadata", {}) or {},
                account_id=r.get("account_id", "stashbase"),
            ))
        per_store_records.append((store, records))
        total += len(records)

    if total == 0:
        return None

    # All rows validated — commit the copy + drop the old source.
    for store, records in per_store_records:
        store.insert_chunks(records)
        _flush_store(store)
    for _pk, _emb, store in svc.stores():
        try:
            store.delete_by_source(old)
        except Exception:
            pass
    return total


def op_reconcile_source(svc: StashbaseStore, args: dict) -> dict:
    """Rebase one legacy source spelling chosen by Node's path identity.

    Python deliberately does no path comparison here. Node owns Unicode and
    platform identity, while this operation owns the vector-preserving copy
    and stale-row fallback at the store boundary.
    """
    _require(args, "old", "new", "file_hash")
    old = args["old"]
    new = args["new"]
    copied = _try_rename_without_reembed(svc, old, new, args["file_hash"])
    if copied is None:
        for _pk, _emb, store in svc.stores():
            store.delete_by_source(old)
        return {"reused": False, "chunks": 0}
    return {"reused": True, "chunks": copied}


def op_rename_prefix(svc: StashbaseStore, args: dict) -> dict:
    """Folder rename — move every file under ``old`` to ``new``.

    Mirrors the single-file ``op_rename`` fast path per file: when a
    file's caller-supplied ``file_hash`` still matches every stored
    row's hash, copy the rows with the new source / id and reuse the
    cached ``dense_vector`` (no embedding); only fall back to
    delete-and-reinsert for files whose content actually drifted or
    whose rows lack vectors. A whole-folder move of unchanged files
    becomes ~free instead of a full re-embed of every file.

    The fast path is skipped when one prefix nests inside the other
    (``a`` → ``a/b`` or vice versa): the trailing orphan sweep of
    ``old_prefix`` could otherwise delete the freshly-written new rows.
    That case takes the original wipe-then-reembed route.
    """
    _require(args, "old", "new")
    old_prefix = _source_child_prefix(args["old"])
    new_prefix = _source_child_prefix(args["new"])
    files = args.get("files", [])
    nested = new_prefix.startswith(old_prefix) or old_prefix.startswith(new_prefix)

    total = 0
    fast_files = 0

    if nested:
        # Safe original path: clear the old prefix first, then re-embed.
        for _pk, _emb, store in svc.stores():
            try:
                store.delete_by_prefix(old_prefix)
            except Exception:
                pass
        for f in files:
            res = op_upsert(svc, {
                "path": f["path"], "content": f["content"], "ext": f.get("ext", ".md"),
                "file_hash": f.get("file_hash"), "path_identity": f.get("path_identity"),
            })
            total += int(res.get("chunks", 0))
        return {"files": len(files), "chunks": total, "fast_path_files": 0}

    for f in files:
        new_path = f["path"]
        rel = _relative_source_path(new_prefix, new_path)
        old_path = old_prefix + rel
        arg_hash = f.get("file_hash")
        copied = None
        if arg_hash:
            try:
                copied = _try_rename_without_reembed(svc, old_path, new_path, arg_hash)
            except Exception:
                # Any fast-path failure drops to the safe re-embed below —
                # never leaves the store half-renamed for this file.
                copied = None
        if copied is not None:
            total += copied
            fast_files += 1
            continue
        # Per-file fallback: drop the stale old rows, then re-embed.
        for _pk, _emb, store in svc.stores():
            try:
                store.delete_by_source(old_path)
            except Exception:
                pass
        res = op_upsert(svc, {
            "path": new_path, "content": f["content"], "ext": f.get("ext", ".md"),
            "file_hash": arg_hash, "path_identity": f.get("path_identity"),
        })
        total += int(res.get("chunks", 0))

    # Sweep any rows still under the old prefix — old files that weren't in
    # the move list (e.g. excluded by reserved-file rules upstream).
    for _pk, _emb, store in svc.stores():
        try:
            store.delete_by_prefix(old_prefix)
        except Exception:
            pass
    return {"files": len(files), "chunks": total, "fast_path_files": fast_files}


def op_delete_prefix(svc: StashbaseStore, args: dict) -> dict:
    """Drop every chunk row whose source starts with ``prefix/`` from
    every collection."""
    _require(args, "prefix")
    prefix = _source_child_prefix(args["prefix"])
    removed = 0
    for _pk, _emb, store in svc.stores():
        try:
            removed += int(store.delete_by_prefix(prefix))
        except Exception:
            pass
    return {"removed": removed}


def _search_extension_filter(raw) -> tuple | None:
    """Normalize the caller's extension list into a lowercase suffix
    tuple for ``str.endswith``. None / empty / malformed input means
    "no extension filter"."""
    if not isinstance(raw, list):
        return None
    exts = tuple(
        e.lower() for e in raw
        if isinstance(e, str) and e.startswith(".") and len(e) > 1
    )
    return exts or None


def op_search(svc: StashbaseStore, args: dict) -> dict:
    """Hybrid search in the single collection, optionally scoped to one
    ``folder``. MFS's ``hybrid_search`` already does dense + BM25 + RRF
    inside the collection, so its order is the final order — no
    second-pass fusion. ``top_k`` bounded to [1, 200]."""
    _require(args, "query")
    query = args["query"].strip()
    folder = args.get("folder")
    explicit_prefix = args.get("path_prefix")
    extensions = _search_extension_filter(args.get("extensions"))
    top_k_raw = int(args.get("top_k", 8))
    top_k = max(1, min(200, top_k_raw))
    if not query:
        return {"hits": []}
    stores = svc.stores()
    if not stores:
        return {"hits": []}
    _pk, embedder, store = stores[0]

    # Path filter: MFS's _make_filter applies `source like "<prefix>%"`.
    # `path_prefix` wins when provided — it's more specific than the
    # folder-derived prefix (e.g. "cs183b/transcripts/" vs "cs183b/").
    # Otherwise fall back to folder-only scoping; both omitted = whole
    # library.
    if explicit_prefix:
        path_filter = _source_child_prefix(explicit_prefix)
    elif folder:
        path_filter = _source_child_prefix(folder)
    else:
        path_filter = None

    # Extension filtering happens here, before the caller-visible top-k
    # cut. MFS's hybrid_search only accepts a path prefix filter, so the
    # store is over-fetched (bounded) and filtered by source suffix; the
    # filtered list is then truncated back to top_k. A very sparse type
    # can still return fewer than top_k hits.
    fetch_k = top_k if extensions is None else min(200, max(top_k * 5, 50))

    try:
        if store.is_empty():
            return {"hits": []}
        qvec = embedder.embed([query])[0]
        hits = store.hybrid_search(qvec, query, path_filter=path_filter, top_k=fetch_k)
    except Exception as exc:
        sys.stderr.write(f"[stashbase] search store failed: {exc}\n")
        return {"hits": []}

    out = []
    for h in hits:
        if h.is_dir:
            continue
        if extensions is not None and not h.source.lower().endswith(extensions):
            continue
        out.append({
            "path": h.source,
            "chunk_index": h.chunk_index,
            "chunk_text": h.chunk_text,
            "start_line": h.start_line,
            "end_line": h.end_line,
            "content_type": h.content_type,
            "score": h.score,
            "metadata": h.metadata or {},
        })
        if len(out) >= top_k:
            break
    return {"hits": out}


def op_list(svc: StashbaseStore, args: dict) -> dict:
    """Return ``{path: file_hash}`` for every file with rows across the
    **active** collections, optionally scoped to one ``folder``. A file
    in multiple active collections collapses to one entry (last write
    wins — shouldn't matter in practice, files live in exactly one
    collection in the steady state).

    Archive collections are excluded: if an old collection still has
    rows for a file the reconcile path would see ``hash matches`` and
    skip re-embedding under the current embedder, leaving the file
    unsearchable. See build-map 04-indexing #03."""
    folder = args.get("folder")
    prefix = _source_child_prefix(folder) if folder else ""
    out: dict[str, str] = {}
    for _pk, _emb, store in svc.stores():
        try:
            files = store.get_indexed_files(prefix)
        except Exception:
            continue
        for src, fh in files.items():
            out[src] = fh
    return {"files": out}


def _is_reserved_metadata_path(rel_local: str) -> bool:
    """True for hidden sidecar metadata plus the legacy folder-root file.

    Do not match by basename alone: a user note at
    ``research/file-metadata.md`` is normal content and should be indexed.
    """
    parts = [p for p in rel_local.split("/") if p]
    if len(parts) >= 2 and parts[0] == ".stashbase" and parts[1] == "file-metadata.md":
        return True
    return len(parts) == 1 and parts[0] == "file-metadata.md"


def _make_scanner():
    """Configure an MFS Scanner for our folder layout.

    Two tweaks over MFS defaults:
      - `.html` / `.htm` aren't in `INDEXED_EXTENSIONS`, inject via
        `IndexingConfig.include_extensions`
      - generated/dependency/source-control dirs are skipped so a root
        pointed at a code checkout does not flood the indexer
      - `compute_file_hash` is patched to BLAKE3 (see _patch_scanner_blake3)
    """
    from mfs.config import Config, IndexingConfig
    from mfs.ingest.scanner import Scanner
    _patch_scanner_blake3()
    config = Config(indexing=IndexingConfig(include_extensions=list(_RULES["include_extensions"])))
    extra = []
    for name in sorted(_RULES["excluded_dirs"]):
        extra.append(name)
        extra.append(f"{name}/")
    return Scanner(config, extra_excludes=extra)


def _walk_disk(root: Path, rel_prefix: str = "") -> dict:
    """Walk ``root`` returning ``{rel_path: FileInfo}`` for indexable
    files. ``rel_path`` is prefixed with ``rel_prefix`` for callers that
    need a stable display path while scanning a subdir.

    Filters out anything inside a ``<stem>_files/`` bundle dir and any
    0-byte note — same rules as the sidebar's tree walk.
    """
    scanner = _make_scanner()
    raw = []
    for f in scanner.scan([root]):
        try:
            rel_local = str(f.path.relative_to(root)).replace(os.sep, "/")
        except ValueError:
            continue
        full_rel = _join_source_path(rel_prefix, rel_local) if rel_prefix else rel_local
        raw.append((full_rel, rel_local, f))

    # Note-stem detection runs against the local-relative path; only
    # `.md` / `.html` files in the SAME directory can produce a bundle.
    note_stems = set()
    for _full, rel_local, _f in raw:
        base = rel_local.rsplit("/", 1)[-1]
        for ext in (".md", ".markdown", ".html", ".htm"):
            if base.lower().endswith(ext):
                parent = rel_local[: -len(base)]
                stem = base[: -len(ext)]
                note_stems.add(parent + stem)
                break

    on_disk = {}
    for full_rel, rel_local, f in raw:
        if _has_excluded_segment(rel_local):
            continue
        if _under_bundle(rel_local, note_stems):
            continue
        # Reserved agent metadata files must never be indexed (their YAML
        # / 目录 prose would surface as bogus hits). Mirrors the Node-side
        # guard in `indexer.mfs.ts:upsertFile`. See build-map 02-storage.
        if _is_reserved_metadata_path(rel_local):
            continue
        try:
            size = f.path.stat().st_size
            if size == 0 or size > _RULES["max_indexable_bytes"]:
                continue
        except OSError:
            continue
        on_disk[full_rel] = f
    return on_disk


def _has_excluded_segment(rel: str) -> bool:
    return any(seg in _RULES["excluded_dirs"] for seg in rel.split("/") if seg)


def _under_bundle(rel: str, note_stems: set) -> bool:
    """True if ``rel`` lives inside a ``<stem>_files/`` bundle whose
    sibling ``<stem>.{md,html}`` we know about."""
    segments = rel.split("/")
    for i, seg in enumerate(segments[:-1]):
        if not seg.endswith("_files"):
            continue
        stem = seg[: -len("_files")]
        parent = "/".join(segments[:i])
        candidate = (parent + "/" + stem) if parent else stem
        if candidate in note_stems:
            return True
    return False


def _walk_for_scope(svc: StashbaseStore, root: str | None) -> dict:
    """Pick the right disk walk for ``status`` / ``scan_diff``:
    - ``root`` given (an absolute folder root) → walk just that folder,
      with the root as rel-prefix so returned paths are absolute.
    - ``root`` omitted → walk every bound root; skip unbound directories
      so we don't count files no collection is responsible for.
    """
    if root is not None:
        root = _norm_root(root)
        return _walk_disk(Path(root), rel_prefix=root)
    out: dict = {}
    for r in svc.bound_roots():
        out.update(_walk_disk(Path(r), rel_prefix=r))
    return out


def op_scan_diff(svc: StashbaseStore, args: dict) -> dict:
    """Content-hash diff: catches external edits the name-set diff misses.

    ``args.folder`` optional; whole library if omitted.

    Pairs deleted+added entries with matching content hash and reports
    them as ``renamed`` instead so the Node syncIndex can route them
    through ``op_rename`` (which skips re-embedding when the content is
    unchanged — see fast-path in ``op_rename``). Only 1:1 hash matches
    are treated as renames; ambiguous N:M cases stay in
    deleted/added so the user-visible diff doesn't silently mis-attribute
    moves.
    """
    scanner = _make_scanner()
    folder = args.get("folder")
    on_disk = _walk_for_scope(svc, folder)
    # Aggregate indexed files across **active** collections, scoped if
    # needed. Archive collections are excluded so a stale row from the
    # previous embedder doesn't mark a file as "indexed" — the
    # reconcile loop would then skip re-embedding it under the current
    # embedder and the file would stay unsearchable.
    indexed: dict[str, str] = {}
    prefix = _source_child_prefix(folder) if folder else ""
    for _pk, _emb, store in svc.stores():
        try:
            for src, fh in store.get_indexed_files(prefix).items():
                indexed[src] = fh
        except Exception:
            continue

    added, modified, unchanged = [], [], []
    added_hashes: dict[str, str] = {}
    for rel, f in on_disk.items():
        if rel not in indexed:
            added.append(rel)
            try:
                added_hashes[rel] = scanner.compute_file_hash(f.path)
            except OSError:
                # If we can't hash a fresh file, it stays in `added`
                # without a hash entry — rename detection just won't
                # pair it. Reconcile will index it normally.
                pass
            continue
        try:
            disk_hash = scanner.compute_file_hash(f.path)
        except OSError:
            unchanged.append(rel)
            continue
        if disk_hash != indexed[rel]:
            modified.append(rel)
        else:
            unchanged.append(rel)
    deleted = [rel for rel in indexed if rel not in on_disk]

    # Pair adds and deletes that share a content hash. Only handle 1:1
    # matches — if two added files share a hash with two deleted files,
    # we can't tell who renamed to who, so leave them in the buckets.
    renamed: list[dict[str, str]] = []
    if added_hashes and deleted:
        deleted_hashes: dict[str, str] = {}
        for rel in deleted:
            deleted_hashes[rel] = indexed[rel]
        added_by_hash: dict[str, list[str]] = {}
        for rel, h in added_hashes.items():
            added_by_hash.setdefault(h, []).append(rel)
        deleted_by_hash: dict[str, list[str]] = {}
        for rel, h in deleted_hashes.items():
            deleted_by_hash.setdefault(h, []).append(rel)
        consumed_added: set[str] = set()
        consumed_deleted: set[str] = set()
        for h, adds in added_by_hash.items():
            dels = deleted_by_hash.get(h, [])
            if len(adds) == 1 and len(dels) == 1:
                renamed.append({"old": dels[0], "new": adds[0], "file_hash": h})
                consumed_added.add(adds[0])
                consumed_deleted.add(dels[0])
        if consumed_added:
            added = [a for a in added if a not in consumed_added]
        if consumed_deleted:
            deleted = [d for d in deleted if d not in consumed_deleted]

    return {
        "added": added,
        "modified": modified,
        "deleted": deleted,
        "renamed": renamed,
        "unchanged_count": len(unchanged),
    }


def op_status(svc: StashbaseStore, args: dict) -> dict:
    """Name-only diff. ``args.folder`` optional; whole library if omitted.

    Active-store-only (mirrors ``op_scan_diff``): archive rows must not
    inflate the "indexed" set or the UI would report green when files
    actually still need to be re-embedded under the current embedder."""
    folder = args.get("folder")
    on_disk = set(_walk_for_scope(svc, folder).keys())
    prefix = _source_child_prefix(folder) if folder else ""
    indexed: set[str] = set()
    for _pk, _emb, store in svc.stores():
        try:
            indexed.update(store.get_indexed_files(prefix).keys())
        except Exception:
            continue

    pending = sorted(on_disk - indexed)
    orphaned_count = len(indexed - on_disk)
    orphaned = sorted(indexed - on_disk)

    return {
        "total": len(on_disk),
        "indexed": len(on_disk & indexed),
        "pending_count": len(pending),
        "pending": pending,
        "orphaned_count": orphaned_count,
        "orphaned": orphaned,
        "up_to_date": len(pending) == 0 and orphaned_count == 0,
    }


def op_close_store(svc: StashbaseStore, _args: dict) -> dict:
    """Release the Milvus Lite flock so the server can move / wipe the
    DB. Next ``bind_folder`` reopens lazily."""
    svc.close_all(clear_bindings=False)
    return {}


OPS = {
    "bind_folder": op_bind_folder,
    "unbind_folder": op_unbind_folder,
    "upsert": op_upsert,
    "delete": op_delete,
    "delete_prefix": op_delete_prefix,
    "rename": op_rename,
    "reconcile_source": op_reconcile_source,
    "rename_prefix": op_rename_prefix,
    "search": op_search,
    "scan_diff": op_scan_diff,
    "status": op_status,
    "list": op_list,
    "close_store": op_close_store,
    "set_rules": op_set_rules,
}


def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _termination_signals(signal_module) -> tuple[Any, ...]:
    return tuple(
        getattr(signal_module, name)
        for name in ("SIGTERM", "SIGINT", "SIGHUP")
        if hasattr(signal_module, name)
    )


def main() -> int:
    import atexit
    import signal

    parser = argparse.ArgumentParser(description="StashBase MFS sidecar daemon")
    parser.add_argument("--store-root", required=True,
                        help="Per-machine app-data directory that holds the single "
                             "global milvus.db; folders register absolute roots into it")
    parsed, _unknown = parser.parse_known_args()

    # Single-instance guard: hold an exclusive flock
    # on a sidecar lock file for the whole process lifetime. Milvus Lite
    # has its own LOCK, but the loser of that race doesn't fail — it
    # half-opens (reads fine, writes silently lost). Failing fast here
    # turns "second daemon on the same folderHome" into an explicit startup
    # error the Node side can surface. The flock dies with the process,
    # so a dirty exit can never strand it. Best-effort: fcntl missing
    # (Windows) or fs oddities skip the guard rather than block startup.
    daemon_lock = None  # noqa: F841 — held open for the process lifetime
    try:
        import fcntl
        lock_root = Path(parsed.store_root).expanduser().resolve()
        lock_path = lock_root / "daemon.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        daemon_lock = open(lock_path, "w")
        try:
            fcntl.flock(daemon_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            daemon_lock.write(str(os.getpid()))
            daemon_lock.flush()
        except BlockingIOError:
            _emit({
                "event": "error",
                "phase": "daemon_lock",
                "error": f"another stashbase daemon already holds {lock_path} — "
                         "refusing to run a second instance against the same store",
            })
            return 1
    except Exception:
        daemon_lock = None  # unguarded platforms: proceed as before

    try:
        svc = StashbaseStore(parsed.store_root)
    except Exception as exc:
        _emit({"event": "error", "phase": "store_init", "error": str(exc)})
        return 1

    # Release every Milvus Lite flock cleanly on any exit path. Without
    # this, killing the Node parent leaves the locks held until the kernel
    # reaps the FDs, and the next StashBase launch gets a "DataDirLocked"
    # error from MilvusLite.
    def _cleanup_store(*_):
        try:
            svc.close_all()
        except Exception:
            pass
    atexit.register(_cleanup_store)
    for sig in _termination_signals(signal):
        try:
            signal.signal(sig, lambda *_: (_cleanup_store(), sys.exit(0)))
        except (ValueError, OSError):
            pass

    _emit({"event": "ready", "db": str(svc._db_path)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            req_id = req.get("id")
            op = req["op"]
            args = req.get("args", {}) or {}
        except (ValueError, KeyError) as exc:
            _emit({"id": None, "ok": False, "error": f"bad request: {exc}"})
            continue

        try:
            handler = OPS.get(op)
            if handler is None:
                _emit({"id": req_id, "ok": False, "error": f"unknown op: {op}", "op": op})
                continue
            result = handler(svc, args)
            _emit({"id": req_id, "ok": True, "result": result})
        except (KeyError, ValueError) as exc:
            sys.stderr.write(f"[stashbase] bad args for {op}: {exc}\n")
            _emit({"id": req_id, "ok": False, "error": f"bad args for {op}: {exc}", "op": op})
        except Exception as exc:
            sys.stderr.write(traceback.format_exc())
            sys.stderr.flush()
            _emit({"id": req_id, "ok": False, "error": str(exc), "op": op})

    return 0


if __name__ == "__main__":
    sys.exit(main())
