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
import { LIST_MIN, LIST_MAX, createCustomNamesStore } from "./storage.js";
import { isValidIcao } from "./metar.js";
import { loadAirports, searchAirports } from "./search.js";

function uniq(codes) {
  return Array.from(new Set(codes));
}

function describeIcao(icao, lookupByIcao, customNames) {
  // Source priority:
  //   1. Static seed (DEFAULT_SEED) — curated short names for the prepopulated
  //      Pacific NW list, always present.
  //   2. Loaded bundled dataset (airports.json) — ~12k entries with name+city.
  //   3. Custom names captured from Online ↗ adds (e.g. KSMP = "Stampede Pass"
  //      from aviationweather.gov), persisted in localStorage. Fallback for
  //      AWC weather sites that aren't in the bundled airports dataset.
  const seed = seedAirport(icao);
  if (seed) return seed.name;
  const looked = lookupByIcao?.get(icao);
  if (looked) return `${looked.name}${looked.city ? ` — ${looked.city}` : ""}`;
  const custom = customNames?.get(icao);
  if (custom) return custom;
  return null;
}

// Subtle footer cue for Tier-2 health. The footer lists every configured
// provider in the chain (Gemini · OpenRouter · Cerebras · Groq) as static
// credits. When the chain rolls forward on a 429 / error, we italicize ONLY
// the specific provider's name + append a small "busy 58s" chip that counts
// down in real time. A successful subsequent call clears the styling. State
// is intentionally NOT persisted across reloads.

// Prune the static footer list to only credit providers this deploy can
// actually call. Fires once on init from a page-level entry point; calls
// the /api/health.php endpoint which reports which API keys are configured
// in qmtweb-secrets.php. On failure (older deploys without health.php, or
// http-server in dev/CI which can't run PHP) we silently bail and leave the
// full static list in place — degraded but not broken.
export async function initTier2Health() {
  const list = document.getElementById("tier2-list");
  if (!list) return;
  try {
    const res = await fetch("./api/health.php", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    const providers = Array.isArray(data?.tier2_providers) ? data.tier2_providers : [];
    if (!providers.length) return; // no data → leave HTML as-is
    const configured = new Set(
      providers.filter((p) => p && p.configured && typeof p.name === "string").map((p) => p.name),
    );
    // Remove (not just hide) unconfigured links so the CSS adjacent-sibling
    // separator selector reflects the actual visible order. display:none
    // would leave the link in the DOM and the separator rule would still see
    // it as adjacent, dropping " · " incorrectly.
    list.querySelectorAll("a[data-provider]").forEach((a) => {
      if (!configured.has(a.dataset.provider)) a.remove();
    });
  } catch {
    // Network error / endpoint missing — leave the static HTML untouched.
  }
}

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

// Reorder the chain list so the sticky-current (last successful) provider is
// listed first — emphasises which service is actually doing the work right
// now. CSS separators (` · `) regenerate automatically since they're driven
// by adjacent-sibling selectors. When `provider` is null/unknown, the list
// keeps its previous order (no-op).
function reorderTier2List(provider) {
  const list = document.getElementById("tier2-list");
  if (!list || !provider) return;
  const sticky = list.querySelector(`a[data-provider="${provider}"]`);
  // Already first → no DOM churn. firstElementChild because there may be
  // whitespace text nodes between, but inside #tier2-list we wrote the HTML
  // with no inter-element whitespace specifically so JS can move freely.
  if (!sticky || list.firstElementChild === sticky) return;
  list.prepend(sticky);
}

function markTier2Attribution(state, detail, provider) {
  const el = document.getElementById("tier2-attribution");
  if (!el) return;

  // Reorder first so the sticky provider is at the front. Runs on every
  // response (live or fallback) so the order tracks the server's view.
  reorderTier2List(provider);

  // Clear all prior per-provider state — idempotent. A second "ok" call after
  // a recovered chain clears successfully even if no prior fallback existed.
  el.querySelectorAll("a[data-provider]").forEach((a) => {
    a.classList.remove("is-fallback");
    a.removeAttribute("title");
  });
  if (tier2CountdownTimer) {
    clearInterval(tier2CountdownTimer);
    tier2CountdownTimer = null;
  }
  el.querySelector(".tier2-busy")?.remove();

  if (state !== "fallback" || !provider) return;

  // Find the specific provider link to decorate. If it's not in the static
  // HTML list (e.g. a provider added to the chain but not yet credited in
  // markup), silently skip — we don't want to invent UI for unknown brands.
  const link = el.querySelector(`a[data-provider="${provider}"]`);
  if (!link) return;
  link.classList.add("is-fallback");

  // Hover summary (title attribute on the throttled link). Composed from
  // whatever detail the server gave us. Generic across providers — only
  // Gemini supplies the rich google.rpc structure today; OpenAI-compat
  // providers fill `message` and leave the rest null.
  const brand = link.textContent || provider;
  let summary = `${brand} is unavailable — chain rolled forward.`;
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
    summary = `${brand} ${scopeText}${limitText} hit — chain rolled forward.${retryText}`;

    // Caveat for the daily case: Google's retryDelay is a per-request
    // back-off hint, NOT the time until the daily quota resets — which is
    // typically midnight Pacific. Without this note, "Retry in ~7s" looks
    // like a quota-reset timer; the user waits 7s, retries, and gets 429
    // again until the actual daily reset.
    if (scope === "per_day" && retrySecs !== null) {
      summary += "\n\nNote: this is the provider's suggested back-off between "
        + "requests, not when the daily quota resets. Free-tier daily quotas "
        + "typically reset at midnight Pacific.";
    }

    // Append the unmodified upstream error.message so the user can verify
    // our interpretation against the source. \n is honoured by native title
    // tooltips in every browser we care about.
    if (typeof detail.message === "string" && detail.message.trim()) {
      summary += `\n\n— Full ${brand} error —\n` + detail.message.trim();
    }
  }
  link.title = summary;

  // Insert the chip immediately after the throttled link so the visual
  // pairing reads "Gemini *busy 30s* · OpenRouter · Cerebras …" — chip
  // sits next to the provider it describes, not orphaned at the end.
  const chip = document.createElement("span");
  chip.className = "tier2-busy";
  link.after(chip);

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
    chip.textContent = " busy";
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
  // Fallback state lives on a specific <a data-provider="..."> link now (not
  // on the wrapper span). If no link is flagged, an external clear happened
  // → stop the timer cleanly. Same for a removed chip.
  const flagged = el?.querySelector("a[data-provider].is-fallback");
  const chip = el?.querySelector(".tier2-busy");
  if (!flagged || !chip) {
    if (tier2CountdownTimer) {
      clearInterval(tier2CountdownTimer);
      tier2CountdownTimer = null;
    }
    return;
  }
  const remainingMs = tier2RetryAt - Date.now();
  if (remainingMs <= 0) {
    // Predicted window has passed. For per-minute quotas that means a slot
    // is genuinely free → "ready". For per-day, Google's retryDelay was a
    // per-request back-off hint, not a quota-reset countdown — so we don't
    // tell the user "ready" when they're still over the daily limit; show
    // "daily limit" to indicate they'll likely keep getting 429 until the
    // actual reset (midnight Pacific). 'unknown' scope is treated like
    // per-minute (best-effort) because we have no better signal.
    chip.textContent = tier2CountdownScope === "per_day" ? " daily limit" : " ready";
    clearInterval(tier2CountdownTimer);
    tier2CountdownTimer = null;
  } else {
    chip.textContent = ` busy ${humanRetry(Math.ceil(remainingMs / 1000))}`;
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

  // Pending requestAnimationFrame id for markTruncatedTiles. Declared up
  // here (not next to the function) because markTruncatedTiles is a
  // hoisted function declaration whose body is callable before its source
  // line via the initial renderTiles() at the bottom of this function;
  // a `let` declared near the function would still be in the temporal
  // dead zone at that point and throw on read. See the comment on
  // markTruncatedTiles for the coalescing rationale.
  let markTruncateRafId = null;

  // Custom-name side-table (Online ↗ adds). Loaded once at init; mutated +
  // persisted whenever the user adds an ICAO from an Online search result.
  // describeIcao() consults this AFTER the static seed + bundled dataset, so
  // it only fills gaps for stations that aren't in either built-in source
  // (typical case: AWC weather sites like KSMP).
  const customNamesStore = createCustomNamesStore();
  const customNames = new Map(Object.entries(customNamesStore.load()));
  function rememberCustomName(icao, name) {
    if (!icao || !name) return;
    if (customNames.get(icao) === name) return; // no-op
    customNames.set(icao, name);
    const out = {};
    customNames.forEach((v, k) => { out[k] = v; });
    customNamesStore.save(out);
  }

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
    const name = describeIcao(icao, lookupByIcao, customNames);
    // Tooltip text for the long-press / hover balloon. Only shown when the
    // tile actually overflows (markTruncatedTiles() flags `.has-overflow`).
    // Tiles without a name get the bare ICAO — the chip can't overflow on
    // its own, so `has-overflow` won't fire and the tooltip stays hidden.
    li.dataset.tooltip = name ? `${icao} — ${name}` : icao;
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
    markTruncatedTiles();

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
    // The layout switch reveals (or hides) the tile names — recompute
    // overflow flags so the long-press / hover handlers fire only on
    // genuinely-truncated tiles in the new state.
    markTruncatedTiles();
  }

  // Re-mark tiles whenever the container's content box changes (viewport
  // rotation, browser zoom, sibling layout shift, font load). Without
  // this, an initial render measures correctly but a later resize leaves
  // stale .has-overflow flags on tiles that newly fit or newly truncate.
  if (typeof ResizeObserver === "function" && tiles) {
    new ResizeObserver(() => markTruncatedTiles()).observe(tiles);
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
  // name span actually overflows. Only flagged rows trigger the balloon —
  // non-truncated names hover silently. Skip when the dropdown is hidden
  // (display:none → zero dimensions → false positives).
  function markTruncatedResults() {
    if (!searchResults || searchResults.hidden) return;
    for (const btn of searchResults.querySelectorAll(".icao-result")) {
      const name = btn.querySelector(".icao-result-name");
      btn.classList.toggle("has-overflow", isElementTruncated(name));
    }
  }

  // Same overflow detection for tiles in expanded mode. Tiles must NOT be
  // flagged on long-press for non-truncated names — that gesture is reserved
  // for the iOS native drag-and-drop reorder. The balloon only fires when
  // there's hidden text to reveal; otherwise the user keeps the drag affordance.
  //
  // Detection uses a Range over the text content's rendered width compared
  // to the container's clientWidth — more reliable than scrollWidth on iOS
  // Safari for flex children with `min-width: 0` (which under-reports the
  // overflow and silently misses truncated rows like KHQM).
  //
  // Deferred to the next animation frame so layout has settled after
  // renderTiles() / setOpen() — synchronous measurement returns stale
  // dimensions on iOS during the flex reflow. `markTruncateRafId` (declared
  // at the top of initIcaoControl with the other state vars to dodge the
  // TDZ — markTruncatedTiles is hoisted with its body but a `let` here
  // wouldn't be readable from the initial renderTiles() call) coalesces
  // redundant calls inside a single frame: ResizeObserver fires multiple
  // times during a window resize / orientation change, and without coalescing
  // each callback queues its own rAF doing identical work.
  function markTruncatedTiles() {
    if (!tiles) return;
    if (markTruncateRafId !== null) return; // already scheduled this frame
    const apply = () => {
      markTruncateRafId = null;
      const open = isOpen();
      for (const li of tiles.querySelectorAll(".tile")) {
        const name = li.querySelector(".tile-name");
        const overflows = open && isElementTruncated(name);
        li.classList.toggle("has-overflow", overflows);
      }
    };
    if (typeof requestAnimationFrame === "function") {
      markTruncateRafId = requestAnimationFrame(apply);
    } else {
      apply();
    }
  }

  // Range-based truncation detection. scrollWidth is unreliable on iOS Safari
  // for flex children with overflow:hidden + text-overflow:ellipsis — it
  // sometimes reports the clipped width instead of the natural content
  // width. Measuring the text via Range.getBoundingClientRect() always
  // returns the unclipped rendered width, which we compare to the visible
  // container width. The +1 fudge absorbs subpixel rounding.
  function isElementTruncated(el) {
    if (!el || !el.firstChild) return false;
    const containerWidth = el.getBoundingClientRect().width;
    if (containerWidth === 0) return false; // hidden / not yet laid out
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const textWidth = range.getBoundingClientRect().width;
      range.detach?.(); // some browsers — older API, no-op elsewhere
      return textWidth > containerWidth + 1;
    } catch {
      // Range API failure — fall back to the scrollWidth heuristic.
      return el.scrollWidth > el.clientWidth + 1;
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
        // Stash the AWC-provided station name on the button so the click
        // handler can persist it. Stations that aren't in our bundled
        // airports.json (typical AWC weather sites like KSMP = Stampede Pass)
        // would otherwise show only the bare ICAO on their tile after add.
        if (s.name) btn.dataset.addName = String(s.name);
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
    // If the search auto-expanded a collapsed panel, return to that prior
    // state now that the user has explicitly dismissed the search. Pairs
    // with the manageToggle path: × clears + restores, Edit collapses + clears.
    if (expandedForOnline) {
      expandedForOnline = false;
      setOpen(false);
      manageToggle?.focus({ preventScroll: true });
    } else {
      query.focus();
    }
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
      // Subtle footer cue: italicize the specific provider that fell back on
      // this call + show a small "busy ~7s" chip next to its name. The other
      // providers in the chain list render normally. Reset to neutral on a
      // successful response. Quota detail (scope, limit, retry window) comes
      // from server-side parsing of provider 429 bodies (Gemini's
      // google.rpc.RetryInfo is the richest; OpenAI-compat providers give us
      // just the error message).
      //
      // Fires on both success (data) and structured errors (data with `error`),
      // since the server includes tier2 metadata on 404s too so the user can
      // see which provider was throttled when the failure was provider-driven.
      const tier2 = data?.tier2;
      const provider = data?.tier2_provider;
      // Always pass the credited provider so the list can reorder to put
      // whichever service served first — even on "live" responses where
      // there's no fallback decoration to apply.
      if (tier2 === "live" || tier2 === "off") {
        markTier2Attribution("ok", null, provider);
      } else if (tier2 === "fallback") {
        markTier2Attribution("fallback", data?.tier2_detail, provider);
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
      (!datasetReady || describeIcao(up, lookupByIcao, customNames) !== null);
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
    // Online result rows carry a `data-add-name` with the AWC-supplied
    // station name. Persist it so the tile can render the friendly name
    // (e.g. "Stampede Pass, WA, US" for KSMP) even though KSMP isn't in
    // our bundled airports dataset. Tile renders pull from describeIcao,
    // which now consults the customNames map.
    if (btn.dataset.addName) {
      rememberCustomName(btn.dataset.addIcao, btn.dataset.addName);
    }
    if (addAndSelect(btn.dataset.addIcao)) {
      // Keep the query + dropdown visible after a selection so the user can
      // add more results from the same search. Update the clicked row in
      // place (active + disabled) so duplicates aren't possible. Two explicit
      // dismissals end the search session:
      //   1. × clear button → empties the query and snaps back to the prior
      //      expanded/collapsed state (preserving auto-expand semantics)
      //   2. Edit toggle to collapse → also clears the search (see the
      //      manageToggle handler below)
      const hint = btn.querySelector(".icao-result-hint");
      if (hint) hint.textContent = "active";
      btn.disabled = true;
      query.focus();
    }
  });

  // --- Tile interactions: check toggle / remove / reorder ---

  tiles.addEventListener("click", (e) => {
    // Defensive cleanup — any tile click definitively ends any in-flight
    // long-press. touchend's preventDefault already suppresses the click
    // after a successful long-press; this catches the rare case where the
    // tooltip is still visible but the timer hasn't fired yet (fast tap
    // through the long-press threshold).
    cancelLongPress();
    hideResultTooltip();
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

  // --- Tile truncation tooltip ---
  //
  // Same balloon used by search results, reused for tiles in expanded mode
  // when the name overflows. Scoped to the tile body — touches that start
  // on the drag handle (`⋮⋮`) or the row controls (↑↓−) are left alone so
  // drag-and-drop and the buttons keep working without competing with the
  // long-press timer. Reuses the module-level touchPressTimer / touchTooltipShown
  // and the cancelLongPress() helper defined for the search-results path
  // — only one finger can press at a time, so shared state is safe.
  function isTileReservedArea(node) {
    return !!(node && node.closest && node.closest(".tile-drag, .tile-controls"));
  }

  // Helper: matches a tile that's eligible for the balloon — truncated AND
  // expanded AND the touch didn't start in the drag handle / row controls.
  //
  // Gating on .has-overflow is critical for the touch-drag interaction.
  // iOS Safari initiates HTML5 drag on a long-press of a draggable=true
  // element; if we fire the balloon on every long-press, we steal the
  // drag gesture from the user. By only firing on truncated tiles, the
  // user keeps the long-press → drag affordance on tiles whose names
  // already fit (most), and gets the info-card balloon only on tiles
  // where there's hidden text to read. Trade-off: can't drag-reorder a
  // truncated tile by long-press; use ↑↓ arrows for those.
  function eligibleTile(target) {
    if (isTileReservedArea(target)) return null;
    const tile = target.closest(".tile.has-overflow[data-tooltip]");
    return tile && isOpen() ? tile : null;
  }

  tiles?.addEventListener("mouseover", (e) => {
    const target = eligibleTile(e.target);
    if (target) showResultTooltip(target);
  });
  tiles?.addEventListener("mouseout", (e) => {
    const target = e.target.closest(".tile[data-tooltip]");
    if (target && !target.contains(e.relatedTarget)) hideResultTooltip();
  });
  tiles?.addEventListener("touchstart", (e) => {
    const target = eligibleTile(e.target);
    if (!target) return;
    cancelLongPress();
    touchTooltipShown = false;
    touchPressTimer = setTimeout(() => {
      showResultTooltip(target);
      touchTooltipShown = true;
      touchPressTimer = null;
    }, 450);
  }, { passive: true });
  tiles?.addEventListener("touchmove", () => {
    cancelLongPress();
    if (touchTooltipShown) { hideResultTooltip(); touchTooltipShown = false; }
  }, { passive: true });
  tiles?.addEventListener("touchcancel", () => {
    cancelLongPress();
    if (touchTooltipShown) { hideResultTooltip(); touchTooltipShown = false; }
  });
  tiles?.addEventListener("touchend", (e) => {
    cancelLongPress();
    if (touchTooltipShown) {
      hideResultTooltip();
      touchTooltipShown = false;
      e.preventDefault(); // suppress synthetic click after a successful long-press
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

  // --- Touch-based reorder ---
  //
  // iOS Safari (and Brave on iOS, which is WebKit underneath) fires dragstart
  // and dragover from a long-press on draggable elements, but the `drop` event
  // is unreliable — especially in collapsed mode where the chip targets are
  // small. Result: the user sees the tile pick up + the drop indicator, but
  // releasing never commits the reorder.
  //
  // This handler implements the same reorder logic using raw touch events
  // (independent of HTML5 drag-and-drop) so the gesture works on every
  // touch device. It also adds live mid-drag visual feedback — the dragged
  // tile follows the finger, and the surrounding tiles shift via transforms
  // to show where the drop will land — so the user can see the rearrangement
  // forming before they release. On commit, the existing FLIP animation in
  // flipTiles() handles the final snap into place.
  let touchDrag = null;
  const TOUCH_DRAG_THRESHOLD_PX = 8;

  function touchDragSnapshotRects() {
    const rects = new Map();
    for (const t of tiles.children) {
      rects.set(t.dataset.icao, t.getBoundingClientRect());
    }
    return rects;
  }

  // Find the would-be drop target using the ORIGINAL (pre-shift) rects
  // snapshotted at drag start. Critical for stability: during drag, the
  // shift transforms reposition tiles visually, so elementFromPoint +
  // getBoundingClientRect both return moving positions — that creates a
  // feedback loop where the shift changes what's under the cursor, which
  // changes the target, which changes the shift, producing rapid rattle.
  // Original-rect targeting decouples drop detection from shift state.
  function findTouchTarget(touch) {
    if (!touchDrag || !touchDrag.rects) return null;
    for (const [icao, rect] of touchDrag.rects) {
      if (icao === touchDrag.icao) continue;
      if (touch.clientX >= rect.left && touch.clientX <= rect.right &&
          touch.clientY >= rect.top && touch.clientY <= rect.bottom) {
        const el = tiles.querySelector(`.tile[data-icao="${icao}"]`);
        if (el) return { el, rect };
      }
    }
    return null;
  }

  // Before/after decision with hysteresis. Pure midpoint comparison flips on
  // sub-pixel finger jitter when the cursor is right on the boundary — the
  // shift arrangement differs for before vs after, so each flip recomputes
  // and visually rattles. The 10% margin around the midpoint keeps the
  // previous decision until the cursor decisively crosses to the other side.
  function isDropBeforeStable(rect, touch, lastBefore) {
    const axis  = isOpen() ? "y" : "x";
    const start = axis === "y" ? rect.top : rect.left;
    const size  = axis === "y" ? rect.height : rect.width;
    const pos   = axis === "y" ? touch.clientY : touch.clientX;
    const mid   = start + size / 2;
    const buffer = size * 0.10;
    if (lastBefore === true)  return pos > mid + buffer ? false : true;
    if (lastBefore === false) return pos < mid - buffer ? true  : false;
    return pos < mid;
  }

  // Compute the "would-be" index based on the current touch point, then
  // apply transforms to every non-dragged tile so it visibly slides to the
  // slot it would occupy if the user released here. Idempotent — called on
  // every touchmove with the latest target.
  function touchDragApplyShifts(targetRow, dropBefore) {
    if (!touchDrag) return;
    const fromIdx = list.indexOf(touchDrag.icao);
    let wouldBeIdx = fromIdx;
    if (targetRow && targetRow.dataset.icao !== touchDrag.icao) {
      const targetIdx = list.indexOf(targetRow.dataset.icao);
      wouldBeIdx = dropBefore ? targetIdx : targetIdx + 1;
      if (fromIdx < wouldBeIdx) wouldBeIdx -= 1;
    }
    const wouldBe = [...list];
    wouldBe.splice(fromIdx, 1);
    wouldBe.splice(wouldBeIdx, 0, touchDrag.icao);

    const originalChildren = Array.from(tiles.children);
    for (const el of originalChildren) {
      if (el === touchDrag.tile) continue;
      const wouldBeIdxForEl = wouldBe.indexOf(el.dataset.icao);
      const occupant = originalChildren[wouldBeIdxForEl];
      if (!occupant || occupant === el) {
        el.style.transform = "";
        continue;
      }
      const from = touchDrag.rects.get(el.dataset.icao);
      const to = touchDrag.rects.get(occupant.dataset.icao);
      if (!from || !to) { el.style.transform = ""; continue; }
      el.style.transform = `translate(${to.left - from.left}px, ${to.top - from.top}px)`;
    }
  }

  function touchDragClearShifts() {
    for (const el of tiles.children) {
      if (el === touchDrag?.tile) continue;
      el.style.transform = "";
    }
  }

  tiles.addEventListener("touchstart", (e) => {
    // Defensive: if a previous drag's touchend/touchcancel was dropped by
    // iOS (rare, but DOM mutation during touch handling can do this), force-
    // clean before starting a new drag. Without this the `if (touchDrag)
    // return` below would silently swallow every subsequent drag attempt.
    if (touchDrag) {
      touchDrag.tile.classList.remove("touch-dragging");
      touchDrag.tile.style.transform = "";
      touchDragClearShifts();
      clearDropMarkers();
      touchDrag = null;
    }
    if (isTileReservedArea(e.target)) return; // controls intercept their own taps
    const tile = e.target.closest(".tile");
    if (!tile) return;
    const t = e.touches[0];
    touchDrag = {
      icao: tile.dataset.icao,
      tile,
      startX: t.clientX,
      startY: t.clientY,
      active: false,
      rects: null,
      lastBefore: null,   // hysteresis state — last before/after decision
    };
  }, { passive: true });

  tiles.addEventListener("touchmove", (e) => {
    if (!touchDrag) return;
    const t = e.touches[0];
    const dx = t.clientX - touchDrag.startX;
    const dy = t.clientY - touchDrag.startY;

    // Promote tap → drag once the user moves past the threshold. Before that
    // we let the page scroll / the long-press tooltip timer run normally.
    if (!touchDrag.active) {
      if (Math.hypot(dx, dy) < TOUCH_DRAG_THRESHOLD_PX) return;
      touchDrag.active = true;
      // Cancel any in-flight tooltip — the gesture is now a drag.
      cancelLongPress();
      if (touchTooltipShown) { hideResultTooltip(); touchTooltipShown = false; }
      // Snapshot rects BEFORE we start shifting anything — these are the
      // baseline positions every transform measures from.
      touchDrag.rects = touchDragSnapshotRects();
      touchDrag.tile.classList.add("touch-dragging");
    }

    // Move the dragged tile to follow the finger.
    touchDrag.tile.style.transform = `translate(${dx}px, ${dy}px)`;

    // Identify the drop target from the original (pre-shift) rects, not
    // from elementFromPoint/getBoundingClientRect — those reflect the
    // shifted layout and would feed back into the shift recompute.
    const target = findTouchTarget(t);
    clearDropMarkers();
    if (target) {
      const before = isDropBeforeStable(target.rect, t, touchDrag.lastBefore);
      touchDrag.lastBefore = before;
      target.el.classList.add(before ? "drop-before" : "drop-after");
      touchDragApplyShifts(target.el, before);
    } else {
      touchDrag.lastBefore = null;
      touchDragClearShifts();
    }

    e.preventDefault(); // prevent page scroll while dragging
  }, { passive: false }); // explicit — preventDefault inside; the default for
                          // non-root targets is already passive: false, but
                          // declaring it survives future browser-default shifts.

  function touchDragFinish(commitDrop, point) {
    if (!touchDrag) return;
    const tile = touchDrag.tile;
    const icao = touchDrag.icao;
    const lastBefore = touchDrag.lastBefore;

    // 1. Resolve the drop target from the LAST stable target identified
    //    during touchmove (uses original rects + hysteresis), not from a
    //    fresh elementFromPoint at release. Avoids a last-frame target
    //    swap if the user lifts their finger mid-jitter.
    let dropInfo = null;
    if (commitDrop && point) {
      const target = findTouchTarget(point);
      if (target) {
        const before = lastBefore !== null
          ? lastBefore
          : isDropBeforeStable(target.rect, point, null);
        dropInfo = {
          targetIdx: list.indexOf(target.el.dataset.icao),
          fromIdx:   list.indexOf(icao),
          before,
        };
      }
    }

    // 2. Clear the dragged tile's transform AND remove .touch-dragging in
    //    that order — while the class is still applied its `transition:
    //    none !important` rule kicks in, so the transform-clear is instant.
    //    Removing the class afterwards has nothing to animate (transform
    //    is already "").
    tile.style.transform = "";
    tile.classList.remove("touch-dragging");
    clearDropMarkers();

    // 3. iOS Safari/Brave fires HTML5 dragstart in parallel with our touch
    //    handlers on a long-press of a draggable element, leaving `dragIcao`
    //    set + a `.dragging` class on the source. The HTML5 dragend may
    //    not fire cleanly when commit() rebuilds the DOM, so we clean both
    //    up explicitly here. Without this, a second drag could be blocked
    //    by stale state and the dragover handler would keep firing for
    //    no reason.
    dragIcao = null;
    for (const r of tiles.querySelectorAll(".dragging")) r.classList.remove("dragging");

    // 4. On a successful drop, LEAVE the sibling transforms in place —
    //    commit() will rebuild the DOM with fresh elements at their final
    //    positions, and the old transformed elements are replaced in the
    //    same paint. If the user released off-target, clear the shifts so
    //    siblings smoothly slide back to their original spots via the CSS
    //    transition on `.tile:not(.touch-dragging)`.
    if (dropInfo) {
      let newIdx = dropInfo.before ? dropInfo.targetIdx : dropInfo.targetIdx + 1;
      if (dropInfo.fromIdx < newIdx) newIdx -= 1;
      if (moveTo(icao, newIdx)) commit();
    } else {
      touchDragClearShifts();
    }

    touchDrag = null;
  }

  tiles.addEventListener("touchend", (e) => {
    if (!touchDrag) return;
    const wasActive = touchDrag.active;
    touchDragFinish(wasActive, wasActive ? e.changedTouches[0] : null);
    if (wasActive) e.preventDefault(); // suppress synthetic click after drag
  });
  tiles.addEventListener("touchcancel", () => touchDragFinish(false, null));

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
    const wasOpen = isOpen();
    setOpen(!wasOpen);
    // Manual collapse dismisses any active search session too — pairs with
    // the × button as the two ways to end the "results stay visible after
    // selection" mode. When opening (was closed → now open) we leave the
    // query alone; the user might be returning to a typed phrase mid-edit.
    if (wasOpen) {
      // Cancel any in-flight Online call so a late response doesn't repaint
      // a freshly-dismissed dropdown.
      if (onlineAbort) {
        onlineAbort.abort();
        onlineAbort = null;
        onlineSeq++;
        onlineBtn?.classList.remove("is-loading");
        onlineBtn?.removeAttribute("aria-busy");
      }
      query.value = "";
      renderResults([]);
      renderOnlineGroups([]);
      setStatus("");
      updateClearButton();
    }
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
