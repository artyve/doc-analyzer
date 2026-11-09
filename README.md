# Document Word Highlighter

Upload a document, give it a list of words, and see every occurrence highlighted —
one distinct colour per word. The list (words, colours, options) imports and exports
as JSON.

- **Inputs:** PDF, plain text (`.txt`) and Markdown (`.md`)
- **Per word:** add, delete, rename by re-adding, pick any colour, toggle on/off, live match count
- **Matching:** case-insensitive whole-word by default, with toggles for match-case and substring
- **Phrases:** multi-word terms work, including across line breaks (`net interest income`)
- **Word cloud:** one click shows the document's most frequent words; click a word in the cloud to add or remove it from the highlight list
- **Knowledge graph:** one click extracts things (people, places, entities, objects) and the semantic relationships between them, then shows a navigable 2D graph you can pan and zoom. Drag a node to move it out of the way. Requires `OPENROUTER_API_KEY` in the environment.
- **Persistence:** the list and its colours live in `localStorage`; nothing is written to the server

## Quick start

```powershell
# from the repository root
.\.venv\Scripts\python.exe -m pip install -r requirements-prd.txt
.\.venv\Scripts\python.exe -m uvicorn doc_analyzer.main:app --reload --port 8080
```

Then open <http://127.0.0.1:8080>.

Port 8080 is a deliberate choice: port 8000 is vLLM's default, so AI IDE
extensions and agent tools scan it for a local model server and leave probe
traffic in the log. See [Troubleshooting](#troubleshooting).

Create the environment first if it does not exist:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-prd.txt
```

## Configuration

| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter API key, required for knowledge graph generation |
| `OPENROUTER_MODEL` | OpenRouter model to use (default: `openrouter/auto`) |

Set these in `.env` at the project root or export them in your shell before starting the server.

## How it works

```
browser                          FastAPI
-------                          -------
PDF  ─────────────────────►  PyMuPDF: page raster + word boxes + page text
TXT/MD ───────────────────►  decode / render Markdown to sanitised HTML
     ◄─── DocumentResponse ──
matcher.js: one regex, longest term first
  ├─ PDF   → word boxes → translucent rects over the page
  └─ HTML  → DOM ranges → <mark> elements in the rendered text
```

**PDF.** Pages are rendered server-side and every word box is normalised to
0..1 of its page, so zoom is a pure CSS resize — no re-rendering and no
coordinate drift. Three layers are stacked per page: the raster, the highlight
rectangles (`mix-blend-mode: multiply`, so the glyphs stay black), and an
invisible word layer built from the same boxes, which keeps the text selectable
and copyable.

**Text/Markdown.** The document is rendered to HTML, its text nodes are
flattened into one string with a map back to `(node, offset)`, matches are found
once, then wrapped in `<mark>`. Matches are applied right-to-left so splitting
text nodes never invalidates offsets that have not been processed yet.

**Matching.** All enabled terms become one alternation regex, sorted longest
first, so `net interest income` wins over `income` and no occurrence is
highlighted twice. Multi-word terms join on `\s+`, so a phrase still matches
when the document wraps it. Whole-word uses Unicode-aware lookarounds
(`\p{L}\p{N}`), which is why `revenue` does not match `revenues` but does match
`revenue-generating`.

**Word cloud.** The **Analyse** panel opens a cloud built entirely in the
browser from the text already on screen — no request, no extra dependency.
Words are counted case-insensitively from the whole document, then common
English stopwords, tokens under three letters and (when there are plenty of
repeated words) one-offs are dropped. The top 80 are placed on an
Archimedean spiral: the most frequent word sits in the centre, the rest spiral
outward with collision checks, and font size scales with the square root of the
count. Clicking a word adds it to the highlight list, or removes it if already
listed, without closing the cloud; words in the list are drawn in their term
colour. Highlight repainting waits until the cloud closes, so toggling stays
fast on long PDFs.

## JSON format

Export produces (import also accepts a bare `["word", ...]` array):

```json
{
  "version": 1,
  "app": "doc-analyzer",
  "exportedAt": "2026-10-30T12:00:00.000Z",
  "options": { "caseSensitive": false, "wholeWord": true },
  "terms": [
    { "word": "net interest income", "color": "#ffe082", "enabled": true },
    { "word": "revenue", "color": "#a5d6a7", "enabled": true }
  ]
}
```

On import you choose **Merge** (adds new words, keeps the current list and
options) or **Replace** (takes both the words and the saved options).

## API

| Method   | Path                                        | Purpose                                    |
| -------- | ------------------------------------------- | ------------------------------------------ |
| `POST`   | `/api/documents`                            | Upload (multipart `file`), returns metadata |
| `GET`    | `/api/documents/{id}/pages/{n}.png?scale=2` | Rasterised PDF page (cached)                |
| `GET`    | `/api/documents/{id}/pages`                 | Page metadata only                          |
| `DELETE` | `/api/documents/{id}`                       | Remove an upload                            |
| `POST`   | `/api/documents/{id}/graph`                 | Extract a knowledge graph (nodes + edges)   |
| `GET`    | `/api/health`                               | Liveness + version                          |

`POST /api/documents` replies with:

```json
{
  "id": "6f1c…",
  "name": "agreement.pdf",
  "kind": "pdf",
  "pageCount": 48,
  "hasText": true,
  "charCount": 184232,
  "pages": [
    {
      "index": 1,
      "width": 612,
      "height": 792,
      "text": "Page 1 of 48\n\nBMO Digital Banking Agreement…",
      "words": [{ "text": "Page", "start": 0, "end": 4, "line": 4, "bbox": [0.47, 0.92, 0.5, 0.93] }]
    }
  ],
  "html": null
}
```

`kind: "markdown"` fills `html` instead of `words`; `kind: "text"` returns a
single page with the whole file.

## Project layout

```
doc_analyzer/
  main.py           FastAPI routes + static mount
  extract.py        PDF / TXT / Markdown extraction and Markdown sanitising
  graph_extractor.py LLM-based knowledge graph extraction via OpenRouter
  storage.py        temp upload dirs, page raster cache, TTL cleanup
  models.py         response models (serialised as camelCase)
  tests/            pytest suite (API + extraction)
  web/
    index.html, styles.css
    js/main.js          bootstrap and wiring
    js/state.js         term list + options, localStorage
    js/matcher.js       term → regex, offsets
    js/domHighlight.js  text-node ↔ offset mapping, <mark> wrapping
    js/pdfViewer.js     page layers, overlay rects, zoom, page nav
    js/htmlViewer.js    text/Markdown surface
    js/termPanel.js     sidebar rows
    js/wordCloud.js     word counting + spiral SVG layout
    js/fileIO.js        JSON import/export
    js/colors.js        palette + rgba helpers
    js/graph.js         knowledge graph SVG renderer (pan, zoom, drag nodes)
```

## Limitations

- **Scanned PDFs** have no text to match; the app shows a notice instead (no OCR).
- **Password-protected PDFs** are rejected with a clear message.
- PDF highlights snap to whole words: a substring match inside a word tints the
  whole word box.
- Markdown images with relative paths cannot resolve; broken images are hidden.
- The service is meant for local single-user use: uploads are unauthenticated and
  kept in `doc_analyzer/.uploads/` for 8 hours (override the directory with
  `DOC_ANALYZER_UPLOAD_DIR`).
- Uploads are capped at 50 MB and `.pdf`/`.txt`/`.md`/`.markdown` only.

## Development

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest doc_analyzer/tests -q
node --test doc_analyzer/web/js/      # matcher + word cloud tests, no npm needed
```

Keyboard shortcuts in the PDF viewer: `+` / `-` zoom, `Fit` resets to page width.

## Troubleshooting

**`GET /health` + `GET /v1/models` in the terminal.** This pair is not the app.
The UI only talks to `/api/documents` and never polls `/api/health`, and the app
serves no route at either path — both return 404.

The signature is a local-LLM discovery handshake: a client checks `/health` for
liveness, then `/v1/models` for the OpenAI-compatible model list. **Port 8000 is
vLLM's default**, so AI IDE extensions and agent tools scan it for a model
server and retry every few seconds. Running the app on **8080** (as the quick
start does) removes the collision entirely.

If you run on 8000 anyway, set `DOC_ANALYZER_LOG_PROBES=1` to see who is
calling (the probes still 404, but each one is named):

```powershell
$env:DOC_ANALYZER_LOG_PROBES = "1"
.\.venv\Scripts\python.exe -m uvicorn doc_analyzer.main:app --port 8000
```

```
INFO:     127.0.0.1:58839 - "GET /health HTTP/1.1" 404 Not Found
WARNING:  probe /health from 127.0.0.1 user-agent='...' referer='...'
```

The user-agent usually names the tool immediately; disable its server discovery
there. Otherwise `--no-access-log` hides all request lines, including your own
uploads.

Do not add stub `/health` or `/v1/models` routes to silence this: answering 200
makes the app look like a half-working model server and lengthens each probe
instead of stopping it.

