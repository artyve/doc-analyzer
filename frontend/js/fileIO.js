/**
 * Import/export of the word list as JSON.
 *
 * Shape (version 1):
 *   { "version": 1, "options": {...}, "terms": [{ "word", "color", "enabled" }] }
 *
 * A plain array of words is also accepted so hand-written files work.
 */

import { isHexColor } from "./colors.js";

export const FILE_VERSION = 1;

export function buildPayload(state) {
  return {
    version: FILE_VERSION,
    app: "doc-analyzer",
    exportedAt: new Date().toISOString(),
    options: { ...state.options },
    terms: state.terms.map((term) => ({
      word: term.word,
      color: term.color,
      enabled: term.enabled,
    })),
  };
}

export function downloadPayload(payload, filename) {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportFilename(documentName) {
  const stamp = new Date().toISOString().slice(0, 10);
  const base = String(documentName ?? "")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base ? `${base}-words-${stamp}.json` : `highlight-words-${stamp}.json`;
}

/**
 * @returns {{ terms: {word: string, color: string|null, enabled: boolean, id?: string}[], options: object|undefined, total: number }}
 */
export function parseTermFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON.");
  }

  const rawTerms = Array.isArray(data)
    ? data
    : Array.isArray(data?.terms)
      ? data.terms
      : null;

  if (!rawTerms) {
    throw new Error('That JSON has no "terms" array.');
  }

  const seen = new Set();
  const terms = [];

  for (const raw of rawTerms) {
    const word = typeof raw === "string" ? raw : typeof raw?.word === "string" ? raw.word : "";
    const trimmed = word.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    terms.push({
      word: trimmed,
      color: isHexColor(raw?.color) ? raw.color.toLowerCase() : null,
      enabled: raw?.enabled !== false,
      id: typeof raw?.id === "string" && raw.id ? raw.id : undefined,
    });
  }

  if (terms.length === 0) {
    throw new Error("No usable words were found in that file.");
  }

  const options =
    data?.options && typeof data.options === "object"
      ? {
          caseSensitive: data.options.caseSensitive === true,
          wholeWord: data.options.wholeWord !== false,
        }
      : undefined;

  return { terms, options, total: rawTerms.length };
}
