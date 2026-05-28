import { describe, it, expect, beforeEach } from "vitest";
import { searchAirports, loadAirports, _setCache, _clearCache } from "../../site/js/search.js";

const FIXTURE = [
  { icao: "KSEA", iata: "SEA", name: "Seattle Tacoma International Airport", city: "Seattle", country: "US" },
  { icao: "KSFO", iata: "SFO", name: "San Francisco International Airport", city: "San Francisco", country: "US" },
  { icao: "KJFK", iata: "JFK", name: "John F Kennedy International Airport", city: "New York", country: "US" },
  { icao: "KBFI", iata: "BFI", name: "Boeing Field King County Intl", city: "Seattle", country: "US" },
  { icao: "KORS", iata: "ESD", name: "Orcas Island Airport", city: "Eastsound", country: "US" },
  { icao: "EGLL", iata: "LHR", name: "London Heathrow Airport", city: "London", country: "GB" },
  { icao: "CYVR", iata: "YVR", name: "Vancouver International Airport", city: "Vancouver", country: "CA" },
];

describe("searchAirports", () => {
  it("returns [] for empty / too-short queries", () => {
    expect(searchAirports("", FIXTURE)).toEqual([]);
    expect(searchAirports("k", FIXTURE)).toEqual([]);
  });

  it("ranks exact ICAO match first", () => {
    const r = searchAirports("KSEA", FIXTURE);
    expect(r[0].icao).toBe("KSEA");
  });

  it("ranks exact IATA match high", () => {
    const r = searchAirports("SFO", FIXTURE);
    expect(r[0].icao).toBe("KSFO");
  });

  it("matches by city substring", () => {
    const r = searchAirports("Seattle", FIXTURE);
    const icaos = r.map((a) => a.icao);
    expect(icaos).toContain("KSEA");
    expect(icaos).toContain("KBFI");
  });

  it("matches by name substring", () => {
    const r = searchAirports("Heathrow", FIXTURE);
    expect(r[0].icao).toBe("EGLL");
  });

  it("matches by ICAO prefix", () => {
    const r = searchAirports("KS", FIXTURE);
    const icaos = r.map((a) => a.icao);
    expect(icaos).toContain("KSEA");
    expect(icaos).toContain("KSFO");
  });

  it("is case-insensitive", () => {
    expect(searchAirports("seattle", FIXTURE)[0].icao).toBe("KSEA");
    expect(searchAirports("SEATTLE", FIXTURE)[0].icao).toBe("KSEA");
  });

  it("caps results at the limit when more match", () => {
    // "airport" matches every fixture name; limit must actually trim it.
    const r = searchAirports("airport", FIXTURE, { limit: 2 });
    expect(r).toHaveLength(2);
  });

  it("returns at most `limit` results", () => {
    const r = searchAirports("airport", FIXTURE, { limit: 3 });
    expect(r.length).toBeLessThanOrEqual(3);
  });

  it("returns no matches for nonsense", () => {
    expect(searchAirports("zzzz12345", FIXTURE)).toEqual([]);
  });
});

describe("loadAirports", () => {
  beforeEach(() => _clearCache());

  it("uses cache after first successful load", async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls++;
      return {
        ok: true,
        json: async () => FIXTURE,
      };
    };
    await loadAirports(fakeFetch);
    await loadAirports(fakeFetch);
    expect(calls).toBe(1);
  });

  it("throws on non-ok HTTP", async () => {
    const fakeFetch = async () => ({ ok: false, status: 503, json: async () => null });
    await expect(loadAirports(fakeFetch)).rejects.toThrow(/503/);
  });

  it("retries after a failed load instead of caching the rejection", async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls++;
      if (calls === 1) throw new Error("network down");
      return { ok: true, json: async () => FIXTURE };
    };
    await expect(loadAirports(fakeFetch)).rejects.toThrow(/network down/);
    // Second call should re-attempt (pending was cleared), not re-throw.
    const result = await loadAirports(fakeFetch);
    expect(result).toBe(FIXTURE);
    expect(calls).toBe(2);
  });

  it("_setCache allows tests to preload", async () => {
    _setCache(FIXTURE);
    const result = await loadAirports(() => {
      throw new Error("should not fetch");
    });
    expect(result).toBe(FIXTURE);
  });
});
