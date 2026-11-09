/**
 * Matcher unit tests. No dependencies — run with:
 *   node --test doc_analyzer/web/js/
 */

import assert from "node:assert/strict";
import test from "node:test";

import { findMatches } from "./matcher.js";

const terms = (...words) =>
  words.map((word, index) => ({ id: `t${index}`, word, color: "#ffe082", enabled: true }));

test("whole-word mode skips matches inside longer words", () => {
  const text = "Revenue grew. Revenues were strong.";
  const matches = findMatches(text, terms("revenue"), { wholeWord: true });
  assert.equal(matches.length, 1);
  assert.equal(text.slice(matches[0].start, matches[0].end), "Revenue");
});

test("hyphens count as word boundaries", () => {
  const text = "revenue-generating";
  const matches = findMatches(text, terms("revenue"), { wholeWord: true });
  assert.equal(matches.length, 1);
  assert.equal(text.slice(matches[0].start, matches[0].end), "revenue");
});

test("substring mode matches inside longer words", () => {
  const text = "Revenue grew. Revenues and revenue-generating.";
  const matches = findMatches(text, terms("revenue"), { wholeWord: false });
  assert.equal(matches.length, 3);
});

test("case sensitivity is optional", () => {
  const text = "Net income rose, NET INCOME fell.";
  assert.equal(findMatches(text, terms("net income"), { wholeWord: true }).length, 2);
  assert.equal(
    findMatches(text, terms("Net income"), { wholeWord: true, caseSensitive: true }).length,
    1,
  );
  assert.equal(
    findMatches(text, terms("net income"), { wholeWord: true, caseSensitive: true }).length,
    0,
  );
});

test("phrases match across line breaks and runs of whitespace", () => {
  const text = "The net interest\nincome line   grew.";
  const matches = findMatches(text, terms("net interest income"), { wholeWord: true });
  assert.equal(matches.length, 1);
  assert.equal(text.slice(matches[0].start, matches[0].end), "net interest\nincome");
});

test("longest term wins over a shorter overlapping one", () => {
  const text = "Net interest income grew while income fell.";
  const matches = findMatches(text, terms("income", "net interest income"));
  assert.deepEqual(
    matches.map((match) => match.termId),
    ["t1", "t0"],
  );
});

test("each term keeps its own id and offsets", () => {
  const text = "Alpha beta alpha";
  const matches = findMatches(text, terms("alpha", "beta"));
  assert.deepEqual(
    matches.map((match) => `${match.termId}:${text.slice(match.start, match.end)}`),
    ["t0:Alpha", "t1:beta", "t0:alpha"],
  );
});

test("regex metacharacters are treated literally", () => {
  const text = "Growth of 4.5% (not 45%) and $1.2B.";
  const matches = findMatches(text, terms("4.5%", "$1.2B"));
  assert.deepEqual(
    matches.map((match) => text.slice(match.start, match.end)),
    ["4.5%", "$1.2B"],
  );
});

test("disabled terms, blanks and empty text are ignored", () => {
  const list = [
    { id: "a", word: "alpha", color: "#ffe082", enabled: false },
    { id: "b", word: "   ", color: "#ffe082", enabled: true },
  ];
  assert.equal(findMatches("alpha beta", list).length, 0);
  assert.equal(findMatches("", terms("alpha")).length, 0);
  assert.equal(findMatches("alpha", []).length, 0);
});

test("overlapping occurrences do not produce duplicate highlights", () => {
  const text = "barbar";
  const matches = findMatches(text, terms("bar"), { wholeWord: false });
  assert.equal(matches.length, 2);
  for (let index = 1; index < matches.length; index += 1) {
    assert.ok(matches[index].start >= matches[index - 1].end);
  }
});
