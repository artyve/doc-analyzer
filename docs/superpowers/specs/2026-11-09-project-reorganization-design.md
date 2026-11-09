# Design Doc: Project Reorganization for doc-analyzer

## Intent and The Why
The goal is to move from a flat, root-heavy structure to a structured "Backend/Frontend" split. This prevents the root directory from becoming cluttered as new capabilities (like more complex extraction logic or a modern frontend framework) are added.

## Goals
- Clear separation of concerns (Logic vs. UI).
- Scalable folder structure for future modules.
- Clean root directory.

## Non-Goals
- Migrating the frontend to a framework (e.g., React).
- Changing existing code logic.

## Approaches
### Considered:
1. **Flat Structure (Current):** Quick for small scripts, but becomes unmanageable.
2. **`src/` Monolith:** Good, but mixes Python and Web assets in one tree.
3. **`backend/` & `frontend/` Split (Selected):** Provides the best isolation for independent scaling of the API and the UI.

## The Parts of the How
### 1. Backend Structure
- `backend/app/`: Core logic moved here.
  - `backend/app/main.py`
  - `backend/app/extract.py`
  - `backend/app/graph_extractor.py`
  - `backend/app/models.py`
  - `backend/app/storage.py`
- `backend/requirements.txt`: Moved from root (if it existed).

### 2. Frontend Structure
- `frontend/`: All contents of the current `web/` folder.
  - `frontend/index.html`
  - `frontend/js/`
  - `frontend/styles.css`

### 3. Cleanup
- Remove empty `src/` folder.

## What's left to the builder
- Update any path references in `main.py` if it serves static files from `web/` (will need to point to `../frontend/`).
- Update the `.gitignore` to reflect new paths.
