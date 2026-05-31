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

// Subtle footer cue for Tier-2 health. When the most recent Online call fell
// back (rate-limited / error) we italicize the credited provider's name,
// append a small "busy 58s" chip that *counts down in real time*, and surface
// a plain-English explanation on hover. When the countdown hits zero the chip
// flips to "ready" so the user knows they aren't retrying too early.
//
// Multi-provider: the credited brand may change between calls as the chain
// rolls over. The footer rewrites its link text + href on every Online call
// to reflect whichever provider served (or was last sticky-current). A
// successful subsequent call clears the degradation styling. State is
// intentionally NOT persisted across reloads.

// Module-level countdown bookkeeping. Stored here (not inside
// markTier2Attribution) so a second invocation cleanly cancels the prior
// timer instead of leaving a stale interval running against a removed chip.
let tier2CountdownTimer = null;
let tier2RetryAt = 0;
// Scope of the current fallback ("per_day" / "per_minute" / "unknown" / null)
// — drives the post-countdown chip text. We can't say "ready" after a
// per-day window because Google's retryDelay is a per-request back-off hint,
// not when the daily quota resets.
let tier2CountdownScope = null;

// Update the credited provider's brand text + URL in the footer. Called on
// every Online response (success OR error-with-tier2-info) so the footer
// reflects whoever is currently sticky in the chain. No-op if the page hasn't
// shipped the Tier-2 attribution span (defensive).
function applyTier2Brand(attribution) {
  const el = document.getElementById("tier2-attribution");
  if (!el || !attribution) return;
  const link = el.querySelector("a");
  if (!link) return;
  if (attribution.name && link.textContent !== attribution.name) {
    link.textContent = attribution.name;
  }
  if (attribution.url && link.href !== attribution.url) {
    link.href = attribution.url;
  }
}

function markTier2Attribution(state, detail, attribution) {
  const el = document.getElementById("tier2-attribution");
  if (!el) return;
  const link = el.querySelector("a");

  // Always update brand + clean prior decoration first — idempotent. A second
  // "ok" call from a recovered chain clears successfully even if no prior
  // fallback existed.
  applyTier2Brand(attribution);
  if (tier2CountdownTimer) {
    clearInterval(tier2CountdownTimer);
    tier2CountdownTimer = null;
  }
  el.querySelector(".tier2-busy")?.remove();

  if (state !== "fallback") {
    el.classList.remove("is-fallback");
    if (link) link.removeAttribute("title");
    return;
  }

  el.classList.add("is-fallback");

  // Hover summary (title attribute) — composed once at fallback-time. The
  // chip text below updates per tick, but the summary doesn't change as the
  // countdown progresses (the scope / limit don't shift).
  let summary = "Gemini is unavailable — Online searches are using the deterministic fallback.";
  const scope = detail?.scope ?? null;
  if (detail) {
    const scopeWord = scope === "per_day"
      ? "daily"
      : scope === "per_minute"
        ? "per-minute"
        : null;
    const retrySecs = Number.isFinite(detail.retry_after_seconds)
      ? detail.retry_after_seconds
      : null;
    const limit = Number.isFinite(detail.limit) ? detail.limit : null;

    const scopeText = scopeWord ? `${scopeWord} quota` : "rate-limit";
    const limitText = limit ? ` of ${limit}` : "";
    const retryText = retrySecs !== null ? ` Retry in ~${humanRetry(retrySecs)}.` : "";
    summary = `Gemini ${scopeText}${limitText} hit — using deterministic fallback.${retryText}`;

    // Caveat for the daily case: Google's retryDelay is a per-request
    // back-off hint, NOT the time until the daily quota resets — which is
    // typically midnight Pacific. Without this note, "Retry in ~7s" looks
    // like a quota-reset timer; the user waits 7s, retries, and gets 429
    // again until the actual daily reset.
    if (scope === "per_day" && retrySecs !== null) {
      summary += "\n\nNote: this is Google's suggested back-off between requests, "
        + "not when the daily quota resets. Free-tier daily quotas typically reset "
        + "at midnight Pacific.";
    }

    // Append the unmodified upstream error.message so the user can verify
    // our interpretation against the source. \n is honoured by native title
    // tooltips in every browser we care about.
    if (typeof detail.message === "string" && detail.message.trim()) {
      summary += "\n\n— Full Google error —\n" + detail.message.trim();
    }
  }
  if (link) link.title = summary;

  // Build the chip element once; we mutate its textContent on each tick.
  const chip = document.createElement("span");
  chip.className = "tier2-busy";
  el.append(chip);

  // If we know the retry window, anchor a wall-clock deadline and tick.
  // Computing remaining from `Date.now()` (rather than decrementing a
  // counter) means a backgrounded tab snaps back to the correct value when
  // it regains focus — `setInterval` is throttled in background tabs but
  // we don't accumulate drift.
  const retrySecs = detail && Number.isFinite(detail.retry_after_seconds)
    ? Math.max(0, detail.retry_after_seconds)
    : null;
  if (retrySecs === null) {
    // No retry info from the provider — show a static chip, no countdown.
    chip.textContent = " · busy";
    return;
  }
  tier2CountdownScope = scope;
  tier2RetryAt = Date.now() + retrySecs * 1000;
  tickTier2Countdown();
  tier2CountdownTimer = setInterval(tickTier2Countdown, 1000);
}

// One tick of the busy/ready countdown. Reads the current fallback state
// from the DOM so an external clear (markTier2Attribution("ok", ...) or a
// page-level reset) silently stops the interval on the next tick instead of
// fighting with the chip.
function tickTier2Countdown() {
  const el = document.getElementById("tier2-attribution");
  if (!el || !el.classList.contains("is-fallback")) {
    if (tier2CountdownTimer) {
      clearInterval(tier2CountdownTimer);
      tier2CountdownTimer = null;
    }
    return;
  }
  const chip = el.querySelector(".tier2-busy");
  if (!chip) return;
  const remainingMs = tier2RetryAt - Date.now();
  if (remainingMs <= 0) {
    // Predicted window has passed. For per-minute quotas that means a slot
    // is genuinely free → "ready". For per-day, Google's retryDelay was a
    // per-request back-off hint, not a quota-reset countdown — so we don't
    // tell the user "ready" when they're still over the daily limit; show
    // "daily limit" to indicate they'll likely keep getting 429 until the
    // actual reset (midnight Pacific). 'unknown' scope is treated like
    // per-minute (best-effort) because we have no better signal.
    chip.textContent = tier2CountdownScope === "per_day" ? " · daily limit" : " · ready";
    clearInterval(tier2CountdownTimer);
    tier2CountdownTimer = null;
  } else {
    chip.textContent = ` · busy ${humanRetry(Math.ceil(remainingMs / 1000))}`;
  }
}

// Format seconds into a short human string used by both the visible chip and
// the hover summary. Tier-2 retry windows are usually <60s (per-minute
// quota) or up to several hours (per-day, but Google often returns the
// short-window suggestion). Keep it compact: "7s" / "3m" / "1h 23m".
function humanRetry(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
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
    if (isOpen() === open) return;
    // Capture the Edit toggle's screen position before the layout reflow so
    // we can scroll the page to keep it under the user's finger / cursor.
    // Net effect: a second click in the same physical spot toggles back out.
    const beforeY = manageToggle?.getBoundingClientRect().top ?? 0;
    flipTiles(() => {
      control.classList.toggle("is-open", open);
      if (actionsEl) actionsEl.hidden = !open;
    });
    manageToggle?.setAttribute("aria-expanded", open ? "true" : "false");
    // preventScroll so the browser's default focus-into-view doesn't fight
    // the compensating scroll we're about to apply.
    if (open) query.focus({ preventScroll: true });
    const afterY = manageToggle?.getBoundingClientRect().top ?? 0;
    const delta = afterY - beforeY;
    if (Math.abs(delta) > 1) {
      window.scrollBy({ top: delta, left: 0, behavior: "auto" });
    }
  }

  // --- Initial paint ---

  syncHidden();
  renderTiles();
  ensureDataset();

  // --- Query input: autocomplete + tokenization ---

  let searchSeq = 0;
  let onlineSeq = 0;
  let onlineAbort = null;
  // True when runOnlineSearch auto-expanded the panel from a collapsed state.
  // We snap back to collapsed after the user picks a result so they don't get
  // stranded in edit mode after a one-click online search.
  let expandedForOnline = false;

  const clearBtn = control?.querySelector("#icao-query-clear") ?? null;
  function updateClearButton() {
    if (!clearBtn) return;
    const hasText = !!query.value;
    const searching = onlineAbort !== null;
    clearBtn.hidden = !(hasText || searching);
  }

  // Status states drive the CSS indicator next to the message:
  //   "loading"  → animated spinner (in-flight Online query)
  //   "notfound" → "no result" glyph (empty stations / 404 from proxy)
  //   "error"    → warning glyph (network failure / dataset unavailable)
  //   ""         → neutral text only; clears any prior indicator
  //
  // `trailIcon: "magnify"` appends an inline magnifier SVG after the message —
  // used by the "no local match — try Online" hint so the affordance physically
  // points at the magnifier button. Built as a DOM node (not innerHTML) so the
  // text portion stays escape-safe.
  function setStatus(text, state = "", trailIcon = "") {
    if (!searchStatusEl) return;
    searchStatusEl.textContent = text ?? "";
    if (trailIcon === "magnify") {
      const svgNS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("class", "status-trail-icon");
      svg.setAttribute("viewBox", "0 0 16 16");
      svg.setAttribute("width", "12");
      svg.setAttribute("height", "12");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("focusable", "false");
      const g = document.createElementNS(svgNS, "g");
      g.setAttribute("stroke", "currentColor");
      g.setAttribute("stroke-width", "1.6");
      g.setAttribute("fill", "none");
      g.setAttribute("stroke-linecap", "round");
      const circle = document.createElementNS(svgNS, "circle");
      circle.setAttribute("cx", "7"); circle.setAttribute("cy", "7"); circle.setAttribute("r", "4.5");
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", "10.2"); line.setAttribute("y1", "10.2");
      line.setAttribute("x2", "14");   line.setAttribute("y2", "14");
      g.append(circle, line);
      svg.append(g);
      searchStatusEl.append(svg);
    }
    searchStatusEl.classList.toggle("is-loading",  state === "loading");
    searchStatusEl.classList.toggle("is-notfound", state === "notfound");
    searchStatusEl.classList.toggle("is-error",    state === "error");
  }

  // --- Result-row truncation tooltip ---
  //
  // The result rows use `text-overflow: ellipsis` to clip long airport names.
  // Native `title` tooltips are slow (~700ms hover delay) and unstyled, and
  // they're flaky on disabled buttons; instead we render a styled balloon
  // appended to <body> so it escapes the dropdown's `overflow-y: auto` clip
  // (which would otherwise truncate any in-flow tooltip). The balloon shows
  // only when the name column is actually overflowing — non-truncated rows
  // hover silently.
  let resultTooltip = document.getElementById("icao-result-tooltip");
  if (!resultTooltip) {
    resultTooltip = document.createElement("div");
    resultTooltip.id = "icao-result-tooltip";
    resultTooltip.className = "result-tooltip";
    resultTooltip.setAttribute("role", "tooltip");
    document.body.append(resultTooltip);
  }

  function showResultTooltip(btn) {
    const text = btn.dataset.tooltip;
    if (!text) return;
    resultTooltip.textContent = text;
    resultTooltip.classList.add("is-visible");
    // Measure AFTER the tip becomes visible so we get its real height.
    const target = btn.getBoundingClientRect();
    const tip = resultTooltip.getBoundingClientRect();
    // Prefer placing above the row; fall back below when the top edge would
    // clip against the viewport. Horizontal: clamp inside the viewport with
    // a 4px safety margin so a long name doesn't run off the edge.
    const above = target.top - tip.height - 6;
    const below = target.bottom + 6;
    const top = above >= 4 ? above : below;
    const left = Math.max(4, Math.min(window.innerWidth - tip.width - 4, target.left));
    resultTooltip.style.top  = `${top}px`;
    resultTooltip.style.left = `${left}px`;
  }
  function hideResultTooltip() {
    resultTooltip.classList.remove("is-visible");
  }

  // After every render, walk the freshly-mounted buttons and flag those whose
  // name span actually overflows (scrollWidth > clientWidth). Only flagged
  // rows trigger the balloon — non-truncated names hover silently. Skip when
  // the dropdown is hidden (display:none → zero dimensions → false positives).
  function markTruncatedResults() {
    if (!searchResults || searchResults.hidden) return;
    for (const btn of searchResults.querySelectorAll(".icao-result")) {
      const name = btn.querySelector(".icao-result-name");
      const overflows = !!name && name.scrollWidth > name.clientWidth + 1;
      btn.classList.toggle("has-overflow", overflows);
    }
  }

  function renderResults(results) {
    if (!searchResults) return;
    // Any rerender invalidates whatever row the balloon was pointing at.
    hideResultTooltip();
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
      const fullName =
        `${a.name}${a.city ? `, ${a.city}` : ""}${a.country ? ` (${a.country})` : ""}`;
      nameSpan.textContent = fullName;
      // Tooltip content — surfaced by the custom balloon when the name column
      // is truncated, and announced via aria-label for screen readers. No
      // `title` attribute so the native (slow, unstyled) tooltip doesn't fight
      // the balloon. Markup-only: detection + show/hide live below.
      const tipLabel = `${a.icao}${a.iata ? ` (${a.iata})` : ""} — ${fullName}`;
      btn.dataset.tooltip = tipLabel;
      btn.setAttribute("aria-label", tipLabel);
      const hintSpan = document.createElement("span");
      hintSpan.className = "icao-result-hint";
      hintSpan.textContent = isSelected ? "active" : isListed ? "reactivate" : full ? "list full" : "add";

      btn.append(codeSpan, nameSpan, hintSpan);
      item.append(btn);
      searchResults.append(item);
    }
    markTruncatedResults();
  }

  // Render online (nearest-METAR) results into the same dropdown. Station shape:
  // { icao, name, distance_km }. Clicking reuses the data-add-icao handler.
  // Online search now returns one group per resolved location (ambiguous
  // queries like "King County" or "Springfield" produce multiple groups). Each
  // group's stations render under a section header showing the interpreted
  // location, so the user can pick from the right interpretation.
  function renderOnlineGroups(groups) {
    if (!searchResults) return;
    // Any rerender invalidates whatever row the balloon was pointing at.
    hideResultTooltip();
    searchResults.innerHTML = "";
    const nonEmpty = (groups || []).filter((g) => Array.isArray(g.stations) && g.stations.length);
    if (!nonEmpty.length) {
      searchResults.hidden = true;
      return;
    }
    searchResults.hidden = false;
    const full = list.length >= LIST_MAX;
    const showHeaders = nonEmpty.length > 1; // skip the visual divider when there's only one group

    for (const group of nonEmpty) {
      if (showHeaders) {
        const header = document.createElement("li");
        header.className = "icao-result-group-header";
        header.setAttribute("role", "presentation");
        header.textContent = group.interpreted ?? "";
        searchResults.append(header);
      }
      for (const s of group.stations) {
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
        const fullName = `${s.name || s.icao}${dist}`;
        nameSpan.textContent = fullName;
        // Tooltip content surfaced by the custom balloon (see markTruncated()
        // below); aria-label for screen readers. No native `title` so we don't
        // get a competing OS tooltip after the half-second hover delay.
        const tipLabel = `${s.icao} — ${fullName}`;
        btn.dataset.tooltip = tipLabel;
        btn.setAttribute("aria-label", tipLabel);

        const hintSpan = document.createElement("span");
        hintSpan.className = "icao-result-hint icao-result-online";
        // Same label as the local results — "online" is redundant once the
        // user is already reviewing online-resolved groups.
        hintSpan.textContent = isSelected ? "active" : isListed ? "reactivate" : full ? "list full" : "add";

        btn.append(codeSpan, nameSpan, hintSpan);
        item.append(btn);
        searchResults.append(item);
      }
    }
    markTruncatedResults();
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
      setStatus("Search unavailable — type the ICAO directly.", "error");
      return;
    }
    setStatus("");
    const results = searchAirports(q.trim(), data, { limit: 8 });
    if (seq !== searchSeq) return;
    renderResults(results);
    if (results.length === 0) {
      // Append the magnifier glyph so the hint visually points at the Online
      // button the user should click next. Same icon shape as the button itself.
      setStatus(`No local match for "${q.trim()}" — try Online `, "", "magnify");
    }
  }

  query.addEventListener("input", () => {
    // A new keystroke supersedes any in-flight OR just-resolved online search:
    // abort the request and bump the seq so a late response is discarded.
    // Also clear the Online button's busy visuals — runOnlineSearch's
    // finally{} only clears if seq===onlineSeq, which is no longer true after
    // we bump it here, so stale .is-loading would otherwise persist.
    if (onlineAbort) {
      onlineAbort.abort();
      onlineAbort = null;
      onlineBtn?.classList.remove("is-loading");
      onlineBtn?.removeAttribute("aria-busy");
    }
    onlineSeq++;
    // Editing always clears any prior loading/not-found/error indicator so the
    // user gets a fresh slate; runSearch overlays its own status as needed.
    setStatus("");
    updateClearButton();
    runSearch(query.value);
  });

  clearBtn?.addEventListener("click", () => {
    // One click backs out of an in-flight search OR clears the input. Both
    // converge on a clean slate so the user can start over.
    if (onlineAbort) {
      onlineAbort.abort();
      onlineAbort = null;
      onlineSeq++;
    }
    onlineBtn?.classList.remove("is-loading");
    onlineBtn?.removeAttribute("aria-busy");
    query.value = "";
    renderResults([]);
    renderOnlineGroups([]);
    setStatus("");
    updateClearButton();
    query.focus();
  });

  // Initial paint of the clear button (hidden when the input starts empty).
  updateClearButton();

  // "Online ↗" — resolve the freeform query to nearby METAR stations via the PHP
  // proxy (Tier-1 deterministic + optional free-LLM Tier-2, grounded in live
  // aviationweather.gov data). On-click only; results land in the same dropdown.
  async function runOnlineSearch() {
    const q = query.value.trim();
    if (!q) {
      renderResults([]); // clear any stale results before prompting
      setStatus("Type a place, ZIP, or airport, then tap Online.");
      return;
    }
    // The Online button is reachable from collapsed mode (so a single click
    // does the search). When that happens, transition into expanded mode so
    // the results dropdown is visible immediately under the query line — and
    // remember that we did it, so we can snap back after a selection.
    if (!isOpen()) {
      setOpen(true);
      expandedForOnline = true;
    }

    const seq = ++onlineSeq;
    if (onlineAbort) onlineAbort.abort();
    onlineAbort = new AbortController();
    onlineBtn?.classList.add("is-loading");
    onlineBtn?.setAttribute("aria-busy", "true");
    setStatus("Searching online…", "loading");
    updateClearButton();
    try {
      const res = await fetch(`./api/resolve.php?q=${encodeURIComponent(q)}`, { signal: onlineAbort.signal });
      if (seq !== onlineSeq) return;
      const data = await res.json().catch(() => null);
      // Subtle footer cue: italicize the credited provider's name + show a
      // small "busy ~7s" chip when Tier-2 fell back on this call. Reset to
      // neutral on a successful Tier-2 response. The credited brand may swap
      // between providers as the chain rolls over — `data.tier2_attribution`
      // carries the brand text + URL to render in the footer link. Quota
      // detail (scope, limit, retry window) comes from server-side parsing
      // of provider 429 bodies (Gemini's google.rpc.RetryInfo is the richest).
      //
      // Fires on both success (data) and structured errors (data with `error`),
      // since the server includes tier2 metadata on 404s too so the user can
      // see "Gemini busy" when the failure was provider-driven.
      const tier2 = data?.tier2;
      const attribution = data?.tier2_attribution;
      if (tier2 === "live" || tier2 === "off") {
        markTier2Attribution("ok", null, attribution);
      } else if (tier2 === "fallback") {
        markTier2Attribution("fallback", data?.tier2_detail, attribution);
      }
      if (!res.ok || !data) {
        renderOnlineGroups([]);
        // A structured error from the proxy ("couldn't work out a location…")
        // is semantically not-found; a fetch with no body at all is an error.
        setStatus(
          data?.error ?? "Online search is unavailable right now.",
          data?.error ? "notfound" : "error",
        );
        return;
      }
      // Filter to groups that actually have stations BEFORE we render or
      // compute the status — otherwise an empty-station group inflates
      // groups.length and the "Multiple matches (N)" copy desyncs with the
      // visibly-rendered N. The server currently drops empty groups too, but
      // we belt-and-suspender it here in case that contract slips.
      const groups = Array.isArray(data.groups) ? data.groups : [];
      const nonEmpty = groups.filter((g) => Array.isArray(g.stations) && g.stations.length);
      renderOnlineGroups(nonEmpty);
      if (nonEmpty.length === 0) {
        setStatus("No nearby reporting stations found.", "notfound");
      } else if (nonEmpty.length === 1) {
        setStatus(nonEmpty[0].interpreted ?? "");
      } else {
        setStatus(`Multiple matches (${nonEmpty.length}) — pick one`);
      }
    } catch (err) {
      if (err?.name === "AbortError") return;
      renderOnlineGroups([]);
      setStatus("Online search failed — try again.", "error");
    } finally {
      // Only clear the in-flight indicator if THIS call is still the latest;
      // a newer click may already have its own spinner running.
      if (seq === onlineSeq) {
        onlineBtn?.classList.remove("is-loading");
        onlineBtn?.removeAttribute("aria-busy");
        onlineAbort = null;
        updateClearButton();
      }
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
    // Syntactic 4-letter check alone tokenizes common English words like
    // "BASE" or "TIME" when users type natural-language queries. Require the
    // code to actually be known — present in the seed or the loaded airports
    // dataset. When the dataset is still loading we fall back to syntax-only
    // so a fast typer can still tile real codes before data arrives.
    const datasetReady = dataset !== null;
    const looksReal =
      isValidIcao(up) &&
      (!datasetReady || describeIcao(up, lookupByIcao) !== null);
    if (looksReal) {
      e.preventDefault();
      query.value = trimmed.slice(0, trimmed.length - lastWord.length).replace(/[ ,]+$/, "");
      addAndSelect(up);
      runSearch(query.value);
    } else if (e.key === "Enter") {
      // Enter (or the iOS "Go" key) on a non-ICAO query fires the Online
      // search instead of submitting the parent METAR form — same as
      // tapping the magnifier button.
      e.preventDefault();
      runOnlineSearch();
    }
  });

  // Balloon tooltip wiring — two distinct triggers, never on focus:
  //
  //   Desktop: hover the row → show; mouse leaves → hide. Movement onto a
  //   child element of the same button keeps it visible (relatedTarget guard).
  //
  //   Touch:   long-press (~450 ms still on the row) → show + suppress the
  //   synthetic click so the airport isn't added by the long-press. Release,
  //   move, or cancel → hide.
  //
  // We deliberately do NOT listen on `focusin`: iOS fires focusin during a
  // tap-down, which used to make the balloon appear AFTER selection and
  // stick. Screen-reader accessibility is preserved via the button's
  // `aria-label` (set in render*), which announces the full label whether
  // or not the visual balloon is shown.

  searchResults?.addEventListener("mouseover", (e) => {
    const btn = e.target.closest(".icao-result.has-overflow");
    if (btn) showResultTooltip(btn);
  });
  searchResults?.addEventListener("mouseout", (e) => {
    const btn = e.target.closest(".icao-result.has-overflow");
    if (btn && !btn.contains(e.relatedTarget)) hideResultTooltip();
  });

  // Long-press for touch. State is scoped to the dropdown listeners so
  // multiple rapid touches don't interleave timers across rows.
  let touchPressTimer = null;
  let touchTooltipShown = false;
  function cancelLongPress() {
    if (touchPressTimer) {
      clearTimeout(touchPressTimer);
      touchPressTimer = null;
    }
  }
  searchResults?.addEventListener("touchstart", (e) => {
    const btn = e.target.closest(".icao-result.has-overflow");
    if (!btn) return;
    cancelLongPress();
    touchTooltipShown = false;
    // 450 ms is the iOS default long-press threshold; mirrors the Safari
    // "tap-and-hold" feel users already know from selecting links / images.
    touchPressTimer = setTimeout(() => {
      showResultTooltip(btn);
      touchTooltipShown = true;
      touchPressTimer = null;
    }, 450);
  }, { passive: true });
  searchResults?.addEventListener("touchmove", () => {
    // Any drag-like movement cancels the long-press AND dismisses an already-
    // shown balloon — matches how the iOS text-selection magnifier behaves.
    cancelLongPress();
    if (touchTooltipShown) { hideResultTooltip(); touchTooltipShown = false; }
  }, { passive: true });
  searchResults?.addEventListener("touchcancel", () => {
    cancelLongPress();
    if (touchTooltipShown) { hideResultTooltip(); touchTooltipShown = false; }
  });
  searchResults?.addEventListener("touchend", (e) => {
    cancelLongPress();
    if (touchTooltipShown) {
      // Long-press completed: release dismisses the balloon, and we also
      // suppress the synthetic click so the airport isn't added unintentionally.
      // Short taps fall through here without preventDefault, so normal
      // selection still works.
      hideResultTooltip();
      touchTooltipShown = false;
      e.preventDefault();
    }
  });

  // The balloon is `position: fixed` — once the user scrolls (page or the
  // dropdown's own overflow:auto box) the anchored position is stale, so
  // hide. Re-hover repositions if still pointing at the row.
  searchResults?.addEventListener("scroll", hideResultTooltip, { passive: true });
  window.addEventListener("scroll", hideResultTooltip, { passive: true });

  searchResults?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-add-icao]");
    if (!btn || btn.disabled) return;
    e.preventDefault();
    // Defensive — any selection always clears the balloon. Belt-and-suspenders
    // against an in-flight long-press timer that's about to fire, or a stale
    // visible state we missed via touchend on flaky touch hardware.
    cancelLongPress();
    hideResultTooltip();
    if (addAndSelect(btn.dataset.addIcao)) {
      query.value = "";
      renderResults([]);
      setStatus("");
      updateClearButton();
      // If runOnlineSearch auto-expanded us from collapsed, snap back now
      // that the user has made a selection — they didn't ask for edit mode.
      // Move focus to the Edit toggle so keyboard users keep an explicit
      // focus target (otherwise focus falls back to <body> on collapse).
      if (expandedForOnline) {
        expandedForOnline = false;
        setOpen(false);
        manageToggle?.focus({ preventScroll: true });
      } else {
        query.focus();
      }
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
  // Horizontal chip flow in collapsed mode, vertical row stack in expanded.
  // Use clientX vs clientY to detect "before/after" depending on the axis.
  function isDropBefore(rect, e) {
    return isOpen()
      ? e.clientY < rect.top + rect.height / 2
      : e.clientX < rect.left + rect.width / 2;
  }
  tiles.addEventListener("dragover", (e) => {
    if (!dragIcao) return;
    const row = e.target.closest(".tile");
    if (!row || row.dataset.icao === dragIcao) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const before = isDropBefore(row.getBoundingClientRect(), e);
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
    const before = isDropBefore(row.getBoundingClientRect(), e);
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

  manageToggle?.addEventListener("click", () => {
    // Manual toggle: user wants explicit control of the panel state, so drop
    // the auto-collapse intent that runOnlineSearch may have set.
    expandedForOnline = false;
    setOpen(!isOpen());
  });
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
