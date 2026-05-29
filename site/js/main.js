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
const hoursSelect = document.getElementById("hours-select");
const metarTafButton = form?.querySelector("button[name='taf'][value='1']");

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

// Persist the Decode toggle + Hours window so they survive a refresh,
// the same way the ICAO list does.
const queryStore = createQueryStore();
const savedQuery = queryStore.load();
if (decodedToggle) decodedToggle.checked = savedQuery.decoded;
if (tabularToggle) tabularToggle.checked = savedQuery.tabular;
// Decode and Tabular are mutually exclusive — never let both be on, even
// if storage somehow holds both (defensive).
if (decodedToggle?.checked && tabularToggle?.checked) tabularToggle.checked = false;
if (hoursSelect) {
  const hasOption = Array.from(hoursSelect.options).some((o) => o.value === savedQuery.hours);
  if (hasOption) hoursSelect.value = savedQuery.hours;
}

// Tabular output can't carry a TAF, so the METAR/TAF submit is disabled
// whenever Tabular is on.
function syncTafButton() {
  if (!metarTafButton) return;
  const off = !!tabularToggle?.checked;
  metarTafButton.disabled = off;
  metarTafButton.title = off ? "Tabular view doesn't include TAF" : "";
}

function saveQuery() {
  queryStore.save({
    decoded: decodedToggle?.checked ?? false,
    tabular: tabularToggle?.checked ?? false,
    hours: hoursSelect?.value ?? "0",
  });
}

// Turning one of the two format switches on forces the other off.
decodedToggle?.addEventListener("change", () => {
  if (decodedToggle.checked && tabularToggle) tabularToggle.checked = false;
  syncTafButton();
  saveQuery();
});
tabularToggle?.addEventListener("change", () => {
  if (tabularToggle.checked && decodedToggle) decodedToggle.checked = false;
  syncTafButton();
  saveQuery();
});
hoursSelect?.addEventListener("change", saveQuery);

syncTafButton(); // reflect persisted state on load

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
