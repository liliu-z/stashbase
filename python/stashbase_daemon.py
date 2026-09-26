"""StashBase adapter for the public MFS project.

StashBase owns format preparation and the user-visible source lifecycle. MFS
owns one Internal namespace per Folder, projection content identity, document
status, and indexing. It receives only complete UTF-8 search projections
through ``MFS.upsert``.

The Node server speaks newline-delimited JSON over stdin/stdout. Requests may
finish out of order; the request id is the only response correlation key.
"""

from __future__ import annotations

import argparse
from bisect import bisect_right
import concurrent.futures
import json
import os
import sys
import threading
import time
import traceback
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from blake3 import blake3
from mfs import (
    ByExtension,
    DefaultChunker,
    DocumentId,
    GrepBudget,
    MFS,
    PathPrefix,
    TextMatch,
    Utf8TextProcessor,
    run_process_supervisor,
)

# A frozen MFS helper invocation must retire before the application daemon is
# initialized. Normal source and packaged launches return immediately.
run_process_supervisor()

print(json.dumps({"event": "starting", "pid": os.getpid()}), flush=True)


def _require(args: dict[str, Any], *names: str) -> None:
    missing = [name for name in names if name not in args]
    if missing:
        raise ValueError(f"missing required argument(s): {', '.join(missing)}")


def _norm_path(value: str) -> str:
    normalized = str(value).replace("\\", "/")
    while len(normalized) > 1 and normalized.endswith("/"):
        normalized = normalized[:-1]
    return normalized


def _is_under_identity(root: str, candidate: str) -> bool:
    root = _norm_path(root)
    candidate = _norm_path(candidate)
    return candidate == root or candidate.startswith(root + "/")


def _relative(root: str, path: str) -> str:
    root = _norm_path(root)
    path = _norm_path(path)
    if path == root or not path.startswith(root + "/"):
        raise ValueError(f"path is outside bound Folder: {path}")
    relative = path[len(root) + 1 :]
    if not relative or relative.startswith("/"):
        raise ValueError(f"invalid Folder-relative document id: {relative!r}")
    return relative


def _join(root: str, relative: str) -> str:
    return _norm_path(root) + "/" + relative


class OpenAIEmbedder:
    """OpenAI-compatible MFS Embedder with bounded calls and retries."""

    _NATIVE_DIMS = {
        "text-embedding-3-small": 1536,
        "text-embedding-3-large": 3072,
        "text-embedding-ada-002": 1536,
    }
    _MAX_REQUEST_TOKENS = 250_000
    _MAX_BATCH_ITEMS = 64

    def __init__(
        self,
        *,
        provider: str,
        model: str,
        api_key: str,
        dimension: int | None = None,
        base_url: str | None = None,
        timeout: float = 60.0,
        max_retries: int = 3,
    ) -> None:
        import openai

        self._openai = openai
        kwargs: dict[str, Any] = {"api_key": api_key, "timeout": timeout}
        if base_url:
            kwargs["base_url"] = base_url
        self._client = openai.OpenAI(**kwargs)
        self.provider = provider
        self.model = model
        native_name = model.rsplit("/", 1)[-1]
        self.dimension = dimension or self._NATIVE_DIMS.get(native_name, 1536)
        self.embedding_space = f"stashbase/{provider}/{model}"
        self._max_retries = max(1, max_retries)

    @staticmethod
    def _estimate_tokens(text: str) -> int:
        return max(1, (len(text) + 2) // 3)

    def _embed_batch(self, texts: list[str]) -> list[list[float]]:
        transient = (
            self._openai.APITimeoutError,
            self._openai.APIConnectionError,
            self._openai.RateLimitError,
            self._openai.InternalServerError,
        )
        native_name = self.model.rsplit("/", 1)[-1]
        native_dimension = self._NATIVE_DIMS.get(native_name)
        request: dict[str, Any] = {"model": self.model, "input": texts}
        if native_dimension is not None and self.dimension != native_dimension:
            request["dimensions"] = self.dimension
        for attempt in range(self._max_retries):
            try:
                response = self._client.embeddings.create(**request)
                return [item.embedding for item in response.data]
            except transient:
                if attempt + 1 >= self._max_retries:
                    raise
                time.sleep(1.5 * (2**attempt))
        raise RuntimeError("embedding retry loop exhausted")

    def embed_documents(self, texts: Sequence[str]) -> Sequence[Sequence[float]]:
        output: list[list[float]] = []
        batch: list[str] = []
        tokens = 0
        for text in texts:
            estimate = self._estimate_tokens(text)
            if estimate > self._MAX_REQUEST_TOKENS:
                raise ValueError("single embedding input exceeds the provider request budget")
            if batch and (
                len(batch) >= self._MAX_BATCH_ITEMS
                or tokens + estimate > self._MAX_REQUEST_TOKENS
            ):
                output.extend(self._embed_batch(batch))
                batch = []
                tokens = 0
            batch.append(text)
            tokens += estimate
        if batch:
            output.extend(self._embed_batch(batch))
        return output

    def embed_query(self, text: str) -> Sequence[float]:
        return self._embed_batch([text])[0]


class UnavailableEmbedder:
    """Manifest-compatible binding used only for cleanup without a key."""

    def __init__(self, embedding_space: str, dimension: int) -> None:
        self.embedding_space = embedding_space
        self.dimension = dimension

    def embed_documents(self, texts: Sequence[str]) -> Sequence[Sequence[float]]:
        del texts
        raise RuntimeError("embedding provider is not configured")

    def embed_query(self, text: str) -> Sequence[float]:
        del text
        raise RuntimeError("embedding provider is not configured")


def make_embedder(
    provider: str = "openai",
    *,
    model: str | None = None,
    api_key: str | None = None,
    dimension: int | None = None,
    base_url: str | None = None,
) -> OpenAIEmbedder:
    if provider not in ("openai", "openrouter", "requesty"):
        raise ValueError(f"unsupported embedding provider {provider!r}")
    if not api_key:
        raise ValueError(f"{provider} embedder requires api_key")
    if provider == "openrouter":
        model = model or "openai/text-embedding-3-small"
        base_url = base_url or "https://openrouter.ai/api/v1"
    elif provider == "requesty":
        model = model or "openai/text-embedding-3-small"
        base_url = base_url or "https://router.requesty.ai/v1"
    else:
        model = model or "text-embedding-3-small"
    return OpenAIEmbedder(
        provider=provider,
        model=model,
        api_key=api_key,
        dimension=dimension,
        base_url=base_url,
    )


@dataclass(frozen=True)
class FolderBinding:
    root: str
    identity: str
    namespace: str


class StashbaseMFS:
    def __init__(self, store_root: str) -> None:
        root = Path(store_root).expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True)
        self.state_path = root / "mfs-v2"
        self._mfs = MFS.open(self.state_path)
        self._bindings: dict[str, FolderBinding] = {}
        self._lock = threading.RLock()
        self._processor = Utf8TextProcessor()
        self._chunker = DefaultChunker()
        self._closed = False

    @staticmethod
    def _manifest_dense(manifest: Any) -> dict[str, Any] | None:
        if not isinstance(manifest, dict):
            return None
        index = manifest.get("index")
        dense = index.get("dense") if isinstance(index, dict) else None
        return dense if isinstance(dense, dict) else None

    @staticmethod
    def _compatible_embedder(manifest: Any, requested: OpenAIEmbedder | None):
        dense = StashbaseMFS._manifest_dense(manifest)
        if dense is None:
            return None
        space = str(dense.get("embedding_space", ""))
        dimension = int(dense.get("dimension", 0))
        if requested and requested.embedding_space == space and requested.dimension == dimension:
            return requested
        return UnavailableEmbedder(space, dimension)

    def _open_or_create_namespace(
        self, namespace: str, requested: OpenAIEmbedder | None
    ) -> None:
        known = {item.namespace for item in self._mfs.list_namespaces()}
        if namespace not in known:
            self._mfs.create_namespace(
                namespace,
                "internal",
                processors=[self._processor],
                chunker=self._chunker,
                embedder=requested,
                indexing="hybrid" if requested else "off",
            )
            return

        configuration = self._mfs.namespace_configuration(namespace)
        current_embedder = self._compatible_embedder(configuration.manifest, requested)
        self._mfs.open_namespace(
            namespace,
            processors=[self._processor],
            chunker=self._chunker,
            embedder=current_embedder,
        )
        if configuration.pending_revision and configuration.pending_manifest:
            pending_embedder = self._compatible_embedder(
                configuration.pending_manifest, requested
            )
            self._mfs.open_namespace(
                namespace,
                processors=[self._processor],
                chunker=self._chunker,
                embedder=pending_embedder,
                configuration_revision=configuration.pending_revision,
            )

        current_dense = self._manifest_dense(configuration.manifest)
        requested_matches = bool(
            requested
            and current_dense
            and current_dense.get("embedding_space") == requested.embedding_space
            and current_dense.get("dimension") == requested.dimension
            and configuration.indexing == "hybrid"
        )
        pending_dense = self._manifest_dense(configuration.pending_manifest)
        pending_matches = bool(
            requested
            and pending_dense
            and pending_dense.get("embedding_space") == requested.embedding_space
            and pending_dense.get("dimension") == requested.dimension
        )
        matches = pending_matches if configuration.pending_revision else requested_matches
        if requested and not matches:
            self._mfs.configure_namespace(
                namespace,
                processors=[self._processor],
                chunker=self._chunker,
                embedder=requested,
                indexing="hybrid",
            )
        elif requested is None and (configuration.indexing != "off" or configuration.pending_revision):
            self._mfs.configure_namespace(
                namespace,
                processors=[self._processor],
                chunker=self._chunker,
                indexing="off",
            )
        # Configuration is durably accepted above; MFS builds it in the
        # background. Never wait for embedding while holding the routing lock.

    def bind_folder(self, args: dict[str, Any]) -> dict[str, Any]:
        _require(args, "folder")
        root = _norm_path(str(args["folder"]))
        identity = _norm_path(str(args.get("folder_identity") or root))
        provider = str(args.get("provider") or "openai")
        requested = None
        if args.get("api_key"):
            requested = make_embedder(
                provider,
                model=args.get("model"),
                api_key=str(args["api_key"]),
                dimension=int(args["dimension"]) if args.get("dimension") else None,
                base_url=args.get("base_url"),
            )
        elif provider not in ("openai", "openrouter", "requesty"):
            raise ValueError(f"unsupported embedding provider {provider!r}")

        namespace = "folder-" + blake3(identity.encode("utf-8")).hexdigest()[:32]
        with self._lock:
            self._open_or_create_namespace(namespace, requested)
            self._bindings[identity] = FolderBinding(root, identity, namespace)
            removals = self._remove_shadowed_projections()
        for report in removals:
            self._mfs.wait(report, 300)
        return {"namespace": namespace}

    def _remove_shadowed_projections(self) -> list[Any]:
        """Retire ancestor rows, including namespaces reopened after a restart.

        Called under the routing lock, shared with upsert admission. A writer
        cannot publish a new ancestor row after the nested owner takes over.
        """
        reports = []
        for binding in self._bindings.values():
            prefixes = [
                _relative(binding.root, child.root) + "/"
                for child in self._bindings.values()
                if child.identity != binding.identity
                and _is_under_identity(binding.identity, child.identity)
            ]
            if not prefixes:
                continue
            for status in self._document_statuses(binding):
                if status.content_hash is not None and any(
                    status.id.doc_id.startswith(prefix) for prefix in prefixes
                ):
                    reports.append(self._mfs.remove(binding.namespace, status.id.doc_id))
        return reports

    def unbind_folder(self, args: dict[str, Any]) -> dict[str, Any]:
        _require(args, "folder")
        identity = _norm_path(str(args.get("folder_identity") or args["folder"]))
        with self._lock:
            self._bindings.pop(identity, None)
        return {}

    def binding_for_path(self, path: str, identity: str | None = None) -> FolderBinding:
        retained = _norm_path(path)
        comparison = _norm_path(identity or retained)
        with self._lock:
            candidates = [
                binding
                for binding in self._bindings.values()
                if _is_under_identity(binding.identity, comparison)
            ]
        if not candidates:
            raise ValueError(f"path is not under a bound Folder: {path}")
        return max(candidates, key=lambda binding: len(binding.identity))

    def binding_for_folder(self, folder: str) -> FolderBinding:
        normalized = _norm_path(folder)
        with self._lock:
            exact = [
                binding
                for binding in self._bindings.values()
                if binding.root == normalized or binding.identity == normalized
            ]
        if not exact:
            raise ValueError(f"Folder is not bound: {folder}")
        return exact[0]

    def projection_identity(
        self, args: dict[str, Any], key: str = "path"
    ) -> tuple[FolderBinding, str]:
        _require(args, key)
        path = _norm_path(str(args[key]))
        identity = args.get(f"{key}_identity") or args.get("path_identity")
        binding = self.binding_for_path(path, str(identity) if identity else None)
        return binding, _relative(binding.root, path)

    def upsert(self, args: dict[str, Any]) -> dict[str, Any]:
        _require(args, "path", "content")
        content = str(args["content"])
        started = time.monotonic()
        with self._lock:
            binding, doc_id = self.projection_identity(args)
            report = self._mfs.upsert(
                binding.namespace,
                doc_id,
                content.encode("utf-8"),
                media_type="text/markdown",
            )
        # Source saves need acceptance (which retires the previous revision),
        # not completion of optional provider-backed embedding work.
        if args.get("wait_for_index", True):
            self._mfs.wait(report, 300)
        elapsed = int((time.monotonic() - started) * 1000)
        return {
            "total_ms": elapsed,
            "outcome": report.outcome,
        }

    def delete(self, args: dict[str, Any]) -> dict[str, Any]:
        binding, doc_id = self.projection_identity(args)
        report = self._mfs.remove(binding.namespace, doc_id)
        if report.outcome == "removed":
            self._mfs.wait(report, 300)
        return {"removed": 1 if report.outcome == "removed" else 0}

    def delete_prefix(self, args: dict[str, Any]) -> dict[str, Any]:
        _require(args, "prefix")
        prefix = _norm_path(str(args["prefix"]))
        prefix_identity = _norm_path(str(args.get("prefix_identity") or prefix))
        removed = 0
        with self._lock:
            bindings = tuple(self._bindings.values())
        for binding in bindings:
            if prefix_identity == binding.identity:
                relative_prefix = ""
            elif prefix_identity.startswith(binding.identity + "/"):
                relative_prefix = _relative(binding.root, prefix)
            else:
                continue
            for status in self._document_statuses(binding):
                if status.content_hash is None:
                    continue
                doc_id = status.id.doc_id
                if relative_prefix and not (
                    doc_id == relative_prefix or doc_id.startswith(relative_prefix + "/")
                ):
                    continue
                report = self._mfs.remove(binding.namespace, doc_id)
                if report.outcome == "removed":
                    removed += 1
            self._mfs.wait(binding.namespace, 300)
        return {"removed": removed}

    def _document_statuses(self, binding: FolderBinding) -> tuple[Any, ...]:
        statuses: list[Any] = []
        offset = 0
        while True:
            page = self._mfs.list_document_statuses(
                binding.namespace, limit=1000, offset=offset
            )
            statuses.extend(page)
            if len(page) < 1000:
                return tuple(statuses)
            offset += len(page)

    def list_documents(self, folder: str | None = None) -> list[str]:
        bindings = (
            (self.binding_for_folder(folder),)
            if folder
            else tuple(self._bindings.values())
        )
        return sorted(
            _join(binding.root, status.id.doc_id)
            for binding in bindings
            for status in self._document_statuses(binding)
            if status.content_hash is not None
        )

    def status(self, folder: str | None = None) -> dict[str, Any]:
        bindings = (
            (self.binding_for_folder(folder),)
            if folder
            else tuple(self._bindings.values())
        )
        documents: list[Any] = []
        for binding in bindings:
            configuration = self._mfs.namespace_configuration(binding.namespace)
            building = configuration.pending_revision is not None
            indexing = (
                self._manifest_dense(configuration.pending_manifest) is not None
                if building else configuration.indexing != "off"
            )
            documents.extend(
                (binding, status, indexing, building)
                for status in self._document_statuses(binding)
                if status.content_hash is not None
            )
        ready = [
            (binding, status)
            for binding, status, indexing, building in documents
            if indexing and not building and status.indexed_revision == status.revision
        ]
        pending = sorted(
            _join(binding.root, status.id.doc_id)
            for binding, status, indexing, building in documents
            if indexing and (building or status.indexed_revision != status.revision)
        )
        return {
            "total": len(documents),
            "indexed": len(ready),
            "pending_count": len(pending),
            "pending": pending,
            "orphaned_count": 0,
            "orphaned": [],
            "up_to_date": not pending,
        }

    @staticmethod
    def _line_range(sources: Iterable[Any]) -> tuple[int | None, int | None]:
        starts: list[int] = []
        ends: list[int] = []
        for source in sources:
            if not isinstance(source, dict) or source.get("kind") != "lines":
                continue
            if isinstance(source.get("start"), int):
                starts.append(int(source["start"]))
            if isinstance(source.get("end"), int):
                ends.append(int(source["end"]))
        return (min(starts) if starts else None, max(ends) if ends else None)

    def search(self, args: dict[str, Any]) -> dict[str, Any]:
        _require(args, "query", "folder")
        query = str(args["query"]).strip()
        if not query:
            return {"hits": []}
        binding = self.binding_for_folder(str(args["folder"]))
        filters: list[Any] = []
        path_prefix = args.get("path_prefix")
        if path_prefix and _norm_path(str(path_prefix)) != binding.root:
            relative_prefix = _relative(binding.root, _norm_path(str(path_prefix)))
            filters.append(PathPrefix(relative_prefix.rstrip("/") + "/"))
        extensions = tuple(
            extension.lower()
            for extension in (args.get("extensions") or [])
            if isinstance(extension, str) and extension.startswith(".")
        )
        if extensions:
            filters.append(ByExtension(extensions))
        limit = max(1, min(200, int(args.get("top_k", 8))))
        result = self._mfs.search(
            binding.namespace,
            query,
            filters,
            mode="hybrid",
            select="chunk",
            limit=limit,
            consistency="eventual",
            timeout=30,
        )
        hits: list[dict[str, Any]] = []
        for item in result.items:
            chunk = item.value
            start_line, end_line = self._line_range(chunk.source_location.sources)
            hits.append(
                {
                    "path": _join(binding.root, chunk.document_id.doc_id),
                    "chunk_index": chunk.ordinal,
                    "chunk_text": chunk.text,
                    "start_line": start_line,
                    "end_line": end_line,
                    "score": item.score,
                    "metadata": {},
                }
            )
        return {"hits": hits, "truncated": result.truncated}

    @staticmethod
    def _utf16_length(value: str) -> int:
        return len(value.encode("utf-16-le")) // 2

    @classmethod
    def _grep_matches(cls, text: str, matches: Iterable[Any]) -> list[dict[str, Any]]:
        encoded = text.encode("utf-8")
        lines: list[tuple[int, int, bytes, str]] = []
        offset = 0
        for raw_line in encoded.splitlines(keepends=True):
            content = raw_line.removesuffix(b"\n").removesuffix(b"\r")
            lines.append((offset, offset + len(content), content, content.decode("utf-8")))
            offset += len(raw_line)
        if offset < len(encoded) or not lines:
            tail = encoded[offset:]
            lines.append((offset, len(encoded), tail, tail.decode("utf-8")))

        by_line: dict[int, list[list[int]]] = {}
        line_starts = [line[0] for line in lines]
        for match in matches:
            index = max(0, bisect_right(line_starts, match.text_start) - 1)
            while index < len(lines):
                start, end, line_bytes, _line = lines[index]
                if start >= match.text_end:
                    break
                if match.text_start >= end or match.text_end <= start:
                    index += 1
                    continue
                local_start = max(start, match.text_start) - start
                local_end = min(end, match.text_end) - start
                prefix = line_bytes[:local_start].decode("utf-8")
                matched = line_bytes[local_start:local_end].decode("utf-8")
                begin = cls._utf16_length(prefix)
                by_line.setdefault(index, []).append(
                    [begin, begin + cls._utf16_length(matched)]
                )
                index += 1

        return [
            {"line": index + 1, "text": lines[index][3], "ranges": ranges}
            for index, ranges in sorted(by_line.items())
        ]

    def grep(self, args: dict[str, Any]) -> dict[str, Any]:
        _require(args, "query", "folder")
        query = str(args["query"]).strip()
        if not query:
            return {"files": [], "total_matches": 0, "truncated": False}
        binding = self.binding_for_folder(str(args["folder"]))
        filters: list[Any] = [
            TextMatch(
                query,
                case_sensitive=bool(args.get("case_strict")),
                smart_case=not bool(args.get("case_strict")),
                whole_word=bool(args.get("whole_word")),
            )
        ]
        path_prefix = args.get("path_prefix")
        if path_prefix and _norm_path(str(path_prefix)) != binding.root:
            relative_prefix = _relative(binding.root, _norm_path(str(path_prefix)))
            filters.append(PathPrefix(relative_prefix.rstrip("/") + "/"))
        extensions = tuple(
            extension.lower()
            for extension in (args.get("extensions") or [])
            if isinstance(extension, str) and extension.startswith(".")
        )
        if extensions:
            filters.append(ByExtension(extensions))

        result = self._mfs.grep(
            binding.namespace,
            filters,
            select="doc",
            limit=None,
            budget=GrepBudget(
                max_documents=10_000,
                max_bytes=64 * 1024 * 1024,
                max_file_bytes=5 * 1024 * 1024,
                max_matches=500,
            ),
            consistency="strong",
            timeout=30,
        )
        files: list[dict[str, Any]] = []
        total_matches = 0
        for item in result.items:
            matches = self._grep_matches(item.value.text, item.matches)
            count = sum(len(match["ranges"]) for match in matches)
            if count == 0:
                continue
            total_matches += count
            files.append(
                {
                    "path": item.value.id.doc_id,
                    "matches": matches,
                    "total_matches": count,
                }
            )
        files.sort(key=lambda item: item["path"])
        return {
            "files": files,
            "total_matches": total_matches,
            "truncated": result.truncated or bool(result.failures),
        }

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
        self._mfs.close(timeout=30)


def dispatch(service: StashbaseMFS, operation: str, args: dict[str, Any]) -> Any:
    if operation == "bind_folder":
        return service.bind_folder(args)
    if operation == "unbind_folder":
        return service.unbind_folder(args)
    if operation == "upsert":
        return service.upsert(args)
    if operation == "delete":
        return service.delete(args)
    if operation == "delete_prefix":
        return service.delete_prefix(args)
    if operation == "search":
        return service.search(args)
    if operation == "grep":
        return service.grep(args)
    if operation == "status":
        return service.status(args.get("folder"))
    if operation == "list_documents":
        return {"documents": service.list_documents(args.get("folder"))}
    if operation == "close_store":
        service.close()
        return {}
    raise ValueError(f"unknown op: {operation}")


_output_lock = threading.Lock()


def _emit(value: dict[str, Any]) -> None:
    with _output_lock:
        sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def _handle_request(service: StashbaseMFS, request: dict[str, Any]) -> None:
    request_id = request.get("id")
    operation = request.get("op")
    try:
        if not isinstance(operation, str):
            raise ValueError("request has no operation")
        args = request.get("args") or {}
        if not isinstance(args, dict):
            raise ValueError("request args must be an object")
        result = dispatch(service, operation, args)
        _emit({"id": request_id, "ok": True, "result": result})
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        _emit(
            {
                "id": request_id,
                "ok": False,
                "error": str(error),
                "error_type": type(error).__name__,
                "op": operation,
            }
        )


def _termination_signals(signal_module: Any) -> tuple[Any, ...]:
    return tuple(
        getattr(signal_module, name)
        for name in ("SIGTERM", "SIGINT", "SIGHUP")
        if hasattr(signal_module, name)
    )


def main() -> int:
    import atexit
    import signal

    parser = argparse.ArgumentParser(description="StashBase public-MFS sidecar")
    parser.add_argument("--store-root", required=True)
    parsed, _unknown = parser.parse_known_args()

    try:
        service = StashbaseMFS(parsed.store_root)
    except Exception as error:
        _emit({"event": "error", "phase": "store_init", "error": str(error)})
        return 1

    atexit.register(service.close)

    def terminate(*_args: Any) -> None:
        service.close()
        raise SystemExit(0)

    for termination_signal in _termination_signals(signal):
        try:
            signal.signal(termination_signal, terminate)
        except (OSError, ValueError):
            pass

    _emit({"event": "ready", "db": str(service.state_path)})
    futures: set[concurrent.futures.Future[None]] = set()
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=8, thread_name_prefix="stashbase-rpc"
    ) as executor:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ValueError("request must be an object")
            except (ValueError, json.JSONDecodeError) as error:
                _emit({"id": None, "ok": False, "error": f"bad request: {error}"})
                continue
            futures = {future for future in futures if not future.done()}
            futures.add(executor.submit(_handle_request, service, request))
    service.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
