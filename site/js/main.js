import { validateIcaoList } from "./metar.js";
import { initIcaoControl } from "./icao-control.js";
import { createStore, createQueryStore } from "./storage.js";
import { initVersionTag } from "./version.js";

const form = document.getElementById("metar-form");
const hiddenIds = document.getElementById("ids");
const errorEl = document.getElementById("form-error");
const tileControl = document.getElementById("tile-control");
const tilesEl = document.getElementById("icao-tiles");
const queryEl = document.getElementById("icao-query");
const countEl = document.getElementById("icao-count");
const actionsEl = document.getElementById("icao-actions");
const searchResults = document.getElementById("icao-search-results");
const searchStatusEl = document.getElementById("icao-search-status");
const onlineBtn = document.getElementById("icao-search-external");
const manageToggle = document.getElementById("manage-toggle");
const decodedToggle = document.getElementById("decoded-toggle");
const tabularToggle = document.getElementById("tabular-toggle");
const tafToggle = document.getElementById("taf-toggle");
const hoursSelect = document.getElementById("hours-select");

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function clearError() {
  errorEl.textContent = "";
  errorEl.hidden = true;
}

if (tilesEl && hiddenIds) {
  initIcaoControl({
    control: tileControl,
    hiddenIds,
    query: queryEl,
    tiles: tilesEl,
    countEl,
    actionsEl,
    searchResults,
    searchStatusEl,
    onlineBtn,
    manageToggle,
    store: createStore(),
  });
}

// Persist the Decode / Tabular / TAF toggles + Hours window so they survive
// a refresh, the same way the ICAO list does.
const queryStore = createQueryStore();
const savedQuery = queryStore.load();
if (decodedToggle) decodedToggle.checked = savedQuery.decoded;
if (tabularToggle) tabularToggle.checked = savedQuery.tabular;
if (tafToggle)     tafToggle.checked     = savedQuery.taf;
// Mutual-exclusion rules:
//   Decoded ⊕ Tabular  (output format is one or the other)
//   Tabular ⊕ TAF      (the tabular view can't carry a TAF)
// Defensive guard in case storage somehow holds an illegal combination.
let mutexRepaired = false;
if (decodedToggle?.checked && tabularToggle?.checked) {
  tabularToggle.checked = false;
  mutexRepaired = true;
}
if (tabularToggle?.checked && tafToggle?.checked) {
  tafToggle.checked = false;
  mutexRepaired = true;
}
if (hoursSelect) {
  const hasOption = Array.from(hoursSelect.options).some((o) => o.value === savedQuery.hours);
  if (hasOption) hoursSelect.value = savedQuery.hours;
}

// Persist the repaired state so storage self-heals — otherwise we'd repeat
// the defensive fix on every page load.
if (mutexRepaired) saveQuery();

function saveQuery() {
  queryStore.save({
    decoded: decodedToggle?.checked ?? false,
    tabular: tabularToggle?.checked ?? false,
    taf:     tafToggle?.checked     ?? false,
    hours: hoursSelect?.value ?? "0",
  });
}

// Flipping any one switch enforces the mutex rules, then persists.
decodedToggle?.addEventListener("change", () => {
  if (decodedToggle.checked && tabularToggle) tabularToggle.checked = false;
  saveQuery();
});
tabularToggle?.addEventListener("change", () => {
  if (tabularToggle.checked) {
    if (decodedToggle) decodedToggle.checked = false;
    if (tafToggle)     tafToggle.checked     = false;
  }
  saveQuery();
});
tafToggle?.addEventListener("change", () => {
  if (tafToggle.checked && tabularToggle) tabularToggle.checked = false;
  saveQuery();
});
hoursSelect?.addEventListener("change", saveQuery);

form?.addEventListener("submit", (event) => {
  const { ok, invalid } = validateIcaoList(hiddenIds.value);
  if (!ok) {
    event.preventDefault();
    showError(
      invalid.length > 0
        ? `Invalid ICAO code${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}`
        : "Add at least one airport (e.g. KSEA).",
    );
    queryEl?.focus();
    return;
  }
  clearError();
});

queryEl?.addEventListener("input", clearError);

// Show the deployed version stamp (bottom-left; hides while scrolled up).
initVersionTag();
