// User-editable ICAO list — tokenized "tile" control (prototype).
//
// Model (unchanged from the previous checkbox-list version):
//   list      — ordered ICAOs the user keeps (1..LIST_MAX). Drag/arrows reorder
//               it; the − button removes from it.
//   selected  — the *active* subset of `list` = the form value (`ids`). Order
//               mirrors `list`.
//
// Presentation (new):
//   * Each ICAO is a TILE. Collapsed, only ACTIVE tiles show as compact chips.
//   * Expanding (manage toggle) morphs tiles into list rows carrying a check
//     toggle, drag handle, ↑/↓ arrows and − delete; unchecked tiles show in
//     place. A query line (the text input) sits at the top with the Online
//     button; unresolved text stays there for searching.
//   * The text input tokenizes: a completed valid ICAO becomes a tile; non-ICAO
//     text (e.g. "Ilwaco metar") stays as the query for local autocomplete /
//     the Online search.
//   * A hidden <input name="ids"> is kept in sync for the GET submit.

import { DEFAULT_SEED, DEFAULT_SELECTED, seedAirport } from "./airports.js";
import { LIST_MIN, LIST_MAX } from "./storage.js";
import { isValidIcao } from "./metar.js";
import { loadAirports, searchAirports } from "./search.js";

function uniq(codes) {
  return Array.from(new Set(codes));
}

function describeIcao(icao, lookupByIcao) {
  const seed = seedAirport(icao);
  if (seed) return seed.name;
  const looked = lookupByIcao?.get(icao);
  if (looked) return `${looked.name}${looked.city ? ` — ${looked.city}` : ""}`;
  return null;
}

export function initIcaoControl({
  control,        // #tile-control wrapper (toggles .is-open)
  hiddenIds,      // hidden <input name="ids"> for form submit
  query,          // text/query <input>
  tiles,          // <ol> tile container
  countEl,        // count badge
  actionsEl,      // defaults/all/none
  searchResults,  // autocomplete <ul>
  searchStatusEl, // status line
  onlineBtn,      // "Online ↗" button (placeholder)
  manageToggle,   // expand/collapse toggle
  store,
}) {
  const initial = store.load();
  let list = uniq(initial.list).slice(0, LIST_MAX).filter(isValidIcao);
  if (list.length === 0) list = [...DEFAULT_SEED];
  let selected = uniq(initial.selected).filter(isValidIcao);
  for (const c of selected) {
    if (!list.includes(c) && list.length < LIST_MAX) list.push(c);
  }

  const lookupByIcao = new Map();
  let dataset = null;
  let datasetPromise = null;

  // Cache the in-flight load so concurrent callers (e.g. fast keystrokes) all
  // await the SAME promise and receive the real dataset. Returning early while a
  // load was in flight used to hand back a still-null dataset, making the first
  // search wrongly report "unavailable".
  async function ensureDataset() {
    if (dataset) return dataset;
    if (!datasetPromise) {
      datasetPromise = (async () => {
        try {
          const data = await loadAirports();
          dataset = data;
          for (const a of data) lookupByIcao.set(a.icao, a);
          renderTiles(); // names resolve once the dataset is in
          return data;
        } catch {
          datasetPromise = null; // allow a later retry
          return null;
        }
      })();
    }
    return datasetPromise;
  }

  // --- Model mutations ---

  function addToList(icao, index = null) {
    if (!isValidIcao(icao) || list.includes(icao) || list.length >= LIST_MAX) return false;
    if (index === null || index >= list.length) list.push(icao);
    else list.splice(Math.max(0, index), 0, icao);
    return true;
  }

  // Index just after the last currently-selected tile (in list order).
  function indexAfterLastSelected() {
    let last = -1;
    for (let i = 0; i < list.length; i++) if (selected.includes(list[i])) last = i;
    return last >= 0 ? last + 1 : list.length;
  }

  function selectInOrder(icao) {
    if (selected.includes(icao)) return;
    const set = new Set([...selected, icao]);
    selected = list.filter((c) => set.has(c));
  }

  // Add a code and activate it, inserted right after the last active tile.
  function addAndSelect(icao) {
    if (list.includes(icao)) {
      selectInOrder(icao);
    } else if (!addToList(icao, indexAfterLastSelected())) {
      return false;
    } else {
      selectInOrder(icao);
    }
    commit();
    return true;
  }

  function removeFromList(icao) {
    if (list.length <= LIST_MIN) return false;
    list = list.filter((c) => c !== icao);
    selected = selected.filter((c) => c !== icao);
    return true;
  }

  function toggleSelected(icao) {
    if (selected.includes(icao)) selected = selected.filter((c) => c !== icao);
    else selectInOrder(icao);
  }

  function moveTo(icao, newIndex) {
    const from = list.indexOf(icao);
    if (from < 0) return false;
    const clamped = Math.max(0, Math.min(list.length - 1, newIndex));
    if (clamped === from) return false;
    list.splice(from, 1);
    list.splice(clamped, 0, icao);
    const set = new Set(selected);
    selected = list.filter((c) => set.has(c));
    return true;
  }

  // --- Rendering ---

  function syncHidden() {
    hiddenIds.value = selected.join(" ");
  }

  function updateCount() {
    if (countEl) countEl.textContent = `(${selected.length}/${list.length})`;
  }

  // Persist + re-render + keep the hidden input current. The single "after a
  // change" entry point.
  function commit() {
    store.save({ selected: uniq(selected), list: uniq(list) });
    syncHidden();
    renderTiles();
  }

  function makeTile(icao, index) {
    const li = document.createElement("li");
    li.className = "tile" + (selected.includes(icao) ? " is-active" : "");
    li.dataset.icao = icao;
    li.draggable = true;

    const handle = document.createElement("span");
    handle.className = "tile-drag";
    handle.textContent = "⋮⋮";
    handle.setAttribute("aria-hidden", "true");

    const check = document.createElement("button");
    check.type = "button";
    check.className = "tile-check";
    check.dataset.toggleIcao = icao;
    check.setAttribute("aria-pressed", selected.includes(icao) ? "true" : "false");
    check.setAttribute("aria-label", `${selected.includes(icao) ? "Hide" : "Show"} ${icao}`);

    const code = document.createElement("span");
    code.className = "tile-code";
    code.textContent = icao;
    check.append(code);

    // Name lives OUTSIDE the pill so the pill stays a code-only chip (matching
    // the collapsed look); the name shows beside it when expanded.
    const name = describeIcao(icao, lookupByIcao);
    let nameEl = null;
    if (name) {
      nameEl = document.createElement("span");
      nameEl.className = "tile-name";
      nameEl.textContent = name;
    }

    const controls = document.createElement("span");
    controls.className = "tile-controls";
    const up = document.createElement("button");
    up.type = "button";
    up.className = "tile-up";
    up.dataset.moveIcao = icao;
    up.dataset.direction = "up";
    up.title = "Move up";
    up.setAttribute("aria-label", `Move ${icao} up`);
    up.textContent = "↑";
    up.disabled = index === 0;
    const down = document.createElement("button");
    down.type = "button";
    down.className = "tile-down";
    down.dataset.moveIcao = icao;
    down.dataset.direction = "down";
    down.title = "Move down";
    down.setAttribute("aria-label", `Move ${icao} down`);
    down.textContent = "↓";
    down.disabled = index === list.length - 1;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "tile-remove";
    remove.dataset.removeIcao = icao;
    remove.title = "Remove";
    remove.setAttribute("aria-label", `Remove ${icao}`);
    remove.textContent = "−";
    remove.disabled = list.length <= LIST_MIN;
    controls.append(up, down, remove);

    li.append(handle, check);
    if (nameEl) li.append(nameEl);
    li.append(controls);
    return li;
  }

  function renderTiles() {
    // commit() re-renders on every toggle/reorder/remove, which would drop
    // keyboard focus when the DOM is rebuilt. Capture the focused control's
    // identity and restore focus to its rebuilt equivalent — falling back to the
    // same tile's pill when a reorder leaves the pressed arrow disabled.
    const active = document.activeElement;
    let sel = null;
    let focusedIcao = null;
    if (active && tiles.contains(active)) {
      focusedIcao = active.closest(".tile")?.dataset.icao ?? null;
      if (active.dataset.toggleIcao) {
        sel = `[data-toggle-icao='${active.dataset.toggleIcao}']`;
      } else if (active.dataset.moveIcao) {
        sel = `[data-move-icao='${active.dataset.moveIcao}'][data-direction='${active.dataset.direction}']`;
      } else if (active.dataset.removeIcao) {
        sel = `[data-remove-icao='${active.dataset.removeIcao}']`;
      }
    }

    tiles.innerHTML = "";
    list.forEach((icao, i) => tiles.append(makeTile(icao, i)));
    updateCount();

    if (sel) {
      const match = tiles.querySelector(sel);
      if (match && !match.disabled) match.focus();
      else if (focusedIcao) tiles.querySelector(`[data-toggle-icao='${focusedIcao}']`)?.focus();
    }
  }

  // --- Expand / collapse ---

  function isOpen() {
    return control.classList.contains("is-open");
  }

  // FLIP: animate tiles from their current positions to wherever the layout
  // change (mutate) lands them. Translate-only (no scale) so text doesn't
  // distort; tiles that appear (were hidden) fade in. Skipped when the tab is
  // hidden, reduced-motion is requested, or rAF is unavailable.
  function flipTiles(mutate) {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (reduce || document.hidden || typeof requestAnimationFrame !== "function") {
      mutate();
      return;
    }
    const items = Array.from(tiles.children);
    const first = new Map();
    for (const li of items) {
      const r = li.getBoundingClientRect();
      if (r.width || r.height) first.set(li, r);
    }
    mutate();
    for (const li of items) {
      const last = li.getBoundingClientRect();
      const f = first.get(li);
      if (f && (last.width || last.height) &&
          (Math.abs(f.left - last.left) > 0.5 || Math.abs(f.top - last.top) > 0.5)) {
        li.style.transition = "none";
        li.style.transform = `translate(${f.left - last.left}px, ${f.top - last.top}px)`;
        requestAnimationFrame(() => {
          li.style.transition = "transform 0.22s ease";
          li.style.transform = "";
        });
        li.addEventListener("transitionend", function done() {
          li.style.transition = "";
          li.removeEventListener("transitionend", done);
        });
      } else if (!f && (last.width || last.height)) {
        li.style.transition = "none";
        li.style.opacity = "0";
        requestAnimationFrame(() => {
          li.style.transition = "opacity 0.22s ease";
          li.style.opacity = "";
        });
        li.addEventListener("transitionend", function done() {
          li.style.transition = "";
          li.style.opacity = "";
          li.removeEventListener("transitionend", done);
        });
      }
    }
  }

  function setOpen(open) {
    flipTiles(() => {
      control.classList.toggle("is-open", open);
      if (onlineBtn) onlineBtn.hidden = !open;
      if (actionsEl) actionsEl.hidden = !open;
    });
    manageToggle?.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) query.focus();
  }

  // --- Initial paint ---

  syncHidden();
  renderTiles();
  ensureDataset();

  // --- Query input: autocomplete + tokenization ---

  let searchSeq = 0;
  let onlineSeq = 0;
  let onlineAbort = null;

  function setStatus(text) {
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
      // Reactivating an already-listed airport doesn't consume a list slot, so
      // only block it when it's already active, or when the list is full AND
      // this airport isn't already in it.
      const isListed = list.includes(a.icao);
      const isSelected = selected.includes(a.icao);
      btn.disabled = isSelected || (full && !isListed);

      const codeSpan = document.createElement("span");
      codeSpan.className = "icao-result-code";
      const codeStrong = document.createElement("strong");
      codeStrong.textContent = a.icao;
      codeSpan.append(codeStrong);
      if (a.iata) {
        const em = document.createElement("em");
        em.textContent = a.iata;
        codeSpan.append(" ", em);
      }
      const nameSpan = document.createElement("span");
      nameSpan.className = "icao-result-name";
      nameSpan.textContent =
        `${a.name}${a.city ? `, ${a.city}` : ""}${a.country ? ` (${a.country})` : ""}`;
      const hintSpan = document.createElement("span");
      hintSpan.className = "icao-result-hint";
      hintSpan.textContent = isSelected ? "active" : isListed ? "reactivate" : full ? "list full" : "add";

      btn.append(codeSpan, nameSpan, hintSpan);
      item.append(btn);
      searchResults.append(item);
    }
  }

  // Render online (nearest-METAR) results into the same dropdown. Station shape:
  // { icao, name, distance_km }. Clicking reuses the data-add-icao handler.
  function renderOnlineResults(stations) {
    if (!searchResults) return;
    searchResults.innerHTML = "";
    if (!stations.length) {
      searchResults.hidden = true;
      return;
    }
    searchResults.hidden = false;
    const full = list.length >= LIST_MAX;
    for (const s of stations) {
      const item = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "icao-result";
      btn.dataset.addIcao = s.icao;
      const isListed = list.includes(s.icao);
      const isSelected = selected.includes(s.icao);
      btn.disabled = isSelected || (full && !isListed);

      const codeSpan = document.createElement("span");
      codeSpan.className = "icao-result-code";
      const codeStrong = document.createElement("strong");
      codeStrong.textContent = s.icao;
      codeSpan.append(codeStrong);

      const nameSpan = document.createElement("span");
      nameSpan.className = "icao-result-name";
      const dist = typeof s.distance_km === "number" ? ` · ${s.distance_km} km` : "";
      nameSpan.textContent = `${s.name || s.icao}${dist}`;

      const hintSpan = document.createElement("span");
      hintSpan.className = "icao-result-hint icao-result-online";
      hintSpan.textContent = isSelected ? "active" : isListed ? "reactivate" : full ? "list full" : "online";

      btn.append(codeSpan, nameSpan, hintSpan);
      item.append(btn);
      searchResults.append(item);
    }
  }

  async function runSearch(q) {
    if (!q || q.trim().length < 2) {
      renderResults([]);
      setStatus("");
      return;
    }
    const seq = ++searchSeq;
    setStatus("Loading airports…");
    const data = await ensureDataset();
    if (seq !== searchSeq) return;
    if (!data) {
      setStatus("Search unavailable — type the ICAO directly.");
      return;
    }
    setStatus("");
    const results = searchAirports(q.trim(), data, { limit: 8 });
    if (seq !== searchSeq) return;
    renderResults(results);
    if (results.length === 0) setStatus(`No local match for "${q.trim()}" — try Online.`);
  }

  query.addEventListener("input", () => {
    if (onlineAbort) onlineAbort.abort(); // a new keystroke supersedes an online search
    runSearch(query.value);
  });

  // "Online ↗" — resolve the freeform query to nearby METAR stations via the PHP
  // proxy (Tier-1 deterministic + optional free-LLM Tier-2, grounded in live
  // aviationweather.gov data). On-click only; results land in the same dropdown.
  async function runOnlineSearch() {
    const q = query.value.trim();
    if (!q) {
      setStatus("Type a place, ZIP, or airport, then tap Online.");
      return;
    }
    const seq = ++onlineSeq;
    if (onlineAbort) onlineAbort.abort();
    onlineAbort = new AbortController();
    setStatus("Searching online…");
    try {
      const res = await fetch(`./api/resolve.php?q=${encodeURIComponent(q)}`, { signal: onlineAbort.signal });
      if (seq !== onlineSeq) return;
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        renderOnlineResults([]);
        setStatus(data?.error ?? "Online search is unavailable right now.");
        return;
      }
      const stations = Array.isArray(data.stations) ? data.stations : [];
      renderOnlineResults(stations);
      setStatus(stations.length ? (data.interpreted ?? "") : "No nearby reporting stations found.");
    } catch (err) {
      if (err?.name === "AbortError") return;
      renderOnlineResults([]);
      setStatus("Online search failed — try again.");
    }
  }

  onlineBtn?.addEventListener("click", runOnlineSearch);

  // Tokenize on a delimiter only when the just-completed word is a valid ICAO,
  // so place queries like "Ilwaco metar" keep their spaces.
  query.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" && query.value === "") {
      // Emoji-style: one Backspace from an empty cursor drops the last active tile.
      const lastActive = list.filter((c) => selected.includes(c)).pop();
      if (lastActive) {
        e.preventDefault();
        toggleSelected(lastActive);
        commit();
      }
      return;
    }
    if (e.key !== " " && e.key !== "," && e.key !== "Enter") return;
    const trimmed = query.value.replace(/[ ,]+$/, "");
    const lastWord = trimmed.split(/[ ,]+/).pop() ?? "";
    const up = lastWord.toUpperCase();
    if (isValidIcao(up)) {
      e.preventDefault();
      query.value = trimmed.slice(0, trimmed.length - lastWord.length).replace(/[ ,]+$/, "");
      addAndSelect(up);
      runSearch(query.value);
    } else if (e.key === "Enter") {
      e.preventDefault(); // don't submit the form from the query line
    }
  });

  searchResults?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-add-icao]");
    if (!btn || btn.disabled) return;
    e.preventDefault();
    if (addAndSelect(btn.dataset.addIcao)) {
      query.value = "";
      renderResults([]);
      setStatus("");
      query.focus();
    }
  });

  // --- Tile interactions: check toggle / remove / reorder ---

  tiles.addEventListener("click", (e) => {
    const toggle = e.target.closest("button[data-toggle-icao]");
    if (toggle) {
      e.preventDefault();
      toggleSelected(toggle.dataset.toggleIcao);
      commit();
      return;
    }
    const remove = e.target.closest("button.tile-remove");
    if (remove) {
      e.preventDefault();
      if (removeFromList(remove.dataset.removeIcao)) commit();
      return;
    }
    const move = e.target.closest("button[data-move-icao]");
    if (move) {
      e.preventDefault();
      const icao = move.dataset.moveIcao;
      const delta = move.dataset.direction === "up" ? -1 : 1;
      if (moveTo(icao, list.indexOf(icao) + delta)) commit();
    }
  });

  // --- Drag and drop reorder ---

  let dragIcao = null;
  function clearDropMarkers() {
    for (const r of tiles.querySelectorAll(".drop-before, .drop-after")) {
      r.classList.remove("drop-before", "drop-after");
    }
  }
  tiles.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".tile");
    if (!row) return;
    dragIcao = row.dataset.icao;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragIcao);
    row.classList.add("dragging");
  });
  tiles.addEventListener("dragover", (e) => {
    if (!dragIcao) return;
    const row = e.target.closest(".tile");
    if (!row || row.dataset.icao === dragIcao) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = row.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    clearDropMarkers();
    row.classList.add(before ? "drop-before" : "drop-after");
  });
  tiles.addEventListener("dragleave", (e) => {
    if (!tiles.contains(e.relatedTarget)) clearDropMarkers();
  });
  tiles.addEventListener("drop", (e) => {
    if (!dragIcao) return;
    const row = e.target.closest(".tile");
    if (!row || row.dataset.icao === dragIcao) { clearDropMarkers(); return; }
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    const targetIndex = list.indexOf(row.dataset.icao);
    const fromIndex = list.indexOf(dragIcao);
    let newIndex = before ? targetIndex : targetIndex + 1;
    if (fromIndex < newIndex) newIndex -= 1;
    if (moveTo(dragIcao, newIndex)) commit();
    clearDropMarkers();
  });
  tiles.addEventListener("dragend", () => {
    dragIcao = null;
    for (const r of tiles.querySelectorAll(".dragging")) r.classList.remove("dragging");
    clearDropMarkers();
  });

  // --- Action buttons ---

  actionsEl?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    e.preventDefault();
    switch (btn.dataset.action) {
      case "select-defaults": list = [...DEFAULT_SEED]; selected = [...DEFAULT_SELECTED]; break;
      case "select-all": selected = [...list]; break;
      case "select-none": selected = []; break;
    }
    commit();
  });

  // --- Manage toggle ---

  manageToggle?.addEventListener("click", () => setOpen(!isOpen()));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) {
      setOpen(false);
      manageToggle?.focus();
    }
  });

  return {
    state() {
      return { selected: [...selected], list: [...list] };
    },
  };
}
