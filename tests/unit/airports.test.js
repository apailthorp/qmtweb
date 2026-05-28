import { describe, it, expect } from "vitest";
import {
  SEED_AIRPORTS,
  DEFAULT_SEED,
  DEFAULT_SELECTED,
  seedAirport,
} from "../../site/js/airports.js";
import { isValidIcao } from "../../site/js/metar.js";

describe("seed airports", () => {
  it("contains 12 entries", () => {
    expect(SEED_AIRPORTS).toHaveLength(12);
    expect(DEFAULT_SEED).toHaveLength(12);
  });

  it("every entry has a valid ICAO code", () => {
    for (const a of SEED_AIRPORTS) {
      expect(isValidIcao(a.icao), a.icao).toBe(true);
    }
  });

  it("DEFAULT_SELECTED is the first 6 seed airports", () => {
    expect(DEFAULT_SELECTED).toEqual([
      "KPAE", "KBFI", "KRNT", "KPWT", "KOLM", "KHQM",
    ]);
  });

  it("DEFAULT_SELECTED is a subset of DEFAULT_SEED", () => {
    for (const c of DEFAULT_SELECTED) expect(DEFAULT_SEED).toContain(c);
  });

  it("seedAirport returns the entry or null", () => {
    expect(seedAirport("KSEA")?.name).toMatch(/Seattle/);
    expect(seedAirport("KZZZ")).toBeNull();
  });

  it("ICAOs are unique", () => {
    const set = new Set(DEFAULT_SEED);
    expect(set.size).toBe(DEFAULT_SEED.length);
  });
});
