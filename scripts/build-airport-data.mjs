#!/usr/bin/env node
// One-time data bundler: downloads the OurAirports CSV and writes a
// trimmed JSON to site/data/airports.json for the in-page search box.
//
// Run with: node scripts/build-airport-data.mjs
// Re-run whenever you want fresher data — the JSON is committed.

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SOURCE = "https://davidmegginson.github.io/ourairports-data/airports.csv";

// Filter strategy: keep airports with a 4-letter ICAO (gps_code) that
// are large or medium. Adds small US/Canada airports too so PNW general
// aviation strips (KORS, KFHR, etc.) remain findable.
const KEEP_TYPES = new Set(["large_airport", "medium_airport"]);
const SMALL_KEEP_COUNTRIES = new Set(["US", "CA"]);

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(__dirname, "..", "site", "data", "airports.json");

function parseCsvLine(line) {
  // OurAirports CSV uses RFC-4180 style: fields may be quoted; quoted
  // fields may contain commas and "" escapes for literal quotes.
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === ",") {
        out.push(cur);
        cur = "";
      } else if (c === '"') {
        inQuotes = true;
      } else {
        cur += c;
      }
    }
  }
  out.push(cur);
  return out;
}

function isValidIcao(code) {
  return typeof code === "string" && /^[A-Z][A-Z0-9]{3}$/.test(code);
}

async function main() {
  console.log(`Fetching ${SOURCE} ...`);
  const res = await fetch(SOURCE);
  if (!res.ok) {
    throw new Error(`Fetch failed: HTTP ${res.status}`);
  }
  const csv = await res.text();
  console.log(`Got ${(csv.length / 1024 / 1024).toFixed(1)} MB of CSV`);

  const lines = csv.split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const col = (name) => header.indexOf(name);

  const COL_TYPE = col("type");
  const COL_NAME = col("name");
  const COL_GPS = col("gps_code");
  const COL_IATA = col("iata_code");
  const COL_CITY = col("municipality");
  const COL_COUNTRY = col("iso_country");

  if ([COL_TYPE, COL_NAME, COL_GPS, COL_IATA, COL_CITY, COL_COUNTRY].some((i) => i < 0)) {
    throw new Error("Unexpected CSV header layout");
  }

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = parseCsvLine(line);
    const type = f[COL_TYPE];
    const icao = (f[COL_GPS] ?? "").toUpperCase();
    const country = f[COL_COUNTRY];

    if (!isValidIcao(icao)) continue;
    const keepByType = KEEP_TYPES.has(type);
    const keepSmall = type === "small_airport" && SMALL_KEEP_COUNTRIES.has(country);
    if (!keepByType && !keepSmall) continue;

    out.push({
      icao,
      iata: f[COL_IATA] || null,
      name: f[COL_NAME] || "",
      city: f[COL_CITY] || "",
      country: country || "",
    });
  }

  out.sort((a, b) => a.icao.localeCompare(b.icao));

  // Deduplicate by ICAO (CSV occasionally has duplicates).
  const seen = new Set();
  const deduped = out.filter((a) => {
    if (seen.has(a.icao)) return false;
    seen.add(a.icao);
    return true;
  });

  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(deduped) + "\n");

  const sizeKb = ((await import("node:fs/promises")).stat
    ? (await (await import("node:fs/promises")).stat(OUTPUT)).size / 1024
    : 0);
  console.log(`Wrote ${deduped.length} airports → ${OUTPUT} (${sizeKb.toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
