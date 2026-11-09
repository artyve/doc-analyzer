"""Knowledge graph extraction from document text using an LLM via OpenRouter.

Uses langchain's LLMGraphTransformer to extract entities (nodes) and semantic
relationships (edges) from the document text. Long documents are split into
chunks so each stays within the model's context window; results are merged
across chunks by node id.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

from langchain_core.documents import Document
from langchain_experimental.graph_transformers.llm import LLMGraphTransformer
from langchain_openrouter import ChatOpenRouter
from langchain_text_splitters import RecursiveCharacterTextSplitter

logger = logging.getLogger(__name__)

# Chunk size tuned to leave room for the prompt and the model's response.
CHUNK_SIZE = 3500
CHUNK_OVERLAP = 200


def _get_llm() -> ChatOpenRouter:
    """Build the OpenRouter chat model, raising if the API key is missing."""
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise ValueError("OPENROUTER_API_KEY is not set in the environment.")
    model = os.getenv("OPENROUTER_MODEL", "openrouter/auto")
    return ChatOpenRouter(api_key=api_key, model=model)


def extract_graph(text: str) -> dict[str, Any]:
    """Extract a knowledge graph from `text`.

    Returns ``{"nodes": [...], "edges": [...]}`` where nodes are things
    (people, places, entities, objects) and edges are semantic relationships.
    """
    if not text or not text.strip():
        return {"nodes": [], "edges": []}

    llm = _get_llm()
    transformer = LLMGraphTransformer(llm=llm)

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP
    )
    chunks = splitter.split_text(text)

    merged_nodes: dict[str, dict[str, Any]] = {}
    merged_edges: list[dict[str, Any]] = []

    for chunk_index, chunk in enumerate(chunks, start=1):
        if not chunk.strip():
            continue
        logger.info(
            "Graph extraction chunk %d/%d: sending to LLM (%d chars)",
            chunk_index,
            len(chunks),
            len(chunk),
        )
        chunk_start = time.time()
        docs = [Document(page_content=chunk)]
        graph_docs = transformer.convert_to_graph_documents(docs)
        chunk_elapsed = time.time() - chunk_start
        node_count = sum(len(gd.nodes) for gd in graph_docs)
        edge_count = sum(len(gd.relationships) for gd in graph_docs)
        logger.info(
            "Graph extraction chunk %d/%d complete in %.2fs: %d nodes, %d edges",
            chunk_index,
            len(chunks),
            chunk_elapsed,
            node_count,
            edge_count,
        )
        for graph_doc in graph_docs:
            for node in graph_doc.nodes:
                node_id = str(node.id)
                if node_id not in merged_nodes:
                    merged_nodes[node_id] = {
                        "id": node_id,
                        "label": node_id,
                        "type": node.type or "Thing",
                    }
            for relationship in graph_doc.relationships:
                merged_edges.append(
                    {
                        "source": str(relationship.source.id),
                        "target": str(relationship.target.id),
                        "relation": relationship.type or "related_to",
                    }
                )

    return {"nodes": list(merged_nodes.values()), "edges": merged_edges}


def generate_and_persist(document_id: str) -> None:
    """Background task: extract a knowledge graph from a stored document and persist it to disk.

    Runs off the FastAPI request thread so the upload response returns immediately.
    Updates the in-memory status registry so the frontend can poll for completion.
    """
    from .storage import get as storage_get, get_graph_status, set_graph_status, write_graph

    try:
        # Avoid duplicate work if a generation is already running or already done.
        status, _ = get_graph_status(document_id)
        if status in ("running", "done"):
            return

        document = storage_get(document_id)
        if document is None:
            set_graph_status(document_id, "failed", "Document not found or expired.")
            logger.error("Graph extraction failed for document %s: not found or expired", document_id)
            return

        text = "\n\n".join(page.text for page in document.response.pages)
        if not text.strip():
            set_graph_status(document_id, "failed", "No text found in this document.")
            logger.error("Graph extraction failed for document %s: no text found", document_id)
            return

        set_graph_status(document_id, "running")
        logger.info(
            "Graph extraction starting for document %s (%d characters, %d pages)",
            document_id,
            len(text),
            len(document.response.pages),
        )

        extraction_start = time.time()
        result = extract_graph(text)
        extraction_elapsed = time.time() - extraction_start

        write_graph(document_id, result["nodes"], result["edges"])
        set_graph_status(document_id, "done")
        logger.info(
            "Graph extraction complete for document %s: %d nodes, %d edges in %.2fs",
            document_id,
            len(result["nodes"]),
            len(result["edges"]),
            extraction_elapsed,
        )
    except Exception as exc:  # noqa: BLE001 - background failures are recorded in the status registry
        set_graph_status(document_id, "failed", str(exc))
        logger.exception("Graph extraction failed for document %s: %s", document_id, exc)
