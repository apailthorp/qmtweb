import { describe, it, expect, beforeEach } from "vitest";
import {
  createStore,
  defaultState,
  STORAGE_KEY,
  LIST_MIN,
  LIST_MAX,
  createQueryStore,
  defaultQuery,
  QUERY_KEY,
} from "../../site/js/storage.js";
import { DEFAULT_SEED, DEFAULT_SELECTED } from "../../site/js/airports.js";

const LEGACY_V2 = "qmtweb.icao.state.v2";

function memStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => { map.clear(); },
    _map: map,
  };
}

describe("defaultState (v3)", () => {
  it("seeds list with all 12 and selected with the first 6", () => {
    expect(defaultState()).toEqual({
      selected: [...DEFAULT_SELECTED],
      list: [...DEFAULT_SEED],
    });
  });

  it("returns a fresh object each call", () => {
    const a = defaultState();
    a.list.push("KSFO");
    expect(defaultState().list).not.toContain("KSFO");
  });
});

describe("LIST_MIN/LIST_MAX", () => {
  it("matches the spec (1..20)", () => {
    expect(LIST_MIN).toBe(1);
    expect(LIST_MAX).toBe(20);
  });
});

describe("createStore (v3)", () => {
  let storage;
  let store;

  beforeEach(() => {
    storage = memStorage();
    store = createStore(storage);
  });

  it("load() returns defaultState when storage is empty", () => {
    expect(store.load()).toEqual(defaultState());
  });

  it("save() then load() round-trips selected + list", () => {
    store.save({ selected: ["KSEA", "KSFO"], list: ["KSEA", "KSFO"] });
    expect(store.load()).toEqual({
      selected: ["KSEA", "KSFO"],
      list: ["KSEA", "KSFO"],
    });
  });

  it("load() ignores objects missing a `list` field", () => {
    storage.setItem(STORAGE_KEY, JSON.stringify({ selected: ["KSEA"] }));
    expect(store.load()).toEqual(defaultState());
  });

  it("load() filters non-string entries silently", () => {
    storage.setItem(STORAGE_KEY, JSON.stringify({
      selected: ["KSEA", 42, null],
      list: ["KSEA", false, "KSFO"],
    }));
    expect(store.load()).toEqual({ selected: ["KSEA"], list: ["KSEA", "KSFO"] });
  });

  it("uses the v3 storage key", () => {
    expect(STORAGE_KEY).toMatch(/\.v3$/);
  });
});

describe("createStore v2→v3 migration", () => {
  it("upgrades v2 customs into the new `list`, alongside DEFAULT_SEED + selected", () => {
    const storage = memStorage();
    storage.setItem(LEGACY_V2, JSON.stringify({
      selected: ["KPAE", "KSFO"],
      customs: ["KSFO", "KJFK"],
    }));
    const store = createStore(storage);

    const state = store.load();
    expect(state.selected).toEqual(["KPAE", "KSFO"]);
    for (const c of DEFAULT_SEED) expect(state.list).toContain(c);
    expect(state.list).toContain("KSFO");
    expect(state.list).toContain("KJFK");
  });

  it("v3 data wins over v2 data when both are present", () => {
    const storage = memStorage();
    storage.setItem(LEGACY_V2, JSON.stringify({ selected: ["KPAE"], customs: ["KSFO"] }));
    storage.setItem(STORAGE_KEY, JSON.stringify({ selected: ["KSEA"], list: ["KSEA"] }));
    const store = createStore(storage);
    expect(store.load()).toEqual({ selected: ["KSEA"], list: ["KSEA"] });
  });

  it("falls back to defaults when v2 data is corrupt", () => {
    const storage = memStorage();
    storage.setItem(LEGACY_V2, "{not-json");
    const store = createStore(storage);
    expect(store.load()).toEqual(defaultState());
  });
});

describe("createStore without working storage", () => {
  it("returns defaults and silently no-ops on save when storage is null", () => {
    const store = createStore(null);
    expect(store.available).toBe(false);
    expect(store.load()).toEqual(defaultState());
    expect(() => store.save({ selected: ["KSEA"], list: ["KSEA"] })).not.toThrow();
  });
});

describe("createQueryStore", () => {
  let storage;
  let store;

  beforeEach(() => {
    storage = memStorage();
    store = createQueryStore(storage);
  });

  it("defaultQuery is decode-off, tabular-off, hours 0", () => {
    expect(defaultQuery()).toEqual({ decoded: false, tabular: false, hours: "0" });
  });

  it("load() returns defaults when empty", () => {
    expect(store.load()).toEqual({ decoded: false, tabular: false, hours: "0" });
  });

  it("round-trips decoded + tabular + hours", () => {
    store.save({ decoded: true, tabular: true, hours: "6" });
    expect(store.load()).toEqual({ decoded: true, tabular: true, hours: "6" });
  });

  it("coerces hours to a string on save", () => {
    store.save({ decoded: false, tabular: false, hours: 12 });
    expect(store.load()).toEqual({ decoded: false, tabular: false, hours: "12" });
  });

  it("defaults tabular=false for older data that predates the field", () => {
    storage.setItem(QUERY_KEY, JSON.stringify({ decoded: true, hours: "3" }));
    expect(store.load()).toEqual({ decoded: true, tabular: false, hours: "3" });
  });

  it("falls back to defaults on corrupt JSON", () => {
    storage.setItem(QUERY_KEY, "{bad");
    expect(store.load()).toEqual(defaultQuery());
  });

  it("ignores wrong-typed fields", () => {
    storage.setItem(QUERY_KEY, JSON.stringify({ decoded: "yes", tabular: 1, hours: 3 }));
    expect(store.load()).toEqual({ decoded: false, tabular: false, hours: "0" });
  });

  it("uses a versioned key", () => {
    expect(QUERY_KEY).toMatch(/\.v1$/);
  });

  it("no-ops without working storage", () => {
    const s = createQueryStore(null);
    expect(s.available).toBe(false);
    expect(s.load()).toEqual(defaultQuery());
    expect(() => s.save({ decoded: true, hours: "1" })).not.toThrow();
  });
});
