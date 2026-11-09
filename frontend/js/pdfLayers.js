/**
 * Helper to convert 0.0-1.0 to percentage string.
 */
export const pct = (value) => `${(value * 100).toFixed(4)}%`;

const PAGE_BASE_WIDTH = 760;
const RASTER_SCALE = 2;

// Pre-create canvas for text measurement (reused for performance)
const measureCanvas = document.createElement("canvas");
const measureCtx = measureCanvas.getContext("2d");

export function buildPage(docId, page, pageIndex, hooks = {}) {
  const onImageError = hooks.onImageError ?? (() => {});

  const element = document.createElement("section");
  element.className = "pdf-page";
  element.dataset.page = String(page.index);
  const width = page.width > 0 ? page.width : 612;
  const height = page.height > 0 ? page.height : 792;
  element.style.aspectRatio = `${width} / ${height}`;

  const image = document.createElement("img");
  image.className = "page-img";
  image.alt = `Page ${page.index}`;
  image.decoding = "async";
  image.loading = page.index <= 2 ? "eager" : "lazy";
  image.draggable = false;
  image.src = `/api/documents/${encodeURIComponent(docId)}/pages/${page.index}.png?scale=${RASTER_SCALE}`;
  image.addEventListener("error", () => onImageError(page.index), { once: true });

  const hlLayer = document.createElement("div");
  hlLayer.className = "hl-layer";

  const textLayer = document.createElement("div");
  textLayer.className = "text-layer";

  const debugLayer = document.createElement("div");
  debugLayer.className = "debug-bbox-layer";

  element.append(image, hlLayer, textLayer, debugLayer);

  return { page, pageIndex, el: element, hlLayer, textLayer, debugLayer, matches: [], textBuilt: false, debugBuilt: false };
}

export function buildDebugLayer(entry) {
  if (entry.debugBuilt) return;
  const frag = document.createDocumentFragment();
  for (const word of entry.page.words) {
    const [x0, y0, x1, y1] = word.bbox;
    const rect = document.createElement("div");
    rect.className = "bbox-rect";
    rect.style.left = pct(x0);
    rect.style.top = pct(y0);
    rect.style.width = pct(Math.max(x1 - x0, 0.0001));
    rect.style.height = pct(Math.max(y1 - y0, 0.0001));
    frag.appendChild(rect);
  }
  entry.debugLayer.appendChild(frag);
  entry.debugBuilt = true;
}

export function buildTextLayer(page, layer) {
  const pageWidth = page.width > 0 ? page.width : 612;
  const pageHeight = page.height > 0 ? page.height : 792;
  const basePageHeight = (PAGE_BASE_WIDTH * pageHeight) / pageWidth;

  const lines = new Map();
  for (let i = 0; i < page.words.length; i++) {
    const word = page.words[i];
    const bucket = lines.get(word.line);
    if (bucket) bucket.push({ word, index: i });
    else lines.set(word.line, [{ word, index: i }]);
  }

  for (const items of lines.values()) {
    const words = items.map(item => item.word);
    const x0 = Math.min(...words.map((word) => word.bbox[0]));
    const y0 = Math.min(...words.map((word) => word.bbox[1]));
    const x1 = Math.max(...words.map((word) => word.bbox[2]));
    const y1 = Math.max(...words.map((word) => word.bbox[3]));
    const width = Math.max(x1 - x0, 0.0001);
    const height = Math.max(y1 - y0, 0.0001);

    const line = document.createElement("div");
    line.className = "tline";
    line.style.left = pct(x0);
    line.style.top = pct(y0);
    line.style.width = pct(width);
    line.style.height = pct(height);
    
    const fontSizePx = height * basePageHeight;
    line.style.fontSize = `calc(${fontSizePx.toFixed(4)}px * var(--zoom))`;
    measureCtx.font = `${fontSizePx.toFixed(4)}px "Times New Roman", serif`;

    for (const item of items) {
      const { word, index } = item;

      const span = document.createElement("span");
      span.className = "tw";
      span.style.left = pct((word.bbox[0] - x0) / width);
      const targetWidthFrac = Math.max(word.bbox[2] - word.bbox[0], 0.0001);
      span.style.width = pct(targetWidthFrac / width);
      
      span.textContent = word.text;
      span.dataset.start = String(word.start);
      span.dataset.end = String(word.end);
      span.dataset.index = String(index);
      span.dataset.page = String(page.index);

      const metrics = measureCtx.measureText(word.text);
      const measuredWidth = metrics.width;
      const targetWidthPx = targetWidthFrac * PAGE_BASE_WIDTH;
      
      if (measuredWidth > 0 && targetWidthPx > 0) {
        const scaleX = targetWidthPx / measuredWidth;
        span.style.transform = `scaleX(${scaleX.toFixed(4)})`;
      }

      line.appendChild(span);
    }

    layer.appendChild(line);
  }
}
