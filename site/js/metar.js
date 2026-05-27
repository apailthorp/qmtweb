// Pure, unit-testable helpers for the METAR/TAF form.
// Kept free of DOM access so they can be exercised under Vitest.
//
// The site posts to aviationweather.gov's modern SPA at /data/metar/,
// which accepts:
//   ids=KPAE,KBFI   comma-separated ICAOs
//   decoded=1       translated/decoded view (Temperature/Winds/etc.)
//   taf=1           include TAF
//   hours=N         lookback window
// `=0` and "absent" both mean "off" for decoded/taf.

export const METAR_FORM_URL = "https://aviationweather.gov/data/metar/";

const ICAO_PATTERN = /^[A-Z][A-Z0-9]{3}$/;

export function isValidIcao(code) {
  return typeof code === "string" && ICAO_PATTERN.test(code);
}

export function parseIcaoList(input) {
  if (typeof input !== "string") return [];
  return input
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

export function validateIcaoList(input) {
  const codes = parseIcaoList(input);
  const invalid = codes.filter((c) => !isValidIcao(c));
  return { codes, invalid, ok: codes.length > 0 && invalid.length === 0 };
}

export function buildMetarUrl({ ids, decoded = false, hours = 0, taf = false } = {}) {
  const codes = Array.isArray(ids) ? ids : parseIcaoList(ids ?? "");
  if (codes.length === 0) throw new Error("ids: at least one ICAO code is required");

  const params = new URLSearchParams();
  params.set("ids", codes.join(","));
  params.set("decoded", decoded ? "1" : "0");
  params.set("hours", String(hours));
  params.set("taf", taf ? "1" : "0");

  return `${METAR_FORM_URL}?${params.toString()}`;
}
