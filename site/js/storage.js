// Persistent state for the ICAO control. Survives:
//   - storage being unavailable (private mode, blocked, SSR-like tests)
//   - corrupted JSON
//   - schema drift (bump the key version to invalidate old data)
//
// Stored shape (v3):
//   { selected: string[], list: string[] }
//
// v2 → v3 migration (best-effort): when only v2 data exists, fold its
// `customs` field into `list` so users keep their additions.

import { DEFAULT_SEED, DEFAULT_SELECTED } from "./airports.js";

export const STORAGE_KEY = "qmtweb.icao.state.v3";
const LEGACY_KEY_V2 = "qmtweb.icao.state.v2";

export const LIST_MIN = 1;
export const LIST_MAX = 20;

export function defaultState() {
  return {
    selected: [...DEFAULT_SELECTED],
    list: [...DEFAULT_SEED],
  };
}

function safeStorage(storage) {
  if (!storage) return null;
  try {
    const probe = "__qmtweb_probe__";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

function sanitizeStringArray(value) {
  return Array.isArray(value) ? value.filter((c) => typeof c === "string") : [];
}

// Deduplicate while preserving order; cap to LIST_MAX.
function normalizeList(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    if (out.length >= LIST_MAX) break;
  }
  return out;
}

function parseV3(raw) {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (!Array.isArray(parsed.list)) return null;
    return {
      selected: sanitizeStringArray(parsed.selected),
      list: sanitizeStringArray(parsed.list),
    };
  } catch {
    return null;
  }
}

function parseV2(raw) {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const selected = sanitizeStringArray(parsed.selected);
    const customs = sanitizeStringArray(parsed.customs);
    const merged = normalizeList([...DEFAULT_SEED, ...selected, ...customs]);
    return { selected, list: merged };
  } catch {
    return null;
  }
}

// --- Query settings (Decode + Tabular + TAF toggles + Hours window) ---
// Stored separately from the ICAO list since it's a distinct concern.
// Shape: { decoded: boolean, tabular: boolean, taf: boolean, hours: string }
// New boolean fields default to false, so older persisted data upgrades
// cleanly without a key-version bump.

export const QUERY_KEY = "qmtweb.query.v1";

export function defaultQuery() {
  return { decoded: false, tabular: false, taf: false, hours: "0" };
}

export function createQueryStore(storage = globalThis.localStorage ?? null) {
  const s = safeStorage(storage);

  return {
    load() {
      if (!s) return defaultQuery();
      try {
        const raw = s.getItem(QUERY_KEY);
        if (raw === null) return defaultQuery();
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return defaultQuery();
        }
        return {
          decoded: typeof parsed.decoded === "boolean" ? parsed.decoded : false,
          tabular: typeof parsed.tabular === "boolean" ? parsed.tabular : false,
          taf:     typeof parsed.taf     === "boolean" ? parsed.taf     : false,
          hours: typeof parsed.hours === "string" ? parsed.hours : "0",
        };
      } catch {
        return defaultQuery();
      }
    },

    save(query) {
      if (!s) return;
      try {
        s.setItem(QUERY_KEY, JSON.stringify({
          decoded: Boolean(query?.decoded),
          tabular: Boolean(query?.tabular),
          taf:     Boolean(query?.taf),
          hours: String(query?.hours ?? "0"),
        }));
      } catch {
        // Non-fatal.
      }
    },

    available: s !== null,
  };
}

export function createStore(storage = globalThis.localStorage ?? null) {
  const s = safeStorage(storage);

  return {
    load() {
      if (!s) return defaultState();

      const v3 = parseV3(s.getItem(STORAGE_KEY));
      if (v3) return v3;

      const v2 = parseV2(s.getItem(LEGACY_KEY_V2));
      if (v2) return v2;

      return defaultState();
    },

    save(state) {
      if (!s) return;
      try {
        s.setItem(STORAGE_KEY, JSON.stringify({
          selected: sanitizeStringArray(state?.selected),
          list: sanitizeStringArray(state?.list),
        }));
      } catch {
        // Quota exceeded or storage cleared mid-session — silently drop.
      }
    },

    clear() {
      if (!s) return;
      try {
        s.removeItem(STORAGE_KEY);
      } catch {
        // Non-fatal.
      }
    },

    available: s !== null,
  };
}
