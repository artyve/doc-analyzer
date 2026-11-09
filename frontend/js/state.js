/**
 * Term list + match options, persisted in localStorage.
 *
 * Every mutation emits an event so the sidebar can decide whether it needs a
 * full re-render (colour edits must not rebuild the row, otherwise the native
 * colour picker closes mid-drag).
 */

import { nextColor, isHexColor } from "./colors.js";
import { DEFAULT_OPTIONS } from "./matcher.js";

const STORAGE_KEY = "docHighlighter.v1";
const MAX_TERMS = 300;

let state = {
  terms: [],
  options: { ...DEFAULT_OPTIONS },
};

const listeners = new Set();

function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `t${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function normaliseTerm(raw) {
  if (!raw || typeof raw.word !== "string") return null;
  const word = raw.word.trim();
  if (!word) return null;
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : newId(),
    word,
    color: isHexColor(raw.color) ? raw.color.toLowerCase() : null,
    enabled: raw.enabled !== false,
  };
}

function normaliseTerms(rawTerms) {
  const seen = new Set();
  const terms = [];
  for (const raw of Array.isArray(rawTerms) ? rawTerms : []) {
    const term = normaliseTerm(raw);
    if (!term) continue;
    const key = term.word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!term.color) term.color = nextColor(terms);
    terms.push(term);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

function normaliseOptions(rawOptions) {
  return {
    caseSensitive: rawOptions?.caseSensitive === true,
    wholeWord: rawOptions?.wholeWord !== false,
  };
}

function load() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    const parsed = JSON.parse(stored);
    state = {
      terms: normaliseTerms(parsed.terms),
      options: normaliseOptions(parsed.options),
    };
  } catch {
    state = { terms: [], options: { ...DEFAULT_OPTIONS } };
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage may be unavailable (private mode); highlighting still works */
  }
}

function emit(event) {
  persist();
  for (const listener of listeners) {
    try {
      listener(getState(), event);
    } catch (error) {
      console.error("state listener failed", error);
    }
  }
}

export function getState() {
  return { terms: state.terms, options: state.options };
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function addTerm(word) {
  const value = String(word ?? "").trim();
  if (!value) return { ok: false, error: "Type a word or phrase first." };
  if (state.terms.length >= MAX_TERMS) {
    return { ok: false, error: `That is the limit of ${MAX_TERMS} words.` };
  }
  if (state.terms.some((term) => term.word.toLowerCase() === value.toLowerCase())) {
    return { ok: false, error: `"${value}" is already in the list.` };
  }

  const term = {
    id: newId(),
    word: value,
    color: nextColor(state.terms),
    enabled: true,
  };
  state = { ...state, terms: [...state.terms, term] };
  emit({ type: "add", id: term.id });
  return { ok: true, term };
}

export function updateTerm(id, patch) {
  let changed = false;
  const terms = state.terms.map((term) => {
    if (term.id !== id) return term;
    changed = true;
    const next = { ...term, ...patch };
    if (!isHexColor(next.color)) next.color = term.color;
    if (typeof next.word === "string") next.word = next.word.trim() || term.word;
    next.enabled = next.enabled !== false;
    return next;
  });
  if (!changed) return;
  state = { ...state, terms };
  emit({ type: "update", id, patch });
}

export function removeTerm(id) {
  const terms = state.terms.filter((term) => term.id !== id);
  if (terms.length === state.terms.length) return;
  state = { ...state, terms };
  emit({ type: "remove", id });
}

export function setOption(name, value) {
  if (!(name in state.options)) return;
  if (state.options[name] === value) return;
  state = { ...state, options: { ...state.options, [name]: value } };
  emit({ type: "options", name, value });
}

export function clearTerms() {
  if (state.terms.length === 0) return;
  state = { ...state, terms: [] };
  emit({ type: "clear" });
}

export function replaceAll(terms, options) {
  state = {
    terms: normaliseTerms(terms),
    options: normaliseOptions(options ?? state.options),
  };
  emit({ type: "replace" });
}

export function mergeTerms(terms) {
  const existing = new Set(state.terms.map((term) => term.word.toLowerCase()));
  const merged = [...state.terms];
  let added = 0;
  for (const raw of normaliseTerms(terms)) {
    if (existing.has(raw.word.toLowerCase())) continue;
    existing.add(raw.word.toLowerCase());
    merged.push({ ...raw, color: raw.color || nextColor(merged) });
    added += 1;
  }
  if (added === 0) return 0;
  state = { ...state, terms: merged };
  emit({ type: "merge", added });
  return added;
}

load();
