// User-editable ICAO list control.
//
// State:
//   list      — ordered ICAOs in the user's list (1..LIST_MAX entries).
//               Seeded from DEFAULT_SEED; user can add, remove, reorder.
//   selected  — subset of `list` currently checked (= the form value).
//               Order mirrors `list` whenever the user reorders rows, so
//               the text input always reflects the latest list order for
//               the checked subset.
//
// Edit sources:
//   * checkbox toggle   → add/remove from `selected`
//   * text input typing → live updates `selected`; new valid codes get
//                          appended to `list` (capped at LIST_MAX)
//   * search box        → click an "Add" result to append to `list` + select
//   * × button on a row → removes from `list` and `selected` (floor LIST_MIN)
//   * ↑/↓ buttons       → reorder a row by one position
//   * drag-and-drop     → reorder via mouse; identical to arrow-button effect
//   * Restore defaults  → list := DEFAULT_SEED, selected := DEFAULT_SELECTED
//   * All / None        → toggle every row's checked state

import { DEFAULT_SEED, DEFAULT_SELECTED, seedAirport } from "./airports.js";
import { LIST_MIN, LIST_MAX } from "./storage.js";
import { isValidIcao, parseIcaoList } from "./metar.js";
import { loadAirports, searchAirports } from "./search.js";

const SEED_SET = new Set(DEFAULT_SEED);

function uniq(codes) {
  return Array.from(new Set(codes));
}

function describeIcao(icao, lookupByIcao) {
  const seed = seedAirport(icao);
  if (seed) return seed.name;
  const looked = lookupByIcao?.get(icao);
  if (looked) {
    const city = looked.city ? ` — ${looked.city}` : "";
    return `${looked.name}${city}`;
  }
  return null;
}

export function initIcaoControl({
  input,
  presetGrid,
  countEl,
  actionsEl,
  searchInput,
  searchResults,
  searchStatusEl,
  manageToggle,
  managePanel,
  store,
}) {
  const initial = store.load();
  let list = uniq(initial.list).slice(0, LIST_MAX).filter(isValidIcao);
  if (list.length === 0) list = [...DEFAULT_SEED];
  let selected = uniq(initial.selected).filter((c) => isValidIcao(c));

  // Make sure every selected code lives in the list.
  for (const c of selected) {
    if (!list.includes(c) && list.length < LIST_MAX) list.push(c);
  }

  const lookupByIcao = new Map();
  let dataset = null;
  let datasetLoading = false;

  async function ensureDataset() {
    if (dataset || datasetLoading) return dataset;
    datasetLoading = true;
    try {
      dataset = await loadAirports();
      for (const a of dataset) lookupByIcao.set(a.icao, a);
      renderGrid();
    } catch {
      // Search will just be unavailable; users can still type ICAOs.
    } finally {
      datasetLoading = false;
    }
    return dataset;
  }

  // --- Rendering ---

  function syncInput() {
    const value = selected.join(",");
    if (input.value !== value) input.value = value;
  }

  function makeRow(icao, index) {
    const row = document.createElement("li");
    row.className = SEED_SET.has(icao) ? "icao-row" : "icao-row icao-row-added";
    row.draggable = true;
    row.dataset.icao = icao;

    const handle = document.createElement("span");
    handle.className = "drag-handle";
    handle.textContent = "⋮⋮";
    handle.setAttribute("aria-hidden", "true");
    row.append(handle);

    const labelEl = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = icao;
    cb.dataset.icao = icao;
    cb.checked = selected.includes(icao);

    const textEl = document.createElement("span");
    const name = describeIcao(icao, lookupByIcao);
    const nameHtml = name ? ` — ${name}` : "";
    textEl.innerHTML = `<strong>${icao}</strong>${nameHtml}`;

    labelEl.append(cb, textEl);
    row.append(labelEl);

    const controls = document.createElement("div");
    controls.className = "icao-row-controls";

    const up = document.createElement("button");
    up.type = "button";
    up.className = "icao-up";
    up.dataset.moveIcao = icao;
    up.dataset.direction = "up";
    up.setAttribute("aria-label", `Move ${icao} up`);
    up.title = "Move up";
    up.textContent = "↑";
    up.disabled = index === 0;

    const down = document.createElement("button");
    down.type = "button";
    down.className = "icao-down";
    down.dataset.moveIcao = icao;
    down.dataset.direction = "down";
    down.setAttribute("aria-label", `Move ${icao} down`);
    down.title = "Move down";
    down.textContent = "↓";
    down.disabled = index === list.length - 1;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icao-remove";
    remove.dataset.removeIcao = icao;
    remove.setAttribute("aria-label", `Remove ${icao} from list`);
    remove.title = "Remove";
    remove.textContent = "−";
    remove.disabled = list.length <= LIST_MIN;

    controls.append(up, down, remove);
    row.append(controls);

    return row;
  }

  function renderGrid() {
    presetGrid.innerHTML = "";
    list.forEach((icao, i) => presetGrid.append(makeRow(icao, i)));
    updateCount();
  }

  function refreshCheckboxStates() {
    const cbs = presetGrid.querySelectorAll('input[type="checkbox"]');
    for (const cb of cbs) cb.checked = selected.includes(cb.value);
  }

  function updateCount() {
    if (!countEl) return;
    countEl.textContent = `(${selected.length}/${list.length})`;
  }

  function persist() {
    store.save({ selected: uniq(selected), list: uniq(list) });
  }

  // --- Mutations ---

  function addToList(icao) {
    if (!isValidIcao(icao)) return false;
    if (list.includes(icao)) return false;
    if (list.length >= LIST_MAX) return false;
    list.push(icao);
    return true;
  }

  function removeFromList(icao) {
    if (list.length <= LIST_MIN) return false;
    list = list.filter((c) => c !== icao);
    selected = selected.filter((c) => c !== icao);
    return true;
  }

  // Move `icao` to a new position. After any reorder, normalize `selected`
  // to follow list order so the text input shows checked codes in the same
  // sequence as the rows.
  function moveTo(icao, newIndex) {
    const from = list.indexOf(icao);
    if (from < 0) return false;
    const clamped = Math.max(0, Math.min(list.length - 1, newIndex));
    if (clamped === from) return false;
    list.splice(from, 1);
    list.splice(clamped, 0, icao);
    const sel = new Set(selected);
    selected = list.filter((c) => sel.has(c));
    return true;
  }

  // --- Initial render ---

  syncInput();
  renderGrid();
  ensureDataset();

  // --- Text input ↔ list/selected sync ---

  input.addEventListener("input", () => {
    selected = uniq(parseIcaoList(input.value));

    let listChanged = false;
    for (const c of selected) {
      if (addToList(c)) listChanged = true;
    }

    if (listChanged) {
      renderGrid();
    } else {
      refreshCheckboxStates();
      updateCount();
    }
    persist();
  });

  input.form?.addEventListener("submit", () => {
    selected = uniq(parseIcaoList(input.value));
    let added = false;
    for (const c of selected) if (addToList(c)) added = true;
    if (added) renderGrid();
    persist();
  }, { capture: true });

  // --- Manage panel toggle ---

  function setPanelOpen(open) {
    if (!managePanel || !manageToggle) return;
    manageToggle.setAttribute("aria-expanded", open ? "true" : "false");
    managePanel.hidden = !open;
  }

  manageToggle?.addEventListener("click", () => {
    const open = manageToggle.getAttribute("aria-expanded") !== "true";
    setPanelOpen(open);
    if (open && searchInput) searchInput.focus();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (manageToggle?.getAttribute("aria-expanded") === "true") {
      setPanelOpen(false);
      manageToggle.focus();
    }
  });

  // --- Row interactions: checkbox / remove / reorder buttons ---

  presetGrid.addEventListener("change", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return;
    if (target.checked) {
      if (!selected.includes(target.value)) {
        // Insert in list order to keep selected in step with the row order.
        const sel = new Set([...selected, target.value]);
        selected = list.filter((c) => sel.has(c));
      }
    } else {
      selected = selected.filter((c) => c !== target.value);
    }
    syncInput();
    updateCount();
    persist();
  });

  presetGrid.addEventListener("click", (e) => {
    const remove = e.target.closest("button.icao-remove");
    if (remove) {
      e.preventDefault();
      if (removeFromList(remove.dataset.removeIcao)) {
        syncInput();
        renderGrid();
        persist();
      }
      return;
    }
    const move = e.target.closest("button[data-move-icao]");
    if (move) {
      e.preventDefault();
      const icao = move.dataset.moveIcao;
      const delta = move.dataset.direction === "up" ? -1 : 1;
      if (moveTo(icao, list.indexOf(icao) + delta)) {
        syncInput();
        renderGrid();
        persist();
      }
    }
  });

  // --- Drag and drop ---

  let dragIcao = null;

  function clearDropMarkers() {
    for (const r of presetGrid.querySelectorAll(".drop-before, .drop-after")) {
      r.classList.remove("drop-before", "drop-after");
    }
  }

  presetGrid.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".icao-row");
    if (!row) return;
    dragIcao = row.dataset.icao;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragIcao);
    row.classList.add("dragging");
  });

  presetGrid.addEventListener("dragover", (e) => {
    if (!dragIcao) return;
    const row = e.target.closest(".icao-row");
    if (!row || row.dataset.icao === dragIcao) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = row.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    clearDropMarkers();
    row.classList.add(before ? "drop-before" : "drop-after");
  });

  presetGrid.addEventListener("dragleave", (e) => {
    // Only clear when leaving the entire grid.
    if (!presetGrid.contains(e.relatedTarget)) clearDropMarkers();
  });

  presetGrid.addEventListener("drop", (e) => {
    if (!dragIcao) return;
    const row = e.target.closest(".icao-row");
    if (!row || row.dataset.icao === dragIcao) {
      clearDropMarkers();
      return;
    }
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    const targetIndex = list.indexOf(row.dataset.icao);
    const fromIndex = list.indexOf(dragIcao);
    let newIndex = before ? targetIndex : targetIndex + 1;
    // Compensate for removal-before-insert when moving downward.
    if (fromIndex < newIndex) newIndex -= 1;

    if (moveTo(dragIcao, newIndex)) {
      syncInput();
      renderGrid();
      persist();
    }
    clearDropMarkers();
  });

  presetGrid.addEventListener("dragend", () => {
    dragIcao = null;
    for (const r of presetGrid.querySelectorAll(".dragging")) r.classList.remove("dragging");
    clearDropMarkers();
  });

  // --- Action buttons ---

  actionsEl?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    e.preventDefault();

    switch (btn.dataset.action) {
      case "select-defaults":
        list = [...DEFAULT_SEED];
        selected = [...DEFAULT_SELECTED];
        break;
      case "select-all":
        selected = [...list];
        break;
      case "select-none":
        selected = [];
        break;
    }
    syncInput();
    renderGrid();
    persist();
  });

  // --- Search box (local only for now; external button is a placeholder) ---

  let searchSeq = 0;

  function setSearchStatus(text) {
    if (searchStatusEl) searchStatusEl.textContent = text ?? "";
  }

  function renderResults(results) {
    if (!searchResults) return;
    searchResults.innerHTML = "";
    if (results.length === 0) {
      searchResults.hidden = true;
      return;
    }
    searchResults.hidden = false;
    const full = list.length >= LIST_MAX;
    for (const a of results) {
      const item = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "icao-result";
      btn.dataset.addIcao = a.icao;
      const inList = list.includes(a.icao);
      btn.disabled = inList || full;
      btn.innerHTML = `
        <span class="icao-result-code"><strong>${a.icao}</strong>${a.iata ? ` <em>${a.iata}</em>` : ""}</span>
        <span class="icao-result-name">${a.name}${a.city ? `, ${a.city}` : ""}${a.country ? ` (${a.country})` : ""}</span>
        <span class="icao-result-hint">${inList ? "in list" : full ? "list full" : "add"}</span>
      `;
      item.append(btn);
      searchResults.append(item);
    }
    if (full) setSearchStatus(`List is at the maximum (${LIST_MAX}). Remove an entry to add more.`);
  }

  async function runSearch(query) {
    const seq = ++searchSeq;
    setSearchStatus("Loading airports…");
    const data = await ensureDataset();
    if (seq !== searchSeq) return;
    if (!data) {
      setSearchStatus("Search unavailable — type the ICAO above.");
      return;
    }
    setSearchStatus("");
    const results = searchAirports(query, data, { limit: 8 });
    if (seq !== searchSeq) return;
    renderResults(results);
    if (results.length === 0 && query.trim().length >= 2) {
      setSearchStatus(`No matches for "${query}".`);
    }
  }

  searchInput?.addEventListener("input", () => {
    const q = searchInput.value;
    if (!q || q.trim().length < 2) {
      renderResults([]);
      setSearchStatus("");
      return;
    }
    runSearch(q);
  });

  searchResults?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-add-icao]");
    if (!btn || btn.disabled) return;
    e.preventDefault();
    const icao = btn.dataset.addIcao;
    if (addToList(icao)) {
      if (!selected.includes(icao)) {
        const sel = new Set([...selected, icao]);
        selected = list.filter((c) => sel.has(c));
      }
      syncInput();
      renderGrid();
      persist();
      if (searchInput) {
        searchInput.value = "";
        renderResults([]);
        searchInput.focus();
      }
    }
  });

  return {
    state() {
      return { selected: [...selected], list: [...list] };
    },
  };
}
