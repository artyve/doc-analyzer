/**
 * Viewer for plain text and Markdown documents. Markdown arrives already
 * rendered and sanitised from the server.
 */

import { termColor } from "./colors.js";
import { applyHighlights, clearHighlights, readDocumentText } from "./domHighlight.js";
import { countMatches, findMatches } from "./matcher.js";

export function createHtmlViewer(contentEl) {
  const surface = document.createElement("article");
  surface.className = "doc-surface";
  let cursors = new Map();

  function setDocument(doc) {
    cursors = new Map();
    contentEl.replaceChildren();

    if (doc.kind === "markdown" && doc.html) {
      surface.classList.remove("is-plain");
      surface.innerHTML = doc.html;
    } else {
      surface.classList.add("is-plain");
      surface.textContent = doc.pages?.[0]?.text ?? "";
    }

    // Relative image paths cannot be resolved server-side; hide broken images
    // rather than showing a browser placeholder.
    for (const image of surface.querySelectorAll("img")) {
      image.addEventListener("error", () => image.remove(), { once: true });
      image.setAttribute("referrerpolicy", "no-referrer");
    }

    contentEl.appendChild(surface);
  }

  function updateHighlights(terms, options) {
    clearHighlights(surface);
    const { text, segments } = readDocumentText(surface);
    const matches = findMatches(text, terms, options);
    applyHighlights(segments, matches, (termId) => termColor(terms, termId, 0.65));
    return countMatches(matches);
  }

  function jumpToTerm(termId) {
    const selector = `mark.hl-mark[data-term="${CSS.escape(termId)}"]`;
    const marks = surface.querySelectorAll(selector);
    if (marks.length === 0) return false;

    const next = ((cursors.get(termId) ?? -1) + 1) % marks.length;
    cursors.set(termId, next);

    for (const active of surface.querySelectorAll("mark.is-active")) active.classList.remove("is-active");
    const mark = marks[next];
    mark.classList.add("is-active");
    mark.scrollIntoView({ block: "center", behavior: "smooth" });
    return true;
  }

  function setZoom() {
    /* text documents ignore zoom */
  }

  function fitWidth() {
    /* no-op */
  }

  function goToPage() {
    return false;
  }

  function getText() {
    return readDocumentText(surface).text;
  }

  return {
    kind: "html",
    setDocument,
    updateHighlights,
    jumpToTerm,
    setZoom,
    fitWidth,
    goToPage,
    getText,
    destroy() {
      contentEl.replaceChildren();
    },
  };
}
