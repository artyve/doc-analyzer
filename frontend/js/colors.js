/**
 * Colour helpers: a distinct default palette plus hex/rgba conversion.
 * Highlights keep the document's own text colour, so only the background is
 * tinted (semi-transparent so the glyphs stay legible).
 */

export const PALETTE = [
  "#ffe082", // amber
  "#a5d6a7", // green
  "#90caf9", // blue
  "#f48fb1", // pink
  "#ce93d8", // purple
  "#ffab91", // orange
  "#80deea", // cyan
  "#e6ee9c", // lime
  "#b39ddb", // violet
  "#ffd180", // apricot
  "#80cbc4", // teal
  "#bcaea2", // taupe
];

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

export function isHexColor(value) {
  return typeof value === "string" && HEX_PATTERN.test(value.trim());
}

/** Pick the least-used palette colour so new terms are easy to tell apart. */
export function nextColor(terms) {
  const usage = new Map(PALETTE.map((color) => [color, 0]));
  for (const term of terms) {
    const color = typeof term.color === "string" ? term.color.toLowerCase() : "";
    if (usage.has(color)) usage.set(color, usage.get(color) + 1);
  }

  let best = PALETTE[0];
  let bestCount = Infinity;
  for (const color of PALETTE) {
    const count = usage.get(color) ?? 0;
    if (count < bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return best;
}

export function hexToRgb(hex) {
  const value = isHexColor(hex) ? hex.slice(1) : "ffe082";
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

export function rgba(hex, alpha = 0.55) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Background colour for a term id, tolerant of deleted terms. */
export function termColor(terms, termId, alpha) {
  const term = terms.find((item) => item.id === termId);
  return rgba(term?.color ?? PALETTE[0], alpha);
}
