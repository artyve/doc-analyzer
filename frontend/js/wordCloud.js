/**
 * Word cloud: tokenising, frequency counting and a spiral SVG layout.
 *
 * Everything here is client-side. The document text is already in the browser
 * (page text for PDFs, rendered DOM text for Markdown), so opening the cloud
 * never touches the network.
 *
 * The layout is an Archimedean spiral: the most frequent word sits at the
 * centre and the rest spiral outward, skipping any position whose bounding box
 * would collide with a word already placed. Widths come from an injected
 * `measure(word, size)` function so the maths can be unit tested without a DOM.
 */

const WORD_PATTERN = /[\p{L}][\p{L}\p{N}'’\-]*/gu;
const SVG_NS = "http://www.w3.org/2000/svg";
const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Common English words that carry no meaning in a frequency list. */
export const STOPWORDS = new Set(
  `a about above across after afterwards again against all almost alone along already also although always am among
  amongst an and another any anyhow anyone anything anyway anywhere are around as at back be became because become
  becomes becoming been before beforehand behind being below beside besides between beyond both but by can cannot
  cant could couldn't did didn't do does doesn't doing don't done down due during each either else elsewhere enough
  even ever every everyone everything everywhere except few first for former formerly from further had hadn't has
  hasn't have haven't having he he'd he'll he's hence her here here's hereafter hereby herein hereupon hers herself
  him himself his how how's however i i'd i'll i'm i've if in indeed into is isn't it it's its itself just keep last
  latter least less let's like likely little lot many may maybe me meanwhile more moreover most mostly much must
  mustn't my myself namely neither never nevertheless next no nobody none noone nor not nothing now nowhere of off
  often on once one only onto or other others otherwise ought our ours ourselves out over own per perhaps please
  quite rather really said same say says see seem seemed seeming seems several shall shan't she she'd she'll she's
  should shouldn't since so some somehow someone something sometime sometimes somewhere still such than that that's
  the their theirs them themselves then thence there there's thereafter thereby therefore therein thereupon these
  they they'd they'll they're they've this those though through throughout thru thus to together too toward towards
  under until up upon us used using very via was wasn't we we'd we'll we're we've well were weren't what what's
  whatever when when's whence whenever where where's whereafter whereas whereby wherein whereupon wherever whether
  which while whither who who's whoever whole whom whose why why's will with within without won't would wouldn't
  yet you you'd you'll you're you've your yours yourself yourselves`.split(/\s+/),
);

export const DEFAULT_CLOUD_OPTIONS = {
  includeStopwords: false,
  minLength: 3,
  maxWords: 80,
  minCount: "auto",
};

/**
 * Count word frequencies in `text`.
 *
 * @returns {{ word: string, key: string, count: number }[]} sorted by count
 *   (descending), then alphabetically. `word` keeps the most common surface
 *   form ("BMO" beats "bmo"), `key` is the lowercase form used for identity.
 */
export function countWords(text, options = {}) {
  const settings = { ...DEFAULT_CLOUD_OPTIONS, ...options };
  if (typeof text !== "string" || text.length === 0) return [];

  const counts = new Map();

  for (const match of text.matchAll(WORD_PATTERN)) {
    const raw = match[0].replace(/^['’\-]+/, "").replace(/['’\-]+$/, "");
    if (raw.length < settings.minLength) continue;

    const key = raw.toLowerCase().replace(/’/g, "'");
    if (!settings.includeStopwords && STOPWORDS.has(key)) continue;

    const entry = counts.get(key);
    if (entry) {
      entry.count += 1;
      entry.forms.set(raw, (entry.forms.get(raw) ?? 0) + 1);
    } else {
      counts.set(key, { key, count: 1, forms: new Map([[raw, 1]]) });
    }
  }

  const entries = [];
  for (const entry of counts.values()) {
    let word = entry.key;
    let best = 0;
    for (const [form, seen] of entry.forms) {
      if (seen > best) {
        word = form;
        best = seen;
      }
    }
    entries.push({ word, key: entry.key, count: entry.count });
  }

  entries.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  const minimum = settings.minCount === "auto" ? autoMinCount(entries) : settings.minCount;
  return entries.filter((entry) => entry.count >= minimum).slice(0, settings.maxWords);
}

/** Drop once-only words, but only when there are plenty of repeated words. */
function autoMinCount(entries) {
  let repeated = 0;
  for (const entry of entries) {
    if (entry.count > 1) repeated += 1;
    if (repeated >= 30) return 2;
  }
  return 1;
}

/** Font size for a count, compressed with sqrt so one huge word cannot dominate. */
export function scaleFont(count, minCount, maxCount, minSize = 12, maxSize = 64) {
  if (!(maxCount > minCount)) return Math.round((minSize + maxSize) / 2);
  const clamped = Math.min(Math.max(count, minCount), maxCount);
  const ratio = Math.sqrt(clamped - minCount) / Math.sqrt(maxCount - minCount);
  return Math.round(minSize + ratio * (maxSize - minSize));
}

/**
 * Place `entries` on a spiral inside a width×height box.
 *
 * @param {{ word: string, key: string, count: number }[]} entries
 * @param {{ width?: number, height?: number, minSize?: number, maxSize?: number,
 *   padding?: number, maxWords?: number, measure?: (word: string, size: number) => number }} options
 * @returns {{ word: string, key: string, count: number, size: number, x: number,
 *   y: number, boxWidth: number, boxHeight: number, box: object }[]}
 */
export function layoutCloud(entries, options = {}) {
  const width = options.width ?? 1000;
  const height = options.height ?? 600;
  const minSize = options.minSize ?? 12;
  const maxSize = options.maxSize ?? 64;
  const padding = options.padding ?? 6;
  const maxWords = options.maxWords ?? 80;
  const measure = options.measure ?? ((word, size) => word.length * size * 0.55);

  const items = [...(Array.isArray(entries) ? entries : [])]
    .filter((entry) => entry && entry.word && entry.count > 0)
    .sort((a, b) => b.count - a.count || String(a.key ?? a.word).localeCompare(String(b.key ?? b.word)))
    .slice(0, maxWords);
  if (items.length === 0) return [];

  const counts = items.map((entry) => entry.count);
  const minCount = Math.min(...counts);
  const maxCount = Math.max(...counts);

  const placed = [];
  const centreX = width / 2;
  const centreY = height / 2;

  for (const entry of items) {
    let size = scaleFont(entry.count, minCount, maxCount, minSize, maxSize);
    let textWidth = measure(entry.word, size);

    // A single long word must still fit the canvas.
    while (size > minSize && textWidth > width - padding * 4) {
      size -= 2;
      textWidth = measure(entry.word, size);
    }

    const boxWidth = textWidth + padding * 2;
    const boxHeight = size * 1.15 + padding * 2;
    const spot = findSpot(placed, boxWidth, boxHeight, {
      centreX,
      centreY,
      width,
      height,
      padding,
    });
    if (!spot) continue;

    placed.push({ ...entry, size, x: spot.x, y: spot.y, boxWidth, boxHeight, box: spot.box });
  }

  return placed;
}

/** Walk an elliptical spiral from the centre until a free spot is found. */
function findSpot(placed, boxWidth, boxHeight, { centreX, centreY, width, height, padding }) {
  const step = 3;
  const angleStep = 0.1;
  const ratio = 1.6;
  const maxRadius = Math.hypot(width, height) * 1.1;

  for (let theta = 0; step * theta <= maxRadius; theta += angleStep) {
    const radius = step * theta;
    const x = centreX + radius * ratio * Math.cos(theta);
    const y = centreY + radius * Math.sin(theta);
    const box = {
      x0: x - boxWidth / 2,
      y0: y - boxHeight / 2,
      x1: x + boxWidth / 2,
      y1: y + boxHeight / 2,
    };

    if (box.x0 < padding || box.y0 < padding || box.x1 > width - padding || box.y1 > height - padding) {
      continue;
    }
    if (placed.some((item) => overlaps(box, item.box, padding))) continue;
    return { x, y, box };
  }

  return null;
}

function overlaps(a, b, gap) {
  return a.x0 < b.x1 + gap && a.x1 + gap > b.x0 && a.y0 < b.y1 + gap && a.y1 + gap > b.y0;
}

/** Canvas-backed width measurement using the same font the SVG renders. */
export function createTextMeasurer() {
  const fallback = (word, size) => word.length * size * 0.55;
  if (typeof document === "undefined") return fallback;

  const context = document.createElement("canvas").getContext("2d");
  if (!context) return fallback;

  return (word, size) => {
    context.font = `600 ${size}px ${FONT_FAMILY}`;
    return context.measureText(word).width;
  };
}

/**
 * Draw placed words into an SVG element.
 *
 * @param {SVGSVGElement} svg
 * @param {ReturnType<typeof layoutCloud>} placed
 * @param {{ width?: number, height?: number, termFor?: (key: string) => object | null,
 *   onToggle?: (item: object) => void }} options
 */
export function renderCloud(svg, placed, options = {}) {
  const width = options.width ?? 1000;
  const height = options.height ?? 600;
  const termFor = options.termFor ?? (() => null);
  const onToggle = options.onToggle ?? (() => {});

  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  for (const item of placed) {
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", item.x.toFixed(2));
    text.setAttribute("y", item.y.toFixed(2));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    text.setAttribute("font-size", String(item.size));
    text.setAttribute("class", "cloud-word");
    text.setAttribute("role", "button");
    text.setAttribute("tabindex", "0");
    text.setAttribute("aria-pressed", "false");
    // Halos are drawn as a centred stroke; half of it (6px max) must fit in
    // the 6px padding around each box so neighbouring words never touch.
    text.style.strokeWidth = `${Math.min(Math.round(item.size * 0.5), 12)}px`;
    text.dataset.key = item.key;
    text.dataset.word = item.word;
    text.dataset.count = String(item.count);
    text.textContent = item.word;

    const title = document.createElementNS(SVG_NS, "title");
    title.textContent = `${item.word} — ${item.count} occurrence${item.count === 1 ? "" : "s"}`;
    text.appendChild(title);

    const toggle = () => onToggle(item);
    text.addEventListener("click", toggle);
    text.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });

    svg.appendChild(text);
  }

  applyCloudState(svg, termFor);
}

/** Repaint the words whose highlight state may have changed. */
export function applyCloudState(svg, termFor) {
  for (const node of svg.querySelectorAll("text.cloud-word")) {
    const term = termFor(node.dataset.key);
    const listed = Boolean(term);
    node.classList.toggle("is-listed", listed);
    node.setAttribute("aria-pressed", listed ? "true" : "false");
    node.dataset.termId = listed ? term.id : "";

    if (listed) node.style.setProperty("--cloud-term", term.color);
    else node.style.removeProperty("--cloud-term");

    const count = node.dataset.count ?? "0";
    const state = listed ? "highlighted" : "not highlighted";
    node.setAttribute(
      "aria-label",
      `${node.dataset.word ?? node.dataset.key}, ${count} occurrence${count === "1" ? "" : "s"}, ${state}`,
    );
  }
}
