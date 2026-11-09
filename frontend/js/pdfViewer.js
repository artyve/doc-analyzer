/**
 * PDF viewer.
 *
 * Pages are rasterised server-side; the client only needs the word boxes that
 * came back with the document. Three stacked layers per page:
 *
 *   img.page-img    the rendered page
 *   .hl-layer       translucent highlight rectangles (blend: multiply)
 *   .text-layer     invisible word spans so text stays selectable/copyable
 *
 * All geometry is stored as percentages of the page box, so zooming is a pure
 * CSS width change with no re-render and no rounding drift.
 */

import { termColor } from "./colors.js";
import { countMatches, findMatches } from "./matcher.js";
import { pct, buildPage, buildTextLayer, buildDebugLayer } from "./pdfLayers.js";
import { setupInteractions } from "./pdfInteractions.js";

const PAGE_BASE_WIDTH = 760;
const RASTER_SCALE = 2;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 4;

export function createPdfViewer(contentEl, scrollEl, hooks = {}) {
  const onPage = hooks.onPage ?? (() => {});
  const onZoom = hooks.onZoom ?? (() => {});
  const onImageError = hooks.onImageError ?? (() => {});

  let doc = null;
  let zoom = 1;
  let pagesEl = null;
  let entries = [];
  let matchIndex = [];
  let cursors = new Map();
  let active = [];
  let scrollQueued = false;
  let destroyed = false;
  let highlightMultiplier = 1;
  let lastTerms = null;
  let lastOptions = null;

  function setDocument(nextDoc) {
    doc = nextDoc;
    cursors = new Map();
    active = [];
    matchIndex = [];
    contentEl.replaceChildren();

    pagesEl = document.createElement("div");
    pagesEl.className = "pdf-pages";
    pagesEl.style.setProperty("--zoom", String(zoom));
    contentEl.appendChild(pagesEl);

    entries = doc.pages.map((page, pageIndex) => buildPage(doc.id, page, pageIndex, { onImageError }));
    for (const entry of entries) pagesEl.appendChild(entry.el);

    fitWidthValue();
    applyZoom();
    scrollEl.scrollTop = 0;
    
    // Hydrate the first few pages immediately
    for (let i = 0; i < Math.min(3, entries.length); i++) {
      if (!entries[i].textBuilt) {
        buildTextLayer(entries[i].page, entries[i].textLayer);
        entries[i].textBuilt = true;
      }
    }

    if (entries.length > 0) onPage(entries[0].page.index, entries.length);
  }

  /** Union of word boxes per text line for one match. */
  // words: [{start, end, bbox, line, text}, ...]
  // match: {start, end, termId}
  function rectsForMatch(words, match) {
    let low = 0;
    let high = words.length - 1; 
    let first = -1;
    
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (words[mid].end > match.start) {
        first = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    if (first < 0) return [];

    const boxes = new Map();
    console.log("[PDF highlight] match start/end:", match.start, match.end);
    for (let i = first; i < words.length && words[i].start < match.end; i += 1) {
      const word = words[i];
      if (word.end <= match.start) continue;
      const [x0, y0, x1, y1] = word.bbox;
      console.log(
        `[PDF highlight] word "${word.text}" line=${word.line} bbox=[${x0.toFixed(4)},${y0.toFixed(4)},${x1.toFixed(4)},${y1.toFixed(4)}] h=${(y1 - y0).toFixed(4)}`
      );
      const box = boxes.get(word.line);
      if (!box) {
        boxes.set(word.line, { x0, y0, x1, y1 });
      } else {
        box.x0 = Math.min(box.x0, x0);
        box.y0 = Math.min(box.y0, y0);
        box.x1 = Math.max(box.x1, x1);
        box.y1 = Math.max(box.y1, y1);
      }
    }

    const rects = [...boxes.values()].map((box) => {
      // Scale the highlight height by the client-controlled multiplier, centred
      // on the box's vertical centre (default 1x the bbox height, range 0.1x-2x).
      const centreY = (box.y0 + box.y1) / 2;
      const h = Math.max(box.y1 - box.y0, 0) * highlightMultiplier;
      return {
        x0: Math.max(0, box.x0 - 0.0012),
        y0: Math.max(0, centreY - h / 2 - 0.002),
        x1: Math.min(1, box.x1 + 0.0012),
        y1: Math.min(1, centreY + h / 2 + 0.002),
      };
    });
    console.log(
      "[PDF highlight] rects:",
      rects.map((r) => `[${r.x0.toFixed(4)},${r.y0.toFixed(4)},${r.x1.toFixed(4)},${r.y1.toFixed(4)}] h=${(r.y1 - r.y0).toFixed(4)}`)
    );
    return rects;
  }

  function updateHighlights(terms, options) {
    lastTerms = terms;
    lastOptions = options;
    matchIndex = [];
    active = [];
    const counts = new Map();

    for (const entry of entries) {
      entry.hlLayer.replaceChildren();
      entry.matches = findMatches(entry.page.text, terms, options);

      const pageCounts = countMatches(entry.matches);
      for (const [termId, count] of pageCounts) {
        counts.set(termId, (counts.get(termId) ?? 0) + count);
      }

      entry.matches.forEach((match, index) => {
        const rects = rectsForMatch(entry.page.words, match);
        if (rects.length === 0) return;

        const color = termColor(terms, match.termId, 0.55);
        let top = 1;
        for (const rect of rects) {
          const highlight = document.createElement("div");
          highlight.className = "hl";
          highlight.dataset.term = match.termId;
          highlight.dataset.index = String(index);
          highlight.style.left = pct(rect.x0);
          highlight.style.top = pct(rect.y0);
          highlight.style.width = pct(rect.x1 - rect.x0);
          highlight.style.height = pct(rect.y1 - rect.y0);
          highlight.style.backgroundColor = color;
          entry.hlLayer.appendChild(highlight);
          top = Math.min(top, rect.y0);
        }

        matchIndex.push({ pageIndex: entry.pageIndex, index, termId: match.termId, top });
      });
    }

    return counts;
  }

  function jumpToTerm(termId) {
    const candidates = matchIndex.filter((item) => item.termId === termId);
    if (candidates.length === 0) return false;

    const next = ((cursors.get(termId) ?? -1) + 1) % candidates.length;
    cursors.set(termId, next);
    const target = candidates[next];
    const entry = entries[target.pageIndex];
    if (!entry) return false;

    for (const element of active) element.classList.remove("is-active");
    active = [...entry.hlLayer.querySelectorAll(`.hl[data-index="${target.index}"]`)];
    for (const element of active) element.classList.add("is-active");

    scrollToEntry(entry, target.top);
    return true;
  }

  function scrollToEntry(entry, normalisedTop = 0) {
    const pageRect = entry.el.getBoundingClientRect();
    const containerRect = scrollEl.getBoundingClientRect();
    const offsetInPage = normalisedTop * pageRect.height;
    const top = pageRect.top - containerRect.top + scrollEl.scrollTop + offsetInPage - scrollEl.clientHeight * 0.35;
    scrollEl.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }

  function goToPage(index) {
    if (!entries.length) return false;
    const entry = entries[Math.min(Math.max(index, 1), entries.length) - 1];
    if (!entry) return false;
    scrollToEntry(entry, 0);
    return true;
  }

  function fitWidthValue() {
    const available = scrollEl.clientWidth - 48;
    if (available <= 0) return 1;
    return clampZoom(available / PAGE_BASE_WIDTH);
  }

  function clampZoom(value) {
    if (!Number.isFinite(value)) return 1;
    return Math.min(Math.max(value, MIN_ZOOM), MAX_ZOOM);
  }

  function applyZoom() {
    if (pagesEl) pagesEl.style.setProperty("--zoom", String(zoom));
    onZoom(zoom);
  }

  function setZoom(value) {
    zoom = clampZoom(value);
    applyZoom();
  }

  function setHighlightMultiplier(value) {
    const next = Math.min(Math.max(Number(value), 0.1), 2.0);
    if (!Number.isFinite(next)) return highlightMultiplier;
    highlightMultiplier = next;
    // Re-render existing highlights at the new height without re-sending terms.
    if (lastTerms) updateHighlights(lastTerms, lastOptions);
    return highlightMultiplier;
  }

  function fitWidth() {
    setZoom(fitWidthValue());
  }

  function handleScroll() {
    if (scrollQueued || destroyed || entries.length === 0) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      if (destroyed || entries.length === 0) return;
      const containerTop = scrollEl.getBoundingClientRect().top;
      const probe = containerTop + scrollEl.clientHeight * 0.35;
      
      // The viewport range for hydration (current view + buffer)
      const viewTop = scrollEl.scrollTop;
      const viewBottom = viewTop + scrollEl.clientHeight;
      const buffer = scrollEl.clientHeight * 1.5;

      let current = entries[0];
      for (const entry of entries) {
        const rect = entry.el.getBoundingClientRect();
        if (rect.top <= probe) current = entry;
        
        // Lazy-hydration: build text layer if the page is near the viewport
        const pageTop = entry.el.offsetTop;
        const pageBottom = pageTop + entry.el.offsetHeight;
        
        if (!entry.textBuilt && pageBottom >= viewTop - buffer && pageTop <= viewBottom + buffer) {
          buildTextLayer(entry.page, entry.textLayer);
          entry.textBuilt = true;
          
          // Also hydrate debug boxes if they are currently toggled on
          if (pagesEl.classList.contains("debug-visible")) {
            buildDebugLayer(entry);
          }
        }
      }
      onPage(current.page.index, entries.length);
    });
  }

  /** Reconstruct copied text with the original spacing/newlines. The text
   *  layer's spans hold bare words (no inter-word spaces), so native copy would
   *  concatenate them. Instead, slice the source page text between the first
   *  and last selected word. */

  scrollEl.addEventListener("scroll", handleScroll, { passive: true });
  const interactions = setupInteractions(contentEl, () => entries);

  return {
    kind: "pdf",
    setDocument,
    updateHighlights,
    jumpToTerm,
    goToPage,
    setZoom,
    fitWidth,
    setHighlightMultiplier,
    toggleBBoxes(visible) {
      pagesEl?.classList.toggle("debug-visible", visible);
      if (visible) {
        // Hydrate debug boxes for visible pages immediately
        for (const entry of entries) {
          if (entry.textBuilt && !entry.debugBuilt) {
            buildDebugLayer(entry);
          }
        }
      }
    },
    toggleInteractive(enabled) {
      pagesEl?.classList.toggle("text-enabled", enabled);
    },
    getZoom: () => zoom,
    getPageCount: () => entries.length,
    getText() {
      return doc ? doc.pages.map((page) => page.text).join("\n\n") : "";
    },
    destroy() {
      destroyed = true;
      interactions.destroy();
      scrollEl.removeEventListener("scroll", handleScroll);
      contentEl.replaceChildren();
      entries = [];
      matchIndex = [];
    },
  };
}
