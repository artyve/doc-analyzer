"""Pydantic response models shared by the extractor and the API layer.

Fields are serialized as camelCase so the browser side can consume them
directly. Word bounding boxes are normalised to 0..1 relative to their page,
which keeps the client free of DPI/zoom arithmetic.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

DocumentKind = Literal["pdf", "text", "markdown"]


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class WordBox(ApiModel):
    """A single PDF word together with its character offsets and rectangle."""

    text: str
    start: int
    end: int
    line: int
    bbox: tuple[float, float, float, float]


class PageInfo(ApiModel):
    index: int
    width: float
    height: float
    text: str
    words: list[WordBox]


class DocumentResponse(ApiModel):
    id: str
    name: str
    kind: DocumentKind
    page_count: int
    has_text: bool
    char_count: int
    pages: list[PageInfo]
    html: str | None = None


class HealthResponse(ApiModel):
    status: str
    version: str


class GraphNode(ApiModel):
    """A single node in the knowledge graph: a thing extracted from the document."""

    id: str
    label: str
    type: str = "Thing"
    x: float | None = None
    y: float | None = None


class GraphEdge(ApiModel):
    """A single directed edge: a semantic relationship between two nodes."""

    source: str
    target: str
    relation: str = "related_to"
    dx: float | None = None
    dy: float | None = None


class GraphResponse(ApiModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]
