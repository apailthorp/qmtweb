import { describe, it, expect } from "vitest";
import {
  isValidIcao,
  parseIcaoList,
  validateIcaoList,
  buildMetarUrl,
  METAR_FORM_URL,
} from "../../site/js/metar.js";

describe("isValidIcao", () => {
  it.each([
    ["KPAE", true],
    ["KBFI", true],
    ["CYVR", true],
    ["EGLL", true],
    ["K1AB", true],
    ["kpae", false],
    ["KPA", false],
    ["KPAEX", false],
    ["1PAE", false],
    ["", false],
    [null, false],
    [undefined, false],
    [12345, false],
  ])("isValidIcao(%p) === %p", (input, expected) => {
    expect(isValidIcao(input)).toBe(expected);
  });
});

describe("parseIcaoList", () => {
  it("splits on commas, whitespace, and mixed separators", () => {
    expect(parseIcaoList("KPAE,KBFI KRNT\tKPWT")).toEqual([
      "KPAE", "KBFI", "KRNT", "KPWT",
    ]);
  });

  it("uppercases and trims tokens", () => {
    expect(parseIcaoList(" kpae , kbfi ")).toEqual(["KPAE", "KBFI"]);
  });

  it("returns empty array for empty / non-string", () => {
    expect(parseIcaoList("")).toEqual([]);
    expect(parseIcaoList("   ")).toEqual([]);
    expect(parseIcaoList(null)).toEqual([]);
    expect(parseIcaoList(undefined)).toEqual([]);
  });
});

describe("validateIcaoList", () => {
  it("flags ok=true when every code is valid", () => {
    const r = validateIcaoList("KPAE,KBFI,KRNT");
    expect(r.ok).toBe(true);
    expect(r.invalid).toEqual([]);
    expect(r.codes).toEqual(["KPAE", "KBFI", "KRNT"]);
  });

  it("reports invalid codes and ok=false", () => {
    const r = validateIcaoList("KPAE, BAD, KBFI");
    expect(r.ok).toBe(false);
    expect(r.invalid).toEqual(["BAD"]);
  });

  it("ok=false on empty input", () => {
    expect(validateIcaoList("").ok).toBe(false);
  });
});

describe("buildMetarUrl (aviationweather.gov SPA)", () => {
  it("builds a URL pointing at the SPA form route", () => {
    const url = buildMetarUrl({ ids: "KPAE,KBFI" });
    expect(url.startsWith(METAR_FORM_URL)).toBe(true);
    expect(METAR_FORM_URL).toBe("https://aviationweather.gov/data/metar/");
  });

  it("emits decoded=0 / taf=0 by default", () => {
    const u = new URL(buildMetarUrl({ ids: "KPAE" }));
    expect(u.searchParams.get("ids")).toBe("KPAE");
    expect(u.searchParams.get("decoded")).toBe("0");
    expect(u.searchParams.get("taf")).toBe("0");
    expect(u.searchParams.get("hours")).toBe("0");
  });

  it("emits decoded=1 when decoded:true", () => {
    const u = new URL(buildMetarUrl({ ids: "KPAE", decoded: true }));
    expect(u.searchParams.get("decoded")).toBe("1");
  });

  it("emits taf=1 when taf:true", () => {
    const u = new URL(buildMetarUrl({ ids: "KPAE", taf: true }));
    expect(u.searchParams.get("taf")).toBe("1");
  });

  it("matches the verified-working canonical URL shape", () => {
    // From the SPA probe: ?decoded=1&ids=KAWO&hours=3&taf=1 renders METAR + TAF decoded.
    const u = new URL(buildMetarUrl({ ids: "KAWO", decoded: true, hours: 3, taf: true }));
    expect(u.searchParams.get("ids")).toBe("KAWO");
    expect(u.searchParams.get("decoded")).toBe("1");
    expect(u.searchParams.get("hours")).toBe("3");
    expect(u.searchParams.get("taf")).toBe("1");
  });

  it("joins an ICAO array into a comma-separated ids", () => {
    const u = new URL(buildMetarUrl({ ids: ["KPAE", "KBFI"] }));
    expect(u.searchParams.get("ids")).toBe("KPAE,KBFI");
  });

  it("accepts a comma-separated string for ids and normalizes case", () => {
    const u = new URL(buildMetarUrl({ ids: "kpae, kbfi" }));
    expect(u.searchParams.get("ids")).toBe("KPAE,KBFI");
  });

  it("throws when no ids supplied", () => {
    expect(() => buildMetarUrl({ ids: "" })).toThrow(/at least one ICAO/);
    expect(() => buildMetarUrl({})).toThrow();
  });
});
