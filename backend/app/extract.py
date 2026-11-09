"""Text extraction for the three supported document kinds.

PDF  -> one entry per page with word boxes, so the viewer can draw highlights
        over the rasterised page without re-parsing anything in JavaScript.
TEXT -> a single page holding the whole file.
MD   -> sanitised HTML rendered server-side plus the plain text source.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import bleach
import markdown as markdown_lib
import pymupdf

from .models import DocumentKind, PageInfo, WordBox

# Below this many extractable characters a PDF is treated as scanned imagery.
PDF_MIN_TEXT_CHARS = 20

MD_EXTENSIONS = ["fenced_code", "tables", "sane_lists", "nl2br", "attr_list"]

MD_ALLOWED_TAGS = [
    "a", "abbr", "b", "blockquote", "br", "caption", "code", "dd", "del", "div",
    "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6",
    "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "s",
    "samp", "small", "span", "strong", "sub", "sup", "table", "tbody", "td",
    "tfoot", "th", "thead", "tr", "u", "ul", "var",
]

MD_ALLOWED_ATTRS = {
    "*": ["class", "id"],
    "a": ["href", "title", "rel"],
    "img": ["src", "alt", "title", "width", "height"],
    "th": ["align", "colspan", "rowspan"],
    "td": ["align", "colspan", "rowspan"],
    "code": ["class"],
}


class ExtractionError(Exception):
    """Raised when a file cannot be turned into something highlightable."""


@dataclass
class Extraction:
    kind: DocumentKind
    pages: list[PageInfo] = field(default_factory=list)
    html: str | None = None
    char_count: int = 0
    has_text: bool = True


def extract(path: Path, kind: DocumentKind) -> Extraction:
    """Extract `path` according to `kind`.

    Raises ExtractionError with a message that is safe to show to the user.
    """
    if kind == "pdf":
        return _extract_pdf(path)
    if kind == "markdown":
        return _extract_markdown(path)
    return _extract_text(path)


# --------------------------------------------------------------------------- PDF


def _extract_pdf(path: Path) -> Extraction:
    try:
        document = pymupdf.open(path)
    except Exception as exc:  # noqa: BLE001 - pymupdf raises a variety of errors
        raise ExtractionError("That PDF could not be opened. It may be corrupt.") from exc

    # Prefer tight per-glyph heights where available so word bboxes hug the
    # ink rather than the full line height. (A no-op on builds where the
    # toggle does not affect get_text("words"); the 3% cap in _extract_pdf_page
    # still bounds highlight height regardless.)
    pymupdf.TOOLS.set_small_glyph_heights(True)

    try:
        if document.needs_pass:
            raise ExtractionError("That PDF is password protected. Remove the password and try again.")
        if document.page_count == 0:
            raise ExtractionError("That PDF contains no pages.")

        pages = [_extract_pdf_page(page, number) for number, page in enumerate(document, start=1)]
    finally:
        document.close()

    char_count = sum(len(page.text) for page in pages)
    has_text = char_count >= PDF_MIN_TEXT_CHARS
    return Extraction(kind="pdf", pages=pages, char_count=char_count, has_text=has_text)


def _extract_pdf_page(page: "pymupdf.Page", number: int) -> PageInfo:
    width = float(page.rect.width) or 1.0
    height = float(page.rect.height) or 1.0

    chunks: list[str] = []
    words: list[WordBox] = []
    position = 0
    line_number = -1
    previous_block: int | None = None
    previous_line: int | None = None

    console_debug = [
        f"[PDF extract] page={number} width={width:.1f} height={height:.1f} rotation={page.rotation}",
    ]

    tall_count = 0
    for x0, y0, x1, y1, raw_word, block, line, _word_no in page.get_text("words"):
        text = str(raw_word).strip()
        if not text:
            continue

        if block != previous_block or line != previous_line:
            if chunks:
                separator = "\n\n" if previous_block is not None and block != previous_block else "\n"
                chunks.append(separator)
                position += len(separator)
            line_number += 1
        elif chunks:
            chunks.append(" ")
            position += 1

        chunks.append(text)

        # pymupdf's get_text("words") returns y-bboxes that span the full line
        # height (including leading/ascenders/descenders). The highlight height
        # is controlled client-side by the highlight-height multiplier (default
        # 1x the actual bbox height) in pdfViewer.js, so here we use the actual
        # bbox height unchanged.
        y_center = (float(y0) + float(y1)) / 2
        desired_h = float(y1) - float(y0)  # 1x the actual bbox height
        y0_adj = max(0.0, y_center - desired_h / 2)
        y1_adj = min(float(height), y_center + desired_h / 2)

        raw_h = float(y1_adj) - float(y0_adj)
        norm_h = raw_h / height
        if norm_h > 0.05:
            tall_count += 1
        # console_debug.append(
        #     f"[PDF extract] word={text!r} raw_bbox=[{x0:.1f},{y0:.1f},{x1:.1f},{y1:.1f}] "
        #     f"adjusted_h={raw_h:.1f}pt norm_h={norm_h:.4f} line={line_number} tall={'YES' if norm_h > 0.05 else ''}"
        # )
        words.append(
            WordBox(
                text=text,
                start=position,
                end=position + len(text),
                line=line_number,
                bbox=(
                    _clamp(float(x0) / width),
                    _clamp(float(y0_adj) / height),
                    _clamp(float(x1) / width),
                    _clamp(float(y1_adj) / height),
                ),
            )
        )
        position += len(text)
        previous_block, previous_line = block, line

    print(f"[PDF extract] tall words (>5%): {tall_count}/{len(words)}")
    for msg in console_debug[:25]:
        print(msg)
    if len(console_debug) > 25:
        print(f"[PDF extract] ... ({len(console_debug) - 25} more words)")

    return PageInfo(
        index=number,
        width=round(width, 2),
        height=round(height, 2),
        text="".join(chunks),
        words=words,
    )


def _clamp(value: float) -> float:
    return 0.0 if value < 0 else 1.0 if value > 1 else round(value, 5)


# ---------------------------------------------------------------------- Text/MD


def decode_text(data: bytes) -> str:
    """Decode a text file, preferring UTF-8 but tolerating legacy encodings."""
    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = data.decode(encoding)
        except UnicodeDecodeError:
            continue
        return text.replace("\r\n", "\n").replace("\r", "\n")
    raise ExtractionError("That file could not be decoded as text.")


def _extract_text(path: Path) -> Extraction:
    text = decode_text(path.read_bytes())
    if not text.strip():
        raise ExtractionError("That file is empty.")

    pages = [PageInfo(index=1, width=0.0, height=0.0, text=text, words=[])]
    return Extraction(kind="text", pages=pages, char_count=len(text), has_text=True)


def _extract_markdown(path: Path) -> Extraction:
    text = decode_text(path.read_bytes())
    if not text.strip():
        raise ExtractionError("That file is empty.")

    rendered = markdown_lib.markdown(text, extensions=MD_EXTENSIONS)
    cleaned = bleach.clean(
        rendered,
        tags=MD_ALLOWED_TAGS,
        attributes=MD_ALLOWED_ATTRS,
        protocols=["http", "https", "mailto"],
        strip=True,
    )
    pages = [PageInfo(index=1, width=0.0, height=0.0, text=text, words=[])]
    return Extraction(
        kind="markdown",
        pages=pages,
        html=cleaned,
        char_count=len(text),
        has_text=True,
    )
