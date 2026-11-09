"""On-disk storage for uploaded documents.

Each upload gets its own directory under `doc_analyzer/.uploads/<uuid>/`
containing the source file, a `meta.json` with the extracted response and any
cached page rasters. Directories are never deleted automatically; old uploads
are retained indefinitely.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

import pymupdf

from .models import DocumentKind, DocumentResponse

DEFAULT_UPLOAD_ROOT = Path(__file__).resolve().parent / ".uploads"
META_FILENAME = "meta.json"
GRAPH_FILENAME = "graph.json"
STATUS_FILENAME = "status.json"

_lock = threading.Lock()

# In-memory graph generation status registry: document_id -> "pending" | "running" | "done" | "failed"
_graph_status: dict[str, str] = {}
_graph_errors: dict[str, str | None] = {}


def upload_root() -> Path:
    """Directory used for uploads; override with DOC_ANALYZER_UPLOAD_DIR."""
    root = Path(os.environ.get("DOC_ANALYZER_UPLOAD_DIR") or DEFAULT_UPLOAD_ROOT)
    root.mkdir(parents=True, exist_ok=True)
    return root


@dataclass
class StoredDocument:
    id: str
    name: str
    kind: DocumentKind
    directory: Path
    source: str
    created: float
    response: DocumentResponse

    def page_png(self, index: int, scale: float) -> Path:
        """Rasterise page `index` (1-based) at `scale`, reusing a cached PNG."""
        cache = self.directory / f"page-{index}@{scale:.2f}.png"
        if cache.exists():
            return cache

        document = pymupdf.open(self.directory / self.source)
        try:
            if not 1 <= index <= document.page_count:
                raise IndexError(index)
            pixmap = document[index - 1].get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
            cache.parent.mkdir(parents=True, exist_ok=True)
            temp = cache.with_name(cache.name + ".tmp")
            temp.write_bytes(pixmap.tobytes("png"))
            temp.replace(cache)
        finally:
            document.close()
        return cache


def create_directory(document_id: str | None = None) -> tuple[str, Path]:
    """Reserve a fresh upload directory and return its id.

    If `document_id` is provided (content-addressed hash), use it; otherwise
    generate a random UUID.
    """
    if document_id is None:
        document_id = uuid.uuid4().hex
    directory = upload_root() / document_id
    directory.mkdir(parents=True, exist_ok=False)
    return document_id, directory


def compute_document_id(data: bytes) -> str:
    """Compute a content-addressed document id from raw bytes.

    SHA-256 hex digest: uploading the same file bytes always yields the same id,
    so re-uploads reuse the existing document and its cached graph.
    """
    return hashlib.sha256(data).hexdigest()


def register(response: DocumentResponse, directory: Path, source: str) -> StoredDocument:
    stored = StoredDocument(
        id=response.id,
        name=response.name,
        kind=response.kind,
        directory=directory,
        source=source,
        created=time.time(),
        response=response,
    )
    meta = {
        "id": stored.id,
        "name": stored.name,
        "kind": stored.kind,
        "source": stored.source,
        "created": stored.created,
        "response": response.model_dump(by_alias=True),
    }
    (directory / META_FILENAME).write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return stored


def set_graph_status(document_id: str, status: str, error: str | None = None) -> None:
    """Record the graph generation status for a document (in-memory registry)."""
    with _lock:
        _graph_status[document_id] = status
        _graph_errors[document_id] = error


def get_graph_status(document_id: str) -> tuple[str | None, str | None]:
    """Return (status, error) for a document's graph generation, or (None, None)."""
    with _lock:
        return _graph_status.get(document_id), _graph_errors.get(document_id)


def clear_graph_status(document_id: str) -> None:
    with _lock:
        _graph_status.pop(document_id, None)
        _graph_errors.pop(document_id, None)


def write_graph(document_id: str, nodes: list[dict], edges: list[dict]) -> None:
    """Persist the extracted knowledge graph to disk alongside the upload."""
    if not _is_safe_id(document_id):
        return
    directory = upload_root() / document_id
    payload = {"nodes": nodes, "edges": edges}
    (directory / GRAPH_FILENAME).write_text(json.dumps(payload, indent=2), encoding="utf-8")


def read_graph(document_id: str) -> dict | None:
    """Load a previously persisted knowledge graph from disk."""
    if not _is_safe_id(document_id):
        return None
    path = upload_root() / document_id / GRAPH_FILENAME
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def graph_exists(document_id: str) -> bool:
    if not _is_safe_id(document_id):
        return False
    return (upload_root() / document_id / GRAPH_FILENAME).exists()


def get(document_id: str) -> StoredDocument | None:
    """Load a document from memory first, then from disk after a restart."""
    if not _is_safe_id(document_id):
        return None

    directory = upload_root() / document_id
    meta_path = directory / META_FILENAME
    if not meta_path.exists():
        return None

    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        response = DocumentResponse.model_validate(meta["response"])
        stored = StoredDocument(
            id=response.id,
            name=meta["name"],
            kind=meta["kind"],
            directory=directory,
            source=meta["source"],
            created=float(meta["created"]),
            response=response,
        )
    except (KeyError, ValueError, TypeError):
        shutil.rmtree(directory, ignore_errors=True)
        return None

    return stored


def delete(document_id: str) -> bool:
    if not _is_safe_id(document_id):
        return False
    directory = upload_root() / document_id
    if not directory.exists():
        return False
    shutil.rmtree(directory, ignore_errors=True)
    # Retry if rmtree didn't fully complete (e.g. Windows file lock held by the
    # background graph-extraction thread briefly reading meta.json).
    for _ in range(20):
        if not directory.exists():
            break
        time.sleep(0.1)
        shutil.rmtree(directory, ignore_errors=True)
    clear_graph_status(document_id)
    return not directory.exists()


def _is_safe_id(document_id: str) -> bool:
    return bool(document_id) and all(c in "0123456789abcdef" for c in document_id)
