/**
 * Word matching.
 *
 * All enabled terms are compiled into one alternation regex, longest term
 * first, so a single pass over the text yields non-overlapping matches:
 * "net interest income" wins over "income" when both are listed.
 *
 * Multi-word terms join on \s+ so a phrase still matches when the document
 * wraps it across a line or a PDF text run.
 *
 * Matches are returned as character offsets, which both viewers translate
 * into DOM ranges (text/Markdown) or word boxes (PDF).
 */

export const DEFAULT_OPTIONS = {
  caseSensitive: false,
  wholeWord: true,
};

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(value) {
  return value.replace(REGEX_SPECIALS, "\\$&");
}

function termPattern(word) {
  return word
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeRegExp)
    .join("\\s+");
}

function activeTerms(terms) {
  return (Array.isArray(terms) ? terms : []).filter(
    (term) => term && term.enabled !== false && typeof term.word === "string" && term.word.trim().length > 0,
  );
}

/**
 * @returns {{ termId: string, start: number, end: number }[]}
 */
export function findMatches(text, terms, options = {}) {
  const settings = { ...DEFAULT_OPTIONS, ...options };
  const usable = activeTerms(terms);
  if (!text || usable.length === 0) return [];

  const ordered = [...usable].sort((a, b) => b.word.trim().length - a.word.trim().length);
  const alternatives = ordered.map((term, index) => `(?<t${index}>${termPattern(term.word)})`).join("|");

  const startBoundary = settings.wholeWord ? "(?<![\\p{L}\\p{N}_])" : "";
  const endBoundary = settings.wholeWord ? "(?![\\p{L}\\p{N}_])" : "";
  const flags = `${settings.caseSensitive ? "g" : "gi"}u`;

  let regex;
  try {
    regex = new RegExp(`${startBoundary}(?:${alternatives})${endBoundary}`, flags);
  } catch {
    // A pathological term (e.g. unbalanced surrogate) should not break the app.
    return [];
  }

  const matches = [];
  for (const match of text.matchAll(regex)) {
    const groups = match.groups ?? {};
    const key = Object.keys(groups).find((name) => groups[name] !== undefined);
    if (!key) continue;
    const term = ordered[Number(key.slice(1))];
    if (!term) continue;
    matches.push({
      termId: term.id,
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }
  return matches;
}

/** Convenience wrapper returning counts for the sidebar badges. */
export function countMatches(matches) {
  const counts = new Map();
  for (const match of matches) {
    counts.set(match.termId, (counts.get(match.termId) ?? 0) + 1);
  }
  return counts;
}
