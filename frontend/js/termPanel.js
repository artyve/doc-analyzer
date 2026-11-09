/**
 * Sidebar word list: colour swatch, jump-to-match, live count, on/off toggle
 * and delete. Rows are rebuilt from state; counts are patched in afterwards so
 * a highlight pass does not touch the DOM structure.
 */

export function createTermPanel({ listEl, emptyEl, template, onColor, onToggle, onDelete, onJump }) {
  let counts = new Map();

  function render(state) {
    listEl.replaceChildren();
    emptyEl.hidden = state.terms.length > 0;

    for (const term of state.terms) {
      const row = template.content.firstElementChild.cloneNode(true);
      row.dataset.id = term.id;

      const color = row.querySelector(".term-color");
      color.value = term.color;
      color.addEventListener("input", () => {
        onColor(term.id, color.value);
      });

      const word = row.querySelector(".term-word");
      word.textContent = term.word;
      word.title = `Jump to the next match of “${term.word}”`;
      word.addEventListener("click", () => onJump(term.id));

      const toggle = row.querySelector(".term-enabled");
      toggle.checked = term.enabled;
      toggle.addEventListener("change", () => onToggle(term.id, toggle.checked));

      const remove = row.querySelector(".term-delete");
      remove.addEventListener("click", () => onDelete(term.id));

      applyCount(row, counts.get(term.id) ?? 0);
      listEl.appendChild(row);
    }
  }

  function applyCount(row, count) {
    const enabled = row.querySelector(".term-enabled")?.checked !== false;
    const badge = row.querySelector(".term-count");
    badge.textContent = String(count);
    badge.title = `${count} match${count === 1 ? "" : "es"}`;
    row.classList.toggle("has-matches", count > 0 && enabled);
    row.classList.toggle("is-disabled", !enabled);
  }

  function setCounts(next) {
    counts = next instanceof Map ? next : new Map();
    for (const row of listEl.children) {
      applyCount(row, counts.get(row.dataset.id) ?? 0);
    }
  }

  return { render, setCounts };
}
