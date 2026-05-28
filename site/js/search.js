// Airport search backed by site/data/airports.json (built by
// scripts/build-airport-data.mjs). The dataset is large (~1 MB
// uncompressed); load it lazily so the page itself stays light.

let cache = null;
let pending = null;

const DATA_URL = new URL("../data/airports.json", import.meta.url);

export async function loadAirports(fetcher = globalThis.fetch) {
  if (cache) return cache;
  if (pending) return pending;
  pending = (async () => {
    try {
      const res = await fetcher(DATA_URL);
      if (!res.ok) throw new Error(`airports.json: HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error("airports.json: expected array");
      cache = data;
      return data;
    } catch (err) {
      // Clear pending so a transient failure can be retried on the next call
      // instead of returning the same rejected promise forever.
      pending = null;
      throw err;
    }
  })();
  return pending;
}

// Visible for tests only — lets the harness preload a dataset.
export function _setCache(data) {
  cache = data;
  pending = null;
}

export function _clearCache() {
  cache = null;
  pending = null;
}

function normalize(value) {
  return value === null || value === undefined ? "" : String(value).toLowerCase();
}

// Score = lower-is-better, so we can sort ascending and slice the top N.
// Buckets:
//   0  ICAO exact
//   1  IATA exact
//   2  ICAO prefix
//   3  IATA prefix
//   4  name prefix
//   5  city prefix
//   6  name contains
//   7  city contains
//   8+ no match
function scoreAirport(query, airport) {
  const q = query;
  const icao = normalize(airport.icao);
  const iata = normalize(airport.iata);
  const name = normalize(airport.name);
  const city = normalize(airport.city);

  if (icao === q) return 0;
  if (iata && iata === q) return 1;
  if (icao.startsWith(q)) return 2;
  if (iata && iata.startsWith(q)) return 3;
  if (name.startsWith(q)) return 4;
  if (city.startsWith(q)) return 5;
  if (name.includes(q)) return 6;
  if (city.includes(q)) return 7;
  return Infinity;
}

export function searchAirports(query, airports, { limit = 8 } = {}) {
  if (!query) return [];
  const q = normalize(query).trim();
  if (q.length < 2) return [];

  const scored = [];
  for (const a of airports) {
    const score = scoreAirport(q, a);
    if (score === Infinity) continue;
    scored.push({ score, airport: a });
    // Early exit if we've already collected enough top-bucket matches.
    if (score === 0 && scored.filter((x) => x.score === 0).length >= limit) break;
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.airport.icao.localeCompare(b.airport.icao);
  });

  return scored.slice(0, limit).map((s) => s.airport);
}
