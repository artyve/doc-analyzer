/** App bootstrap: wires the upload flow, term panel, viewers and import/export. */
console.log("[graph] main.js module loaded");

import * as api from "./api.js";
import { buildPayload, downloadPayload, exportFilename, parseTermFile } from "./fileIO.js";
import { createHtmlViewer } from "./htmlViewer.js";
import { createPdfViewer } from "./pdfViewer.js";
import * as store from "./state.js";
import { createTermPanel } from "./termPanel.js";
import { createGraph } from "./graph.js";
import { applyCloudState, countWords, createTextMeasurer, layoutCloud, renderCloud } from "./wordCloud.js";

const MAX_BYTES = 50 * 1024 * 1024;
const SUPPORTED = /\.(pdf|txt|text|md|markdown)$/i;
const LAST_DOC_KEY = "doc_analyzer_last_doc";

const el = (id) => document.getElementById(id);
const ui = {
  dropZone: el("dropZone"),
  fileInput: el("fileInput"),
  uploadStatus: el("uploadStatus"),
  docInfo: el("docInfo"),
  termForm: el("termForm"),
  termInput: el("termInput"),
  termList: el("termList"),
  termEmpty: el("termEmpty"),
  clearTerms: el("clearTerms"),
  optWholeWord: el("optWholeWord"),
  optCaseSensitive: el("optCaseSensitive"),
  importBtn: el("importBtn"),
  exportBtn: el("exportBtn"),
  importInput: el("importInput"),
  summary: el("summary"),
  viewer: el("viewer"),
  viewerScroll: el("viewerScroll"),
  emptyState: el("emptyState"),
  viewerToolbar: el("viewerToolbar"),
  prevPage: el("prevPage"),
  nextPage: el("nextPage"),
  pageIndicator: el("pageIndicator"),
  zoomIn: el("zoomIn"),
  zoomOut: el("zoomOut"),
  zoomLabel: el("zoomLabel"),
  fitWidth: el("fitWidth"),
  toggleBBoxes: el("toggleBBoxes"),
  toggleInteractive: el("toggleInteractive"),
  hlMultiplier: el("hlMultiplier"),
  hlMultiplierValue: el("hlMultiplierValue"),
  importModal: el("importModal"),
  importSummary: el("importSummary"),
  mergeImport: el("mergeImport"),
  replaceImport: el("replaceImport"),
  cancelImport: el("cancelImport"),
  cloudBtn: el("cloudBtn"),
  cloudModal: el("cloudModal"),
  cloudSvg: el("cloudSvg"),
  cloudEmpty: el("cloudEmpty"),
  cloudSubtitle: el("cloudSubtitle"),
  cloudStopwords: el("cloudStopwords"),
  cloudStatus: el("cloudStatus"),
  closeCloud: el("closeCloud"),
  graphBtn: el("graphBtn"),
  graphModal: el("graphModal"),
  graphContainer: el("graphContainer"),
  graphEmpty: el("graphEmpty"),
  graphNodeCount: el("graphNodeCount"),
  graphEdgeCount: el("graphEdgeCount"),
  graphSubtitle: el("graphSubtitle"),
  graphStatus: el("graphStatus"),
  closeGraph: el("closeGraph"),
  saveGraphLayout: el("saveGraphLayout"),
  centerGraph: el("centerGraph"),
  autoLayoutBtn: el("autoLayoutBtn"),
  toast: el("toast"),
};

let viewer = null;
let currentDoc = null;
let currentPage = 1;
let lastDocumentId = null;
let currentFile = null;
let pendingImport = null;
let autoFit = true;
let imageWarningShown = false;
let highlightQueued = false;
let toastTimer = null;
let resizeQueued = false;

const CLOUD_WIDTH = 1000;
const CLOUD_HEIGHT = 600;

const cloudCache = new Map();
let cloudOpen = false;
let cloudDirty = false;
let textMeasurer = null;

const GRAPH_WIDTH = 1000;
const GRAPH_HEIGHT = 600;

let graph = null;
let graphOpen = false;
let graphDirty = false;
let graphRendered = false;
let graphExistsPollId = null;

const panel = createTermPanel({
  listEl: ui.termList,
  emptyEl: ui.termEmpty,
  template: el("termRowTemplate"),
  onColor: (id, color) => store.updateTerm(id, { color }),
  onToggle: (id, enabled) => store.updateTerm(id, { enabled }),
  onDelete: (id) => store.removeTerm(id),
  onJump: (id) => jumpToTerm(id),
});

graph = createGraph(ui.graphContainer);
graph.init();

/* ------------------------------------------------------------------ helpers */

function showToast(message, kind = "info") {
  ui.toast.textContent = message;
  ui.toast.classList.toggle("is-error", kind === "error");
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    ui.toast.hidden = true;
  }, 5200);
}

function setStatus(message, isError = false) {
  ui.uploadStatus.hidden = !message;
  ui.uploadStatus.textContent = message ?? "";
  ui.uploadStatus.classList.toggle("is-error", Boolean(isError));
}

function syncOptions(options) {
  ui.optWholeWord.checked = options.wholeWord;
  ui.optCaseSensitive.checked = options.caseSensitive;
}

function updateDocInfo(doc) {
  if (!doc) {
    ui.docInfo.textContent = "No document loaded";
    return;
  }
  const kind = doc.kind === "pdf" ? "PDF" : doc.kind === "markdown" ? "Markdown" : "Text";
  const pages = doc.kind === "pdf" ? `${doc.pageCount} page${doc.pageCount === 1 ? "" : "s"} · ` : "";
  ui.docInfo.textContent = `${doc.name} · ${kind} · ${pages}${doc.charCount.toLocaleString()} characters`;
}

function updateSummary(counts, terms) {
  const enabled = terms.filter((term) => term.enabled).length;
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  const words = `${terms.length} word${terms.length === 1 ? "" : "s"}${terms.length ? ` · ${enabled} on` : ""}`;
  ui.summary.textContent = currentDoc
    ? `${words} · ${total} match${total === 1 ? "" : "es"}`
    : `${words} · saved in this browser`;
}

/* -------------------------------------------------------------- highlighting */

function scheduleHighlight() {
  if (highlightQueued) return;
  highlightQueued = true;
  requestAnimationFrame(() => {
    highlightQueued = false;
    refreshHighlights();
  });
}

function refreshHighlights() {
  const { terms } = store.getState();

  if (!viewer || !currentDoc) {
    panel.setCounts(new Map());
    updateSummary(new Map(), terms);
    return;
  }

  const counts = viewer.updateHighlights(terms, store.getState().options) ?? new Map();
  panel.setCounts(counts);
  updateSummary(counts, terms);
}

function jumpToTerm(termId) {
  if (!viewer || !currentDoc) {
    showToast("Load a document first.");
    return;
  }
  const found = viewer.jumpToTerm(termId);
  if (!found) showToast("No match for that word in this document.");
}

/* --------------------------------------------------------------- document IO */

function loadDocument(doc) {
  viewer?.destroy?.();
  viewer = null;
  currentDoc = doc;
  currentPage = 1;
  autoFit = true;
  imageWarningShown = false;
  updateDocInfo(doc);
  ui.cloudBtn.disabled = false;
  cloudCache.clear();
  graphRendered = false;
  graphData = null;
  updateGraphButtonState();

  if (doc.kind === "pdf") {
    ui.viewerToolbar.hidden = false;
    ui.zoomLabel.textContent = "100%";
    ui.pageIndicator.textContent = `1 / ${doc.pageCount}`;
    viewer = createPdfViewer(ui.viewer, ui.viewerScroll, {
      onPage: (index, count) => {
        currentPage = index;
        ui.pageIndicator.textContent = `${index} / ${count}`;
        ui.prevPage.disabled = index <= 1;
        ui.nextPage.disabled = index >= count;
      },
      onZoom: (zoom) => {
        ui.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
      },
      onImageError: () => {
        if (imageWarningShown) return;
        imageWarningShown = true;
        showToast("A page image failed to load. The document may have expired — upload it again.", "error");
      },
    });
    viewer.setDocument(doc);
    viewer.toggleInteractive(interactionEnabled);
    viewer.toggleBBoxes(bboxesVisible);
    ui.prevPage.disabled = true;
    ui.nextPage.disabled = doc.pageCount <= 1;

    if (!doc.hasText) {
      const notice = document.createElement("div");
      notice.className = "notice";
      notice.textContent =
        "No selectable text was found in this PDF — it looks like a scan, so there is nothing to highlight.";
      ui.viewer.prepend(notice);
    }
  } else {
    ui.viewerToolbar.hidden = true;
    viewer = createHtmlViewer(ui.viewer);
    viewer.setDocument(doc);
  }

  refreshHighlights();
}

async function handleFile(file) {
  if (!file) return;

  if (!SUPPORTED.test(file.name)) {
    const message = "Unsupported file type. Use PDF, TXT or Markdown.";
    setStatus(message, true);
    showToast(message, "error");
    return;
  }

  if (file.size > MAX_BYTES) {
    const message = `That file is larger than ${MAX_BYTES / (1024 * 1024)} MB.`;
    setStatus(message, true);
    showToast(message, "error");
    return;
  }

  currentFile = file;

  setStatus(`Uploading and extracting ${file.name}…`);
  ui.dropZone.classList.add("is-busy");

  try {
    const doc = await api.uploadDocument(file);
    setStatus("");
    loadDocument(doc);

    lastDocumentId = doc.id;

    // Remember the loaded document so it persists across page reloads.
    try {
      localStorage.setItem(LAST_DOC_KEY, JSON.stringify(doc));
    } catch {
      /* localStorage may be unavailable or quota-exceeded */
    }
  } catch (error) {
    setStatus(error.message, true);
    showToast(error.message, "error");
  } finally {
    ui.dropZone.classList.remove("is-busy");
  }
}

/* ------------------------------------------------------------------ helpers */

function openImportModal(parsed) {
  const existing = new Set(store.getState().terms.map((term) => term.word.toLowerCase()));
  const duplicates = parsed.terms.filter((term) => existing.has(term.word.toLowerCase())).length;
  const fresh = parsed.terms.length - duplicates;

  ui.importSummary.textContent =
    `${parsed.terms.length} word${parsed.terms.length === 1 ? "" : "s"} found in the file: ` +
    `${fresh} new, ${duplicates} already in your list.`;
  pendingImport = parsed;
  ui.importModal.hidden = false;
  ui.mergeImport.focus();
}

function closeImportModal() {
  ui.importModal.hidden = true;
  pendingImport = null;
  ui.importInput.value = "";
}

async function readImportFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    openImportModal(parseTermFile(text));
  } catch (error) {
    showToast(error.message, "error");
    ui.importInput.value = "";
  }
}

/* ---------------------------------------------------------------- word cloud */

function termFor(key) {
  return store.getState().terms.find((term) => term.word.toLowerCase() === key) ?? null;
}

function openCloud() {
  if (!currentDoc) {
    showToast("Load a document first.");
    return;
  }
  if (!textMeasurer) textMeasurer = createTextMeasurer();
  cloudOpen = true;
  ui.cloudModal.hidden = false;
  renderCloudView();
  ui.closeCloud.focus();
}

function closeCloud() {
  if (!cloudOpen) return;
  cloudOpen = false;
  ui.cloudModal.hidden = true;

  // Highlighting was deferred while the modal was open (a full pass over a
  // 48-page PDF is expensive), so catch up in one go now.
  if (cloudDirty) {
    cloudDirty = false;
    scheduleHighlight();
  }
  ui.cloudBtn.focus();
}

function renderCloudView() {
  if (!currentDoc) return;

  const includeStopwords = ui.cloudStopwords.checked;
  const text = viewer?.getText?.() ?? "";
  if (!text.trim()) {
    showCloudMessage(
      "No selectable text was found in this document — it looks like a scan, so there is nothing to draw.",
    );
    return;
  }

  const cacheKey = `${currentDoc.id}:${includeStopwords ? "all" : "common-words-off"}`;
  if (!cloudCache.has(cacheKey)) {
    // Keep the full list so the header can report how many words exist, not
    // just how many fit in the cloud.
    cloudCache.set(cacheKey, countWords(text, { includeStopwords, maxWords: Number.MAX_SAFE_INTEGER }));
  }
  const entries = cloudCache.get(cacheKey);

  if (entries.length === 0) {
    showCloudMessage(
      includeStopwords
        ? "This document has no words to show."
        : 'Every word was filtered out as too short or too common. Tick "Include common words" to see them.',
    );
    return;
  }

  const placed = layoutCloud(entries, {
    width: CLOUD_WIDTH,
    height: CLOUD_HEIGHT,
    measure: textMeasurer,
  });

  if (placed.length === 0) {
    showCloudMessage("This document's words could not be fitted into a cloud.");
    return;
  }

  ui.cloudEmpty.hidden = true;
  renderCloud(ui.cloudSvg, placed, {
    width: CLOUD_WIDTH,
    height: CLOUD_HEIGHT,
    termFor,
    onToggle: toggleCloudWord,
  });

  const unique = entries.length.toLocaleString();
  const shown = placed.length.toLocaleString();
  ui.cloudSubtitle.textContent =
    `${currentDoc.name} · ${unique} unique word${entries.length === 1 ? "" : "s"} · showing ${shown}`;
  updateCloudStatus();
}

function showCloudMessage(message) {
  ui.cloudSvg.replaceChildren();
  ui.cloudEmpty.textContent = message;
  ui.cloudEmpty.hidden = false;
  ui.cloudSubtitle.textContent = currentDoc?.name ?? "";
  ui.cloudStatus.textContent = "";
}

function updateCloudStatus() {
  const total = ui.cloudSvg.querySelectorAll("text.cloud-word").length;
  const listed = ui.cloudSvg.querySelectorAll("text.cloud-word.is-listed").length;
  ui.cloudStatus.textContent = total ? `${listed} of ${total} highlighted` : "";
}

function toggleCloudWord(item) {
  const existing = termFor(item.key);
  if (existing) {
    store.removeTerm(existing.id);
    return;
  }
  const result = store.addTerm(item.word);
  if (!result.ok) ui.cloudStatus.textContent = result.error;
}

/* ---------------------------------------------------------------- knowledge graph */

async function fetchGraphStatus() {
  const response = await fetch(`/api/documents/${encodeURIComponent(currentDoc.id)}/graph/status`);
  if (!response.ok) throw new Error(await response.text() || `Request failed (HTTP ${response.status}).`);
  return response.json();
}

async function updateGraphButtonState() {
  if (!currentDoc) {
    ui.graphBtn.disabled = true;
    return;
  }

  // Stop any existing poll for the previous document.
  if (graphExistsPollId !== null) {
    clearInterval(graphExistsPollId);
    graphExistsPollId = null;
  }

  async function check() {
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(currentDoc.id)}/graph/exists`);
      if (response.ok) {
        const data = await response.json();
        if (data.exists) {
          ui.graphBtn.disabled = false;
          if (graphExistsPollId !== null) {
            clearInterval(graphExistsPollId);
            graphExistsPollId = null;
          }
        }
      }
    } catch (error) {
      console.error("[graph] Failed to check graph existence:", error);
    }
  }

  // Check immediately.
  await check();

  // If the graph doesn't exist yet, poll every 3 seconds until it does.
  if (ui.graphBtn.disabled) {
    graphExistsPollId = setInterval(check, 3000);
  }
}

async function waitForGraph() {
  ui.graphStatus.textContent = "Generating knowledge graph…";
  // Poll every 3 seconds for up to ~5 minutes (100 attempts).
  const maxAttempts = 100;
  for (let i = 0; i < maxAttempts; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const status = await fetchGraphStatus();
      if (status.status === "done") {
        await updateGraphButtonState();
        const graphResp = await fetch(`/api/documents/${encodeURIComponent(currentDoc.id)}/graph`);
        if (graphResp.ok) {
          const data = await graphResp.json();
          console.log("[graph] Graph ready:", data.nodes.length, "nodes,", data.edges.length, "edges");
          return data;
        }
        throw new Error(await graphResp.text() || `Request failed (HTTP ${graphResp.status}).`);
      }
      if (status.status === "failed") {
        showToast(`Graph generation failed: ${status.error || "unknown error"}`, "error");
        return null;
      }
      // Still "running" or "not_started": keep polling.
    } catch (error) {
      console.error("[graph] Status poll failed:", error.name, error.message);
      // Keep polling on transient errors.
    }
  }
  showToast("Graph generation is taking longer than expected.", "error");
  return null;
}

async function fetchGraph() {
  console.log("[graph] fetchGraph entry, currentDoc:", currentDoc ? currentDoc.id : null);
  if (!currentDoc) {
    console.log("[graph] fetchGraph early return: no currentDoc");
    return null;
  }
  console.log("[graph] fetchGraph starting for doc:", currentDoc.id);
  try {
    // Try the cached result first (fast path after background generation completes).
    const response = await fetch(`/api/documents/${encodeURIComponent(currentDoc.id)}/graph`);
    if (response.ok) {
      await updateGraphButtonState();
      const data = await response.json();
      console.log("[graph] Got cached graph:", data.nodes.length, "nodes,", data.edges.length, "edges");
      return data;
    }
    if (response.status === 202) {
      // Still generating — poll until done.
      return waitForGraph();
    }
    if (response.status === 502) {
      const error = await response.text();
      console.error("[graph] Graph endpoint error:", response.status, error);
      showToast(`Graph generation failed: ${error}`, "error");
      return null;
    }
    const error = await response.text() || `Request failed (HTTP ${response.status}).`;
    console.error("[graph] Graph endpoint error:", response.status, error);
    showToast(`Graph generation failed: ${error}`, "error");
    return null;
  } catch (error) {
    console.error("[graph] Graph fetch failed:", error.name, error.message);
    showToast(`Graph generation failed: ${error.message}`, "error");
    return null;
  }
}

function openGraph() {
  console.log("[graph] openGraph called, currentDoc:", currentDoc ? currentDoc.id : null);
  if (!currentDoc) {
    showToast("Load a document first.");
    return;
  }
  graphOpen = true;
  ui.graphModal.hidden = false;
  // Reset so we refetch on every open (in case a previous fetch failed).
  graphRendered = false;
  graphData = null;
  // Defer resize so the browser has laid out the modal before we measure it.
  requestAnimationFrame(() => graph.resize());
  renderGraphView();
  ui.closeGraph.focus();
}

function closeGraph() {
  if (!graphOpen) return;
  graphOpen = false;
  ui.graphModal.hidden = true;
  ui.graphBtn.focus();
}

async function saveGraphLayoutHandler() {
  if (!currentDoc) {
    showToast("Load a document first.");
    return;
  }
  const layout = graph.getLayout();
  try {
    const response = await fetch(
      `/api/documents/${encodeURIComponent(currentDoc.id)}/graph/layout`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(layout),
      },
    );
    if (!response.ok) {
      throw new Error(await response.text() || `Request failed (HTTP ${response.status}).`);
    }
    showToast("Graph layout saved.");
  } catch (error) {
    console.error("[graph] Failed to save layout:", error);
    showToast(`Failed to save layout: ${error.message}`, "error");
  }
}

function centerGraphHandler() {
  graph?.center();
}

async function autoLayoutHandler() {
  if (!currentDoc) {
    showToast("Load a document first.");
    return;
  }
  try {
    await graph.autoLayout(100);
    showToast("Auto layout complete.");
  } catch (error) {
    console.error("[graph] Auto layout failed:", error);
    showToast(`Auto layout failed: ${error.message}`, "error");
  }
}

let graphData = null;

async function renderGraphView() {
  console.log("[graph] renderGraphView called, graphRendered:", graphRendered, "graphData:", graphData ? graphData.nodes.length + " nodes" : null);
  if (!currentDoc) return;

  if (!graphRendered) {
    graphData = await fetchGraph();
    graphRendered = true;
  }

  const total = graphData ? graphData.nodes.length : 0;
  const listed = graphData ? graphData.edges.length : 0;
  if (ui.graphNodeCount) ui.graphNodeCount.textContent = `${total} thing${total === 1 ? "" : "s"}`;
  if (ui.graphEdgeCount) ui.graphEdgeCount.textContent = `${listed} relationship${listed === 1 ? "" : "s"}`;
  ui.graphSubtitle.textContent = currentDoc
    ? `${currentDoc.name} · ${total} thing${total === 1 ? "" : "s"} · ${listed} relationship${listed === 1 ? "" : "s"}`
    : "";

  if (!graphData) {
    ui.graphStatus.textContent = "";
    showGraphMessage("Could not generate the knowledge graph. Make sure an OpenRouter API key is configured.");
    return;
  }
  if (graphData.nodes.length === 0) {
    ui.graphStatus.textContent = "";
    showGraphMessage("No things were found in this document to build a graph.");
    return;
  }

  const graphSvg = graph.getSvg();
  if (graphSvg) graphSvg.hidden = false;
  ui.graphEmpty.hidden = true;
  graph.setGraph(graphData.nodes, graphData.edges);
  ui.graphStatus.textContent = "";
}

function showGraphMessage(message) {
  const graphSvg = graph.getSvg();
  if (graphSvg) graphSvg.hidden = true;
  ui.graphEmpty.textContent = message;
  ui.graphEmpty.hidden = false;
  ui.graphSubtitle.textContent = currentDoc?.name ?? "";
  ui.graphStatus.textContent = "";
}

/* ---------------------------------------------------------------- interactions */

ui.dropZone.addEventListener("click", () => ui.fileInput.click());
ui.dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    ui.fileInput.click();
  }
});

ui.fileInput.addEventListener("change", () => {
  const file = ui.fileInput.files?.[0];
  handleFile(file);
  ui.fileInput.value = "";
});

for (const type of ["dragenter", "dragover"]) {
  window.addEventListener(type, (event) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    ui.dropZone.classList.add("is-over");
  });
}

window.addEventListener("dragleave", (event) => {
  if (event.relatedTarget === null) ui.dropZone.classList.remove("is-over");
});

window.addEventListener("drop", (event) => {
  if (!event.dataTransfer?.files?.length) return;
  event.preventDefault();
  ui.dropZone.classList.remove("is-over");
  handleFile(event.dataTransfer.files[0]);
});

ui.termForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const result = store.addTerm(ui.termInput.value);
  if (!result.ok) {
    showToast(result.error, "error");
    ui.termInput.select();
    return;
  }
  ui.termInput.value = "";
  ui.termInput.focus();
});

ui.optWholeWord.addEventListener("change", () => store.setOption("wholeWord", ui.optWholeWord.checked));
ui.optCaseSensitive.addEventListener("change", () =>
  store.setOption("caseSensitive", ui.optCaseSensitive.checked),
);

ui.clearTerms.addEventListener("click", () => {
  const { terms } = store.getState();
  if (terms.length === 0) return;
  if (!window.confirm(`Remove all ${terms.length} words from the list?`)) return;
  store.clearTerms();
});

ui.exportBtn.addEventListener("click", () => {
  const payload = buildPayload(store.getState());
  downloadPayload(payload, exportFilename(currentDoc?.name));
  showToast(`Exported ${payload.terms.length} word${payload.terms.length === 1 ? "" : "s"}.`);
});

ui.importBtn.addEventListener("click", () => ui.importInput.click());
ui.importInput.addEventListener("change", () => readImportFile(ui.importInput.files?.[0]));

ui.mergeImport.addEventListener("click", () => {
  if (!pendingImport) return;
  const added = store.mergeTerms(pendingImport.terms);
  closeImportModal();
  showToast(added > 0 ? `Added ${added} new word${added === 1 ? "" : "s"}.` : "Nothing new to add.");
});

ui.replaceImport.addEventListener("click", () => {
  if (!pendingImport) return;
  const count = pendingImport.terms.length;
  store.replaceAll(pendingImport.terms, pendingImport.options);
  closeImportModal();
  showToast(`Replaced the list with ${count} word${count === 1 ? "" : "s"}.`);
});

ui.cancelImport.addEventListener("click", closeImportModal);
ui.importModal.addEventListener("click", (event) => {
  if (event.target === ui.importModal) closeImportModal();
});

ui.cloudBtn.addEventListener("click", openCloud);
ui.closeCloud.addEventListener("click", closeCloud);
ui.cloudModal.addEventListener("click", (event) => {
  if (event.target === ui.cloudModal) closeCloud();
});
ui.cloudStopwords.addEventListener("change", () => {
  if (cloudOpen) renderCloudView();
});

ui.graphBtn.addEventListener("click", openGraph);
ui.closeGraph.addEventListener("click", closeGraph);
ui.saveGraphLayout.addEventListener("click", saveGraphLayoutHandler);
ui.centerGraph.addEventListener("click", centerGraphHandler);
ui.autoLayoutBtn.addEventListener("click", autoLayoutHandler);
ui.graphModal.addEventListener("click", (event) => {
  if (event.target === ui.graphModal) closeGraph();
});

let bboxesVisible = false;
let interactionEnabled = false;

ui.toggleBBoxes.addEventListener("click", () => {
  bboxesVisible = !bboxesVisible;
  ui.toggleBBoxes.classList.toggle("primary", bboxesVisible);
  if (viewer?.toggleBBoxes) viewer.toggleBBoxes(bboxesVisible);
});

ui.toggleInteractive.addEventListener("click", () => {
  interactionEnabled = !interactionEnabled;
  ui.toggleInteractive.classList.toggle("primary", interactionEnabled);
  if (viewer?.toggleInteractive) viewer.toggleInteractive(interactionEnabled);
});

ui.prevPage.addEventListener("click", () => viewer?.goToPage?.(currentPage - 1));
ui.nextPage.addEventListener("click", () => viewer?.goToPage?.(currentPage + 1));

ui.zoomIn.addEventListener("click", () => {
  if (!viewer?.getZoom) return;
  autoFit = false;
  viewer.setZoom(viewer.getZoom() * 1.15);
});

ui.zoomOut.addEventListener("click", () => {
  if (!viewer?.getZoom) return;
  autoFit = false;
  viewer.setZoom(viewer.getZoom() / 1.15);
});

ui.fitWidth.addEventListener("click", () => {
  if (!viewer?.fitWidth) return;
  autoFit = true;
  viewer.fitWidth();
});

ui.hlMultiplier.addEventListener("input", (event) => {
  const value = event.target.value;
  ui.hlMultiplierValue.textContent = `${parseFloat(value).toFixed(1)}×`;
  if (!viewer?.setHighlightMultiplier) return;
  viewer.setHighlightMultiplier(value);
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (graphOpen) {
      closeGraph();
      return;
    }
    if (cloudOpen) {
      closeCloud();
      return;
    }
    if (!ui.importModal.hidden) {
      closeImportModal();
      return;
    }
  }
  if (cloudOpen) return;

  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (currentDoc?.kind !== "pdf" || !viewer?.getZoom) return;

  if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    autoFit = false;
    viewer.setZoom(viewer.getZoom() * 1.15);
  } else if (event.key === "-" || event.key === "_") {
    event.preventDefault();
    autoFit = false;
    viewer.setZoom(viewer.getZoom() / 1.15);
  }
});

window.addEventListener("resize", () => {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    if (autoFit && currentDoc?.kind === "pdf") viewer?.fitWidth?.();
  });
});

store.subscribe((state, event) => {
  syncOptions(state.options);

  if (cloudOpen) {
    // Keep the rows and the cloud's pills in sync, but hold the expensive
    // highlight pass until the modal closes.
    cloudDirty = true;
    if (event.type !== "color") panel.render(state);
    applyCloudState(ui.cloudSvg, termFor);
    updateCloudStatus();
    return;
  }

  if (event.type !== "color") panel.render(state);
  scheduleHighlight();
});

/* -------------------------------------------------------------------- start */

syncOptions(store.getState().options);
panel.render(store.getState());
refreshHighlights();

// Restore the last loaded document on page reload, if one is stored.
try {
  const stored = localStorage.getItem(LAST_DOC_KEY);
  if (stored) {
    const doc = JSON.parse(stored);
    if (doc && doc.id) {
      loadDocument(doc);
    }
  }
} catch {
  /* ignore storage/parse errors */
}
