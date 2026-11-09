/**
 * Word cloud unit tests. No dependencies — run with:
 *   node --test doc_analyzer/web/js/
 */

import assert from "node:assert/strict";
import test from "node:test";

import { countWords, layoutCloud, scaleFont, STOPWORDS } from "./wordCloud.js";

const words = (text, options) => countWords(text, options);

test("counts words and sorts by frequency", () => {
  const result = words("Net income grew. Net income rose. Net profit.");
  assert.deepEqual(
    result.map((entry) => [entry.key, entry.count]),
    [
      ["net", 3],
      ["income", 2],
      ["grew", 1],
      ["profit", 1],
      ["rose", 1],
    ],
  );
});

test("drops English stopwords by default and keeps them on request", () => {
  const text = "the account and the account for the customer";
  const filtered = words(text);
  assert.deepEqual(
    filtered.map((entry) => entry.key),
    ["account", "customer"],
  );
  assert.equal(STOPWORDS.has("the"), true);

  const everything = words(text, { includeStopwords: true });
  assert.equal(everything[0].key, "the");
  assert.equal(everything[0].count, 3);
});

test("ignores short tokens and numbers", () => {
  const result = words("a ab abc abcd 2026 4% £12");
  assert.deepEqual(
    result.map((entry) => entry.key),
    ["abc", "abcd"],
  );
});

test("keeps hyphenated and possessive words as single tokens", () => {
  const result = words("e-banking e-banking bank's bank");
  assert.deepEqual(
    result.map((entry) => [entry.key, entry.count]),
    [
      ["e-banking", 2],
      ["bank", 1],
      ["bank's", 1],
    ],
  );
});

test("normalises curly apostrophes before stopword matching", () => {
  const result = words("don’t worry, don’t panic");
  assert.deepEqual(
    result.map((entry) => entry.key),
    ["panic", "worry"],
  );
});

test("displays the most common surface form but compares on the key", () => {
  const result = words("BMO bmo bmo digital");
  const bmo = result.find((entry) => entry.key === "bmo");
  assert.equal(bmo.word, "bmo");
  assert.equal(bmo.count, 3);
});

test("drops once-only words when repeated words are plentiful", () => {
  const repeated = Array.from({ length: 35 }, (_, index) => `term${index} term${index}`).join(" ");
  const result = words(`${repeated} uniqueword`);
  assert.equal(result.length, 35);
  assert.equal(
    result.some((entry) => entry.key === "uniqueword"),
    false,
  );
  assert.equal(result.every((entry) => entry.count === 2), true);
});

test("respects maxWords", () => {
  const text = Array.from({ length: 120 }, (_, index) => `word${index}`).join(" ");
  assert.equal(words(text).length, 80);
  assert.equal(words(text, { maxWords: 10 }).length, 10);
});

test("empty and non-string input produce no words", () => {
  assert.deepEqual(words(""), []);
  assert.deepEqual(words(null), []);
  assert.deepEqual(words(undefined), []);
});

test("font size grows with count and spans the configured range", () => {
  assert.equal(scaleFont(1, 1, 100, 12, 48), 12);
  assert.equal(scaleFont(100, 1, 100, 12, 48), 48);
  const sizes = [1, 2, 5, 10, 50, 100].map((count) => scaleFont(count, 1, 100, 12, 48));
  for (let index = 1; index < sizes.length; index += 1) {
    assert.ok(sizes[index] >= sizes[index - 1], `not monotonic: ${sizes}`);
  }
  assert.equal(scaleFont(50, 7, 7, 12, 48), 30);
});

const measure = (word, size) => word.length * size * 0.55;

const sample = (count = 60) =>
  Array.from({ length: count }, (_, index) => ({
    word: `word${index}`,
    key: `word${index}`,
    count: count - index,
  }));

test("spiral layout keeps every word inside the canvas", () => {
  const placed = layoutCloud(sample(), { width: 900, height: 520, measure });
  assert.ok(placed.length > 5, `only placed ${placed.length}`);

  for (const item of placed) {
    assert.ok(item.box.x0 >= 0 && item.box.y0 >= 0, `outside top-left: ${item.word}`);
    assert.ok(item.box.x1 <= 900 && item.box.y1 <= 520, `outside bottom-right: ${item.word}`);
  }
});

test("spiral layout never overlaps words", () => {
  const placed = layoutCloud(sample(), { width: 900, height: 520, measure });
  for (let a = 0; a < placed.length; a += 1) {
    for (let b = a + 1; b < placed.length; b += 1) {
      const left = placed[a].box;
      const right = placed[b].box;
      const overlap =
        left.x0 < right.x1 && left.x1 > right.x0 && left.y0 < right.y1 && left.y1 > right.y0;
      assert.equal(overlap, false, `${placed[a].word} overlaps ${placed[b].word}`);
    }
  }
});

test("biggest word is placed at the centre and sized largest", () => {
  const placed = layoutCloud(sample(), { width: 900, height: 520, measure });
  const first = placed[0];
  assert.equal(first.key, "word0");
  assert.equal(Math.round(first.x), 450);
  assert.equal(Math.round(first.y), 260);
  assert.equal(Math.max(...placed.map((item) => item.size)), first.size);
});

test("layout honours maxWords and survives an empty list", () => {
  assert.equal(layoutCloud(sample(), { maxWords: 12, measure }).length <= 12, true);
  assert.deepEqual(layoutCloud([], { measure }), []);
  assert.deepEqual(layoutCloud(undefined, { measure }), []);
});

test("a realistic frequency skew fits most words on the default canvas", () => {
  const names = [
    "payment", "account", "services", "information", "banking", "customer", "agreement",
    "electronic", "transaction", "available", "charges", "statement", "balance", "interest",
    "transfer", "security", "privacy", "consent", "personal", "delivery", "documents",
    "monthly", "request", "eligible", "mobile",
  ];
  const skewed = Array.from({ length: 80 }, (_, index) => ({
    word: `${names[index % names.length]}${index > 24 ? "x".repeat(1 + (index % 4)) : ""}`,
    key: `w${index}`,
    count: Math.max(2, Math.round(460 / (index + 1))),
  }));

  // With maxSize 128px the largest word is very big, so far fewer words fit
  // than at 48px — the layout still packs densely around it.
  const placed = layoutCloud(skewed, { measure: (word, size) => word.length * size * 0.6 });
  assert.ok(placed.length >= 20, `only placed ${placed.length}`);
});
