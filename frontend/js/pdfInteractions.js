import { pct } from "./pdfLayers.js";

/** Handle native text selection changes. Finds the exact rectangles of the
  *  current selection and renders them as custom highlights. This provides
  *  character-level granularity while using the custom color/style. */
export function setupInteractions(contentEl, entriesProvider) {
  let selectionFrame = 0;

  function clearSelectionHighlights() {
    const entries = entriesProvider();
    for (const entry of entries) {
      for (const hl of entry.hlLayer.querySelectorAll(".sel-hl")) {
        hl.remove();
      }
    }
  }

  function handleSelectionChange() {
    if (selectionFrame) cancelAnimationFrame(selectionFrame);
    selectionFrame = requestAnimationFrame(() => {
      selectionFrame = 0;
      const selection = window.getSelection();
      
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        clearSelectionHighlights();
        return;
      }

      const range = selection.getRangeAt(0);
      if (!contentEl.contains(range.commonAncestorContainer)) {
        clearSelectionHighlights();
        return;
      }

      clearSelectionHighlights();

      const entries = entriesProvider();
      for (const entry of entries) {
        if (!range.intersectsNode(entry.textLayer)) continue;

        const pageRect = entry.el.getBoundingClientRect();
        const frag = document.createDocumentFragment();
        
        const selectedSpans = [...entry.textLayer.querySelectorAll(".tw")].filter(tw => 
          selection.containsNode(tw, true)
        );

        for (const span of selectedSpans) {
          const wordRange = document.createRange();
          wordRange.selectNodeContents(span);
          const intersectRange = document.createRange();
          
          if (range.compareBoundaryPoints(Range.START_TO_START, wordRange) <= 0) {
            intersectRange.setStart(wordRange.startContainer, wordRange.startOffset);
          } else {
            intersectRange.setStart(range.startContainer, range.startOffset);
          }
          
          if (range.compareBoundaryPoints(Range.END_TO_END, wordRange) >= 0) {
            intersectRange.setEnd(wordRange.endContainer, wordRange.endOffset);
          } else {
            intersectRange.setEnd(range.endContainer, range.endOffset);
          }

          if (!intersectRange.collapsed) {
            const rects = intersectRange.getClientRects();
            for (const rect of rects) {
              const highlight = document.createElement("div");
              highlight.className = "sel-hl";
              highlight.style.left = pct((rect.left - pageRect.left) / pageRect.width);
              highlight.style.top = pct((rect.top - pageRect.top) / pageRect.height);
              highlight.style.width = pct(rect.width / pageRect.width);
              highlight.style.height = pct(rect.height / pageRect.height);
              frag.appendChild(highlight);
            }
          }
        }
        entry.hlLayer.appendChild(frag);
      }
    });
  }

  function handleCopy(event) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!contentEl.contains(range.commonAncestorContainer)) return;

    const parts = [];
    const entries = entriesProvider();
    for (const entry of entries) {
      const selected = [...entry.textLayer.querySelectorAll(".tw")].filter((tw) => {
        if (!selection.containsNode(tw, true)) return false;
        if (range.startContainer === tw || tw.contains(range.startContainer)) {
          if (range.startOffset >= tw.textContent.length) return false;
        }
        if (range.endContainer === tw || tw.contains(range.endContainer)) {
          if (range.endOffset <= 0) return false;
        }
        return true;
      });
      if (selected.length === 0) continue;

      const firstTw = selected[0];
      const lastTw = selected[selected.length - 1];
      let start = Number(firstTw.dataset.start);
      let end = Number(lastTw.dataset.end);

      if (range.startContainer === firstTw || firstTw.contains(range.startContainer)) {
        start += range.startOffset;
      }
      if (range.endContainer === lastTw || lastTw.contains(range.endContainer)) {
        end = Number(lastTw.dataset.start) + range.endOffset;
      }

      parts.push(entry.page.text.slice(start, end));
    }

    if (parts.length === 0) return;
    event.clipboardData.setData("text/plain", parts.join("\n\n"));
    event.preventDefault();
  }

  document.addEventListener("selectionchange", handleSelectionChange);
  contentEl.addEventListener("copy", handleCopy);

  return {
    destroy() {
      if (selectionFrame) cancelAnimationFrame(selectionFrame);
      document.removeEventListener("selectionchange", handleSelectionChange);
      contentEl.removeEventListener("copy", handleCopy);
    },
    clearSelectionHighlights
  };
}
