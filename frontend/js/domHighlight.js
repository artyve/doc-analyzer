/**
 * Highlighting inside rendered HTML (plain text and Markdown).
 *
 * Strategy: flatten the surface's text nodes into one string while keeping a
 * map back to (node, offset), run the matcher once over that string, then wrap
 * each match in a <mark>. Matches are applied right-to-left so splitting text
 * nodes never invalidates offsets that have not been processed yet.
 *
 * A paragraph break is injected between block-level elements so a phrase
 * cannot accidentally match across two unrelated paragraphs.
 */

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "SELECT"]);
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIGCAPTION",
  "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR",
  "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY", "TD", "TFOOT",
  "TH", "THEAD", "TR", "UL",
]);

function closestBlock(node) {
  let element = node.parentElement;
  while (element && !BLOCK_TAGS.has(element.tagName)) {
    element = element.parentElement;
  }
  return element;
}

/**
 * @returns {{ text: string, segments: { node: Text, start: number, end: number }[] }}
 */
export function readDocumentText(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.closest("[data-highlight]")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const segments = [];
  let text = "";
  let previousBlock = null;
  let node = walker.nextNode();

  while (node) {
    const block = closestBlock(node);
    if (previousBlock && block && block !== previousBlock) text += "\n\n";
    const start = text.length;
    text += node.nodeValue;
    segments.push({ node, start, end: text.length });
    previousBlock = block ?? previousBlock;
    node = walker.nextNode();
  }

  return { text, segments };
}

export function clearHighlights(root) {
  const marks = root.querySelectorAll("mark[data-highlight]");
  if (marks.length === 0) return;
  for (const mark of marks) {
    mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
  }
  root.normalize();
}

/**
 * Wrap every match in a <mark>. `resolveColor(termId)` returns a CSS colour.
 */
export function applyHighlights(segments, matches, resolveColor) {
  if (segments.length === 0 || matches.length === 0) return;

  for (let m = matches.length - 1; m >= 0; m -= 1) {
    const match = matches[m];
    for (let s = segments.length - 1; s >= 0; s -= 1) {
      const segment = segments[s];
      if (segment.end <= match.start) break;
      if (segment.start >= match.end) continue;

      const node = segment.node;
      if (!node.isConnected) continue;

      const length = node.nodeValue?.length ?? 0;
      const localStart = Math.min(Math.max(0, match.start - segment.start), length);
      const localEnd = Math.min(Math.max(0, match.end - segment.start), length);
      if (localEnd <= localStart) continue;

      if (localEnd < length) node.splitText(localEnd);
      const target = localStart > 0 ? node.splitText(localStart) : node;

      const mark = document.createElement("mark");
      mark.className = "hl-mark";
      mark.dataset.highlight = "";
      mark.dataset.term = match.termId;
      mark.style.backgroundColor = resolveColor(match.termId);

      target.replaceWith(mark);
      mark.appendChild(target);
    }
  }
}
