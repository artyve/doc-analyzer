"""FastAPI application: document upload/extraction API plus the static UI."""

from __future__ import annotations

import logging
import os
import shutil
import tempfile
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from dotenv import load_dotenv
from fastapi import Body, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, extract, storage
from .graph_extractor import extract_graph, generate_and_persist
from .models import (
    DocumentKind,
    DocumentResponse,
    GraphResponse,
    HealthResponse,
    PageInfo,
)

# Load .env from the project root so OPENROUTER_API_KEY etc. are available.
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

# --------------------------------------------------------------------------- #
# Logging: write all back-end logs to logs/doc_analyzer.log plus stdout.      #
# --------------------------------------------------------------------------- #
LOG_DIR = Path(__file__).resolve().parent / "logs"
LOG_FILE = LOG_DIR / "doc_analyzer.log"


def setup_logging() -> None:
    """Configure root logging to file + stdout; capture uvicorn logs too."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    log_format = logging.Formatter(
        fmt="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)

    # File handler
    file_handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
    file_handler.setFormatter(log_format)
    root_logger.addHandler(file_handler)

    # Console handler
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(log_format)
    root_logger.addHandler(console_handler)

    # Capture uvicorn access/error logs into the same file.
    for logger_name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uvicorn_logger = logging.getLogger(logger_name)
        uvicorn_logger.handlers = []
        uvicorn_logger.propagate = True


setup_logging()


WEB_DIR = Path(__file__).resolve().parent / "web"
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
probe_logger = logging.getLogger("uvicorn.error")

# Paths a local-LLM discovery client probes (vLLM's default port is 8000).
PROBE_PATHS = ("/health", "/v1/models")

SUFFIXES: dict[str, DocumentKind] = {
    ".pdf": "pdf",
    ".txt": "text",
    ".text": "text",
    ".md": "markdown",
    ".markdown": "markdown",
}


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    yield


app = FastAPI(
    title="Document Word Highlighter",
    version=__version__,
    description="Upload a document and highlight a configurable list of words.",
    lifespan=lifespan,
)


@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__)


@app.middleware("http")
async def identify_probe_source(request: Request, call_next):
    """When DOC_ANALYZER_LOG_PROBES is set, record who is probing model-server paths."""
    response = await call_next(request)
    if request.url.path in PROBE_PATHS and os.environ.get("DOC_ANALYZER_LOG_PROBES"):
        probe_logger.warning(
            "probe %s from %s user-agent=%r referer=%r",
            request.url.path,
            request.client.host if request.client else "unknown",
            request.headers.get("user-agent"),
            request.headers.get("referer"),
        )
    return response


@app.post("/api/documents", response_model=DocumentResponse, status_code=201)
async def upload_document(file: Annotated[UploadFile, File()]) -> DocumentResponse:
    filename = Path(file.filename or "").name
    suffix = Path(filename).suffix.lower()

    if suffix not in SUFFIXES:
        supported = ", ".join(sorted(SUFFIXES))
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type '{suffix or filename}'. Supported: {supported}.",
        )

    # Read the full upload into memory (capped at 50 MB) so we can compute a
    # content-addressed id and detect re-uploads of the same file.
    data = await file.read()
    await file.close()

    if len(data) == 0:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.",
        )

    document_id = storage.compute_document_id(data)

    # Re-upload of the same bytes: return the existing document without
    # re-extracting text or spawning a redundant graph extraction.
    existing = storage.get(document_id)
    if existing is not None:
        return existing.response

    kind = SUFFIXES[suffix]
    directory = storage.upload_root() / document_id
    directory.mkdir(parents=True, exist_ok=False)
    destination = directory / f"source{suffix}"
    destination.write_bytes(data)

    try:
        result = extract.extract(destination, kind)
    except extract.ExtractionError as exc:
        shutil.rmtree(directory, ignore_errors=True)
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    response = DocumentResponse(
        id=document_id,
        name=filename,
        kind=result.kind,
        page_count=len(result.pages),
        has_text=result.has_text,
        char_count=result.char_count,
        pages=result.pages,
        html=result.html,
    )

    storage.register(response, directory, destination.name)

    # Kick off knowledge graph extraction in the background so the upload
    # response returns immediately. The LLM work runs off the request thread.
    threading.Thread(
        target=generate_and_persist, args=(document_id,), daemon=True, name=f"graph-{document_id}"
    ).start()

    return response





@app.get("/api/documents/{document_id}/pages/{index}.png")
def document_page_image(
    document_id: str,
    index: int,
    scale: float = Query(default=2.0, ge=0.5, le=4.0),
) -> FileResponse:
    document = storage.get(document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found or expired. Upload it again.")
    if document.kind != "pdf":
        raise HTTPException(status_code=404, detail="Only PDF documents have page images.")

    try:
        path = document.page_png(index, scale)
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=f"Page {index} does not exist.") from exc
    except Exception as exc:  # noqa: BLE001 - rendering failures are user-visible
        raise HTTPException(status_code=500, detail="That page could not be rendered.") from exc

    return FileResponse(
        path,
        media_type="image/png",
        headers={"Cache-Control": "private, max-age=86400"},
    )


@app.delete("/api/documents/{document_id}", status_code=204)
def delete_document(document_id: str) -> None:
    if not storage.delete(document_id):
        raise HTTPException(status_code=404, detail="Document not found.")


@app.get("/api/documents/{document_id}/pages", response_model=list[PageInfo])
def document_pages(document_id: str) -> list[PageInfo]:
    document = storage.get(document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found or expired. Upload it again.")
    return document.response.pages


@app.post("/api/documents/{document_id}/graph", response_model=GraphResponse)
def document_graph(document_id: str) -> GraphResponse:
    """Extract or return the knowledge graph for an uploaded document.

    Graph generation is triggered automatically on upload (background thread).
    This endpoint returns the cached graph when done, a 202 while running,
    a 502 on failure, or generates synchronously as a fallback (e.g. after a
    server restart wiped the in-memory status).
    """
    document = storage.get(document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found or expired. Upload it again.")

    text = "\n\n".join(page.text for page in document.response.pages)
    if not text.strip():
        raise HTTPException(status_code=400, detail="No text found in this document.")

    status, error = storage.get_graph_status(document_id)
    if status == "done":
        cached = storage.read_graph(document_id)
        if cached:
            return GraphResponse(**cached)
    # Server restart wiped the in-memory registry: return a cached graph from
    # disk if one already exists, instead of regenerating it.
    if status is None and storage.graph_exists(document_id):
        cached = storage.read_graph(document_id)
        if cached:
            storage.set_graph_status(document_id, "done")
            return GraphResponse(**cached)
    if status == "running":
        raise HTTPException(status_code=202, detail="Graph generation is in progress.")
    if status == "failed":
        raise HTTPException(status_code=502, detail=error or "Graph generation failed.")

    # Not started yet — generate synchronously as a fallback.
    try:
        result = extract_graph(text)
        storage.write_graph(document_id, result["nodes"], result["edges"])
        storage.set_graph_status(document_id, "done")
        return GraphResponse(**result)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - LLM failures are user-visible
        storage.set_graph_status(document_id, "failed", str(exc))
        raise HTTPException(status_code=502, detail="The knowledge graph could not be generated.") from exc


@app.get("/api/documents/{document_id}/graph/exists")
def graph_exists(document_id: str) -> dict[str, bool]:
    """Return whether a knowledge graph has already been persisted for this document."""
    return {"exists": storage.graph_exists(document_id)}


@app.post("/api/documents/{document_id}/graph/layout")
def save_graph_layout(
    document_id: str,
    nodes: list[dict] = Body(...),
    edges: list[dict] = Body(...),
) -> dict[str, bool]:
    """Persist node positions and edge offsets to graph.json."""
    document = storage.get(document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found or expired.")
    storage.write_graph(document_id, nodes, edges)
    return {"saved": True}


@app.get("/api/documents/{document_id}/graph/status")
def graph_status(document_id: str) -> dict[str, str | None]:
    """Return the current graph generation status for a document."""
    document = storage.get(document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found or expired. Upload it again.")

    status, error = storage.get_graph_status(document_id)
    # Server restart wiped the in-memory registry: recover from disk if possible.
    if status is None:
        if storage.graph_exists(document_id):
            status = "done"
        else:
            status = "not_started"
    return {"status": status, "error": error}


@app.get("/api/documents/{document_id}/graph", response_model=GraphResponse)
def get_graph(document_id: str) -> GraphResponse:
    """Return a previously generated knowledge graph from disk cache."""
    document = storage.get(document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found or expired. Upload it again.")

    status, error = storage.get_graph_status(document_id)
    if status == "done":
        cached = storage.read_graph(document_id)
        if cached:
            return GraphResponse(**cached)
    # Server restart wiped the in-memory registry: return a cached graph from
    # disk if one already exists, instead of regenerating it.
    if status is None and storage.graph_exists(document_id):
        cached = storage.read_graph(document_id)
        if cached:
            storage.set_graph_status(document_id, "done")
            return GraphResponse(**cached)
    if status == "running":
        raise HTTPException(status_code=202, detail="Graph generation is in progress.")
    if status == "failed":
        raise HTTPException(status_code=502, detail=error or "Graph generation failed.")

    # Not started yet — generate synchronously.
    text = "\n\n".join(page.text for page in document.response.pages)
    if not text.strip():
        raise HTTPException(status_code=400, detail="No text found in this document.")
    try:
        result = extract_graph(text)
        storage.write_graph(document_id, result["nodes"], result["edges"])
        storage.set_graph_status(document_id, "done")
        return GraphResponse(**result)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - LLM failures are user-visible
        storage.set_graph_status(document_id, "failed", str(exc))
        raise HTTPException(status_code=502, detail="The knowledge graph could not be generated.") from exc


# Mounted last so every /api route above wins over the static catch-all.
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
