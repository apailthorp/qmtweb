import { validateIcaoList } from "./metar.js";
import { initIcaoControl } from "./icao-control.js";
import { createStore } from "./storage.js";

const form = document.getElementById("metar-form");
const idsInput = document.getElementById("ids");
const errorEl = document.getElementById("form-error");
const presetGrid = document.getElementById("icao-presets");
const countEl = document.getElementById("icao-count");
const actionsEl = document.getElementById("icao-actions");
const searchInput = document.getElementById("icao-search");
const searchResults = document.getElementById("icao-search-results");
const searchStatusEl = document.getElementById("icao-search-status");
const manageToggle = document.getElementById("manage-toggle");
const managePanel = document.getElementById("manage-panel");

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function clearError() {
  errorEl.textContent = "";
  errorEl.hidden = true;
}

if (presetGrid) {
  initIcaoControl({
    input: idsInput,
    presetGrid,
    countEl,
    actionsEl,
    searchInput,
    searchResults,
    searchStatusEl,
    manageToggle,
    managePanel,
    store: createStore(),
  });
}

form?.addEventListener("submit", (event) => {
  const { ok, invalid } = validateIcaoList(idsInput.value);
  if (!ok) {
    event.preventDefault();
    showError(
      invalid.length > 0
        ? `Invalid ICAO code${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}`
        : "Enter at least one ICAO code (e.g. KSEA).",
    );
    idsInput.focus();
    return;
  }
  clearError();
});

idsInput?.addEventListener("input", clearError);
