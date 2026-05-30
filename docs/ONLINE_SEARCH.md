# Online ↗ search

The magnifying-glass button next to the airport-list input resolves freeform
queries — ZIPs, place names, natural-language phrases — to the live nearest
METAR-reporting stations. Stations are always grounded in
[aviationweather.gov]'s bbox METAR feed, never guessed by an LLM.

## The three search paths

| Path | Where it runs | What it queries | Fires |
|---|---|---|---|
| **Local autocomplete** | Client (JS) | bundled `site/data/airports.json` (~12,409 airports — ICAO / name / city) | On every keystroke ≥2 chars |
| **Online Tier 1** (deterministic) | Server (PHP) | zippopotam (US ZIPs) + Nominatim (places) + aviationweather.gov bbox (live METARs) | Click Online ↗ / press Enter |
| **Online Tier 2** (LLM-assisted) | Server (PHP) → Gemini → same grounded geocode + bbox | Gemini extracts intent (place candidates, count); the geocode + station lookup stay grounded | Same click — runs *before* Tier 1, falls back to Tier 1 silently on no key / quota / parse failure |

Local autocomplete is a separate, instant-and-offline path; the two Online tiers
share the same `resolve.php` endpoint.

## Data flow (one Online ↗ click)

```text
       ┌─ Tier 2: Gemini ──────────────────┐
query ─┤                                   ├──► candidates: [{zip?, place?}, …]
       └─ Tier 1: deterministic intent ────┘    (multiple when ambiguous: "King County" → WA + TX)

candidates ──► geocode_place() ──► location {lat, lon, label}
                  ├─ zippopotam (5-digit ZIPs)
                  └─ Nominatim   (place names)

location ──► nearest_metar_stations() ──► [{icao, name, distance_km}, …]
                  └─ aviationweather.gov bbox METAR feed
                     (widens box on retry up to 3×, haversine-sorts results)

response: { groups: [{ interpreted, stations[] }, …] }
```

Stations come only from the live aviationweather.gov response, so the model
can never name a closed or non-reporting field.

## Response shape

`resolve.php` always returns one of:

**200 (one or more groups)** — Tier 2 may return 2–3 groups for ambiguous queries:

```json
{
  "groups": [
    {
      "interpreted": "Nearest METAR to King County, Washington, United States",
      "stations": [
        { "icao": "KRNT", "name": "Renton Muni, WA, US", "distance_km": 26.5 },
        …
      ]
    },
    {
      "interpreted": "Nearest METAR to King County, Texas, United States",
      "stations": [ { "icao": "KCDS", "name": "Childress Muni, TX, US", "distance_km": 93.5 } ]
    }
  ]
}
```

**422** — empty query
**404** — `{ "error": "Couldn't work out a location from \"X\". Try a city or 5-digit ZIP." }`

## The Gemini key (Tier 2)

Tier 1 runs without any key. Tier 2 needs `GEMINI_API_KEY`. The key is read by
`server_secret()` in `site/api/_lib.php`, which checks in order:

1. Process env (`getenv('GEMINI_API_KEY')`)
2. `$_SERVER['GEMINI_API_KEY']` (e.g. `.htaccess SetEnv`)
3. A PHP config file **one level above** `public_html` (recommended)

### Recommended setup on AccuWeb

In cPanel File Manager, **up one level from `public_html`** create
`qmtweb-secrets.php` with `chmod 600`:

```php
<?php
return [
  'GEMINI_API_KEY'    => 'AQ.Ab…your-key…',
  'AVIATIONSTACK_KEY' => 'optional-and-currently-unused',
];
```

The file lives **outside** `public_html` so it's never served over HTTP and
**outside** the deploy's source tree (`site/ → public_html`) so the FTPS deploy
never touches it.

### Local dev

Put the same file at the **repo root** (`qmtweb-secrets.php` next to
`package.json`) — it's gitignored. The CLI dev server reads it via the same
`server_secret()` helper.

## Verification

After deploy or local setup:

```bash
# Tier 1 sanity (no key needed)
curl -s 'https://pailthorp.net/api/resolve.php?q=98624' | jq
# → Ilwaco WA → KAST

# Tier 2 (requires key) — Springfield is the canonical ambiguous test
curl -s 'https://pailthorp.net/api/resolve.php?q=Springfield' | jq '.groups | length'
# → 3 when Tier 2 is healthy (IL / MO / MA); 1 when Tier 2 fell back to Tier 1
```

## Free-tier limits (gemini-2.5-flash)

| Limit | Value | What hits it |
|---|---|---|
| Requests per minute | 20 | Each Online click that goes through to Gemini |
| Requests per day | ~250 | Total daily across users |

When quota is hit, Gemini returns HTTP 429 and `gemini_intent()` returns null;
the client gets a single-group Tier-1 result with no error visible. Future work
to surface the throttle and to cache LLM intents is noted in `NEXT_SESSION.md`.

## Files

| File | Role |
|---|---|
| `site/api/resolve.php` | Entry point — orchestrates tiers, returns grouped JSON |
| `site/api/_lib.php` | Shared helpers: http_get_json, http_post_json, haversine_km, server_secret, geocode_place, cache helpers |
| `site/api/geocode.php` | Standalone geocode endpoint (debug / future reuse) |
| `site/api/aviationstack-lookup.php` | **Disabled stub** (501) — placeholder for future airport-metadata lookup |
| `site/js/icao-control.js` | Client wiring: `runOnlineSearch()`, group rendering, status states, mutex with local autocomplete |
| `qmtweb-secrets.php` | **Outside the repo / public_html.** Holds the key. Read by `server_secret()`. |

## Design constraints (set with the user)

- **Free APIs only** — no paid LLM account, no AviationStack premium tier.
- **Grounded** — the LLM only parses intent; station IDs always come from live
  aviationweather.gov data.
- **On-click only** — Tier 2 never fires per keystroke, only on explicit
  Online ↗ click / Enter / iOS "Search".
- **Silent fallback** — Tier-2 failure (no key, quota, parse error) drops to
  Tier-1 transparently; no error visible to the user beyond what Tier-1 itself
  produces.

[aviationweather.gov]: https://aviationweather.gov/api/data/metar
