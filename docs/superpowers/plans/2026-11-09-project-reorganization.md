# Project Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the `doc-analyzer` codebase into a clean `backend/` and `frontend/` structure.

**Architecture:** Moving all Python source files into a nested `backend/app/` directory and all web assets into a `frontend/` directory. Updating imports and path references to match.

**Tech Stack:** Python, Shell/FileSystem

**Spec:** `docs/superpowers/specs/2026-11-09-project-reorganization-design.md`

## Global Constraints
- Do not change any business logic or algorithm implementations.
- Ensure the application still runs using `python backend/app/main.py`.

## Review Focus
- **Path references in `main.py`:** If the server serves static files, it must now look in `../../frontend/` instead of `web/`.
- **Python module resolution:** Ensure internal imports between `main.py`, `extract.py`, etc., still work when moved.
- **`.gitignore` coverage:** Ensure the new folders aren't accidentally ignoring necessary source files or failing to ignore artifacts.

---

### Task 1: Create Folder Structure

**Files:**
- Create: `backend/app/`
- Create: `frontend/`

- [ ] **Step 1: Create directories**
Run: `mkdir -p backend/app frontend`

- [ ] **Step 2: Verify directories exist**
Run: `ls -R backend frontend`

- [ ] **Step 3: Commit structure**
```bash
git add backend/ frontend/
git commit -m "chore: create backend and frontend directory structure"
```

---

### Task 2: Move Backend Files

**Files:**
- Modify: Move `*.py` from root to `backend/app/`
- Modify: Move `requirements.txt` (if exists) to `backend/`

- [ ] **Step 1: Move Python files**
Run: `mv *.py backend/app/`
*Note: Keep `__init__.py` if it exists in root, or create one in `backend/app/` to ensure it's a package.*

- [ ] **Step 2: Move requirements**
Run: `mv requirements.txt backend/` (if it exists)

- [ ] **Step 3: Verify move**
Run: `ls backend/app/` should show `main.py`, `extract.py`, `models.py`, etc.

- [ ] **Step 4: Commit**
```bash
git add backend/
git commit -m "refactor: move backend python files to backend/app/"
```

---

### Task 3: Move Frontend Files

**Files:**
- Modify: Move contents of `web/` to `frontend/`

- [ ] **Step 1: Move web assets**
Run: `mv web/* frontend/`

- [ ] **Step 2: Remove old web directory**
Run: `rmdir web`

- [ ] **Step 3: Commit**
```bash
git add frontend/
git commit -m "refactor: move web assets to frontend/"
```

---

### Task 4: Fix Paths and References

**Files:**
- Modify: `backend/app/main.py`
- Modify: `.gitignore`
- Delete: `src/` (if empty)

- [ ] **Step 1: Update static file paths in `main.py`**
Search `main.py` for any strings referencing `"web"` or `"web/"`. Update them to point to `"../../frontend"` (relative to `backend/app/`) or use absolute path logic.

- [ ] **Step 2: Update `.gitignore`**
Update paths like `__pycache__/` to be more general or reflect new structure.

- [ ] **Step 3: Remove empty `src/`**
Run: `rm -rf src`

- [ ] **Step 4: Verify application runs**
Run: `python backend/app/main.py` (ensure it starts without import errors).

- [ ] **Step 5: Commit**
```bash
git add .
git commit -m "fix: update paths and clean up old directories"
```
