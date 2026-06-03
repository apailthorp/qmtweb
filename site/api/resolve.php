<?php
// "Online ↗" entry point. Accepts a freeform query (?q=) like
// "airport with METAR nearest to 98624" or "Ilwaco metar", resolves it to a
// location, and returns the nearest live METAR-reporting stations.
//
// GROUNDED: every Tier-2 LLM provider only parses intent — station IDs ALWAYS
// come from the live aviationweather.gov bbox response, never the model. When
// no provider is configured / all are throttled / all error, it silently falls
// back to the deterministic Tier-1 parser.
//
// Architecture (v1.4.0):
//
//   site/api/_lib.php             — shared helpers (HTTP, cache, intent prompt,
//                                    normalize_intent, OpenAI-compat caller,
//                                    sticky-state, stats logging)
//   site/api/providers/intent-*.php — one adapter per Tier-2 provider
//   site/api/resolve.php          — this file: Tier-1 first, then cache, then
//                                    walk the sticky-current Tier-2 chain
//
// Tier-2 provider chain (sticky-current):
//   1. Stay on whoever last worked ('current' in qmtweb-tier2-state.json).
//   2. If current returns null (no key / 429 / error), walk the preference
//      list in PROVIDER_CHAIN order, skipping providers already tried this
//      request. First non-null result wins.
//   3. On a successful rollover, persist the new current so subsequent
//      requests start from there. Reasoning: quota distribution and the
//      operator's stated "no reason not to stay there" preference.
//
// Excluded by policy: Grok (X.ai) is dis-preferred. Groq (Sunnyvale, not Elon)
// is included.

declare(strict_types=1);
require __DIR__ . '/_lib.php';
require __DIR__ . '/providers/intent-gemini.php';
require __DIR__ . '/providers/intent-openrouter.php';
require __DIR__ . '/providers/intent-cerebras.php';
require __DIR__ . '/providers/intent-groq.php';

// Preference order — used for first-ever calls (no sticky state) and as the
// roll-over walk order. Each entry: provider name (matches state file values)
// → intent function + status accessor + detail accessor + attribution.
//
// Order rationale:
//   1. Gemini — richest 429 detail surfacing; smallest quota so it's the
//      "canary" we'd rather burn first when no current is set
//   2. OpenRouter — operator preference; aggregator with rotating free roster
//   3. Cerebras — operator preference; generous fixed free quota
//   4. Groq — also fine; round-trip latency is great when available
const PROVIDER_CHAIN = [
    [
        'name'          => 'gemini',
        'intent_fn'     => 'gemini_intent',
        'status_fn'     => 'gemini_status',
        'detail_fn'     => 'gemini_detail',
        'attribution'   => GEMINI_ATTRIBUTION,
    ],
    [
        'name'          => 'openrouter',
        'intent_fn'     => 'openrouter_intent',
        'status_fn'     => 'openrouter_status',
        'detail_fn'     => 'openrouter_detail',
        'attribution'   => OPENROUTER_ATTRIBUTION,
    ],
    [
        'name'          => 'cerebras',
        'intent_fn'     => 'cerebras_intent',
        'status_fn'     => 'cerebras_status',
        'detail_fn'     => 'cerebras_detail',
        'attribution'   => CEREBRAS_ATTRIBUTION,
    ],
    [
        'name'          => 'groq',
        'intent_fn'     => 'groq_intent',
        'status_fn'     => 'groq_status',
        'detail_fn'     => 'groq_detail',
        'attribution'   => GROQ_ATTRIBUTION,
    ],
];

$reqStartMs = (int) (microtime(true) * 1000);

$q = trim($_GET['q'] ?? '');
if ($q === '') json_err('Type a place, ZIP, or airport to search online.', 422);

// Detect "TAF" in the raw query BEFORE deterministic_intent strips it as
// filler. When present, narrow the bbox lookup to TAF-publishing stations
// (a subset of METAR-reporting stations — typically the major airports;
// e.g. for the Seattle bbox: METAR returns 9 stations, TAF returns 6).
// The intent / candidates / cache key stay TAF-agnostic — only the final
// AWC endpoint switches — so the same Gemini result serves both "King
// County" and "King County TAF" with the filter applied client-side of
// the cache.
$tafOnly = (bool) preg_match('/\btafs?\b/i', $q);

// Normalised form for Tier-2 cache lookups + LLM prompts: same query
// MINUS the TAF token (which controls station filtering, not location).
// "King County" and "King County TAF" thus share one cache entry and one
// Gemini call — only the bbox endpoint switches downstream. deterministic_intent
// still runs on the raw $q because its own filler-strip already covers TAF.
$qNormalized = normalize_intent_query($q);

// Tier-1 first — saves the bulk of LLM quota. Track $geocodedAny across all
// three intent_to_groups call sites below so the empty-result error path can
// distinguish "location resolved but no nearby stations" from "couldn't work
// out a location at all". The latter wants ZIP / city advice; the former
// wants "no <METAR/TAF> stations near <place>".
$geocodedAny = false;
$tier1Intent = deterministic_intent($q);
$groups = intent_to_groups($tier1Intent, $tafOnly, $geocodedAny);
$tier1GroupCount = count($groups);

// Tier-2 cache upgrade — preferred over Tier-1 when richer (multi-group).
$cacheHit = false;
$cachedTier2 = intent_cached_only($qNormalized);
if ($cachedTier2) {
    $cachedGeocoded = false;
    $cachedGroups = intent_to_groups($cachedTier2, $tafOnly, $cachedGeocoded);
    $geocodedAny = $geocodedAny || $cachedGeocoded;
    if (count($cachedGroups) > count($groups)) {
        $groups = $cachedGroups;
        $cacheHit = true;
    }
}

// Tier-2 live call — fires when:
//   (a) Tier-1 + cache both produced nothing (must escalate), OR
//   (b) Tier-1 produced exactly one group AND the query looks ambiguous
//       (short, non-ZIP). Without (b), single-word famously-ambiguous places
//       like "King County" or "Springfield" lose their multi-group discovery
//       because Tier-1 always resolves them to one Nominatim result.
//
// The "richer-wins" rule: only adopt the Tier-2 intent if it produces MORE
// groups than Tier-1. Equal groups → keep Tier-1 (no benefit to swap). The
// successful Tier-2 result is cached regardless, so subsequent "King County"
// queries serve from cache without re-spending quota.
$tier2Used   = null;
$tier2Status = null;
$tier2Detail = null;
$shouldEscalate = empty($groups) || (count($groups) === 1 && !$cacheHit && is_likely_ambiguous($qNormalized));
if ($shouldEscalate) {
    $orchestration = run_tier2_chain($qNormalized);
    if ($orchestration['intent']) {
        $tier2Geocoded = false;
        $tier2Groups = intent_to_groups($orchestration['intent'], $tafOnly, $tier2Geocoded);
        $geocodedAny = $geocodedAny || $tier2Geocoded;
        // Adopt Tier-2 if it strictly improves on Tier-1.
        if (count($tier2Groups) > count($groups)) {
            $groups = $tier2Groups;
        }
    }
    $tier2Used   = $orchestration['provider'];
    $tier2Status = $orchestration['status'];
    $tier2Detail = $orchestration['detail'];
}

// If cache hit served the result, credit whichever provider is currently
// sticky (we re-used a cached intent — but the user is still seeing Tier-2
// quality, and crediting the current provider keeps the footer consistent
// across consecutive identical queries).
if ($cacheHit && $tier2Used === null) {
    $state = tier2_state_load();
    $stickyName = $state['current'];
    if ($stickyName) {
        $tier2Used   = $stickyName;
        $tier2Status = 'live';
    } else {
        // First-ever query, cache hit but no sticky yet — credit the chain head.
        $tier2Used   = PROVIDER_CHAIN[0]['name'];
        $tier2Status = 'live';
    }
}

if (!$groups) {
    qmtweb_stats_emit([
        'q_hash'          => qmtweb_stats_hash_query($q),
        'q_len'           => strlen($q),
        'tier1_groups'    => $tier1GroupCount,
        'tier2_used'      => $tier2Used,
        'tier2_status'    => $tier2Status,
        'tier2_cache_hit' => $cacheHit,
        'retry_after'     => $tier2Detail['retry_after_seconds'] ?? null,
        'latency_ms'      => (int) (microtime(true) * 1000) - $reqStartMs,
    ]);
    // Even on a 404, carry tier2 status so the footer can italicise + show the
    // 429 detail when applicable. Without this the user sees "couldn't work
    // out a location" with no hint that Tier-2 is throttled and they're stuck
    // on Tier-1-only resolution.
    //
    // Two distinct failure modes — picking the right message changes what the
    // user does next:
    //   geocodedAny=false  →  intent / location couldn't be worked out at
    //                          all; ZIP / city advice is the help they need.
    //   geocodedAny=true   →  location resolved but no nearby stations of the
    //                          requested product. Common for `<place> TAF`
    //                          searches in TAF-sparse regions; the user can
    //                          drop the TAF filter or try a nearby major city.
    $product = $tafOnly ? 'TAF' : 'METAR';
    $errMsg = $geocodedAny
        ? "Found a location for \"$q\" but no nearby $product stations."
        : "Couldn't work out a location from \"$q\". Try a city or 5-digit ZIP.";
    $errResp = ['error' => $errMsg];
    if ($tier2Status === 'throttled' || $tier2Status === 'error') {
        $errResp['tier2']             = 'fallback';
        $errResp['tier2_provider']    = $tier2Used;
        $errResp['tier2_attribution'] = $tier2Used ? provider_attribution($tier2Used) : null;
        if ($tier2Detail) $errResp['tier2_detail'] = $tier2Detail;
    }
    header('Cache-Control: no-store');
    json_out($errResp, 404);
}

// --- Build response -----------------------------------------------------------
// `tier2` is the coarse public state for the footer-italic indicator:
//   'live'     — Tier-2 served (live or cached, any provider)
//   'fallback' — a Tier-2 provider was attempted and failed (degraded)
//   'off'      — Tier-2 wasn't called this request (Tier-1 sufficed) OR all
//                providers have no key configured
$tier2Public = match (true) {
    $tier2Status === 'live'                   => 'live',
    $tier2Status === 'throttled'              => 'fallback',
    $tier2Status === 'error'                  => 'fallback',
    $tier2Status === null && !$cacheHit       => 'off',
    default                                   => 'off',
};

// Resolve the attribution metadata for whichever provider gets footer credit.
// On a Tier-2 fallback, we still credit the currently-sticky provider (the
// one we *expected* to serve) — the italic + chip already communicate that
// it failed, no need to swap the brand to nothing.
$creditedProvider = $tier2Used ?? (tier2_state_load()['current'] ?? PROVIDER_CHAIN[0]['name']);
$attribution = provider_attribution($creditedProvider);

$response = [
    'groups'             => $groups,
    'tier2'              => $tier2Public,
    'tier2_provider'     => $creditedProvider,
    'tier2_attribution'  => $attribution,
];
if ($tier2Detail) $response['tier2_detail'] = $tier2Detail;

// Stats emission — every successful resolve gets one line. Failure path
// emits its own line above so we capture 404s too.
qmtweb_stats_emit([
    'q_hash'          => qmtweb_stats_hash_query($q),
    'q_len'           => strlen($q),
    'tier1_groups'    => $tier1GroupCount,
    'tier2_used'      => $tier2Used,
    'tier2_status'    => $tier2Status,
    'tier2_cache_hit' => $cacheHit,
    'retry_after'     => $tier2Detail['retry_after_seconds'] ?? null,
    'latency_ms'      => (int) (microtime(true) * 1000) - $reqStartMs,
]);

header('Cache-Control: no-store');
json_out($response);

// --- Orchestration ------------------------------------------------------------
// Walk the chain starting from the sticky current. On 429 / error, move to
// the next provider in PROVIDER_CHAIN order (skipping already-tried). First
// non-null result becomes the new sticky current.
//
// Returns:
//   ['intent' => ?array, 'provider' => ?string, 'status' => ?string, 'detail' => ?array]
// 'intent' is null when every provider in the chain returned null.
function run_tier2_chain(string $q): array {
    $state = tier2_state_load();
    $startName = $state['current']; // null on first-ever call

    // Build ordered chain: sticky current first (if set + valid), then the
    // remaining providers in PROVIDER_CHAIN order. Each provider tried at
    // most once per request.
    $chainOrder = build_chain_order($startName);

    // Capture the FIRST provider's failure detail so the client can render
    // the fallback indicator with rich info (Gemini's 429 detail surfaces here
    // when Gemini is the sticky current — most common case).
    $firstFailStatus   = null;
    $firstFailDetail   = null;
    $firstFailProvider = null;

    foreach ($chainOrder as $entry) {
        $intent = call_user_func($entry['intent_fn'], $q);
        $status = call_user_func($entry['status_fn']);
        $detail = call_user_func($entry['detail_fn']);

        if ($intent !== null) {
            // Success — update sticky state if this isn't already the current.
            // 'from' on the rollover record is the ORIGINAL sticky (or '(none)'
            // on first-ever); intermediate failed probes are implicit in the
            // gap between rollover entries.
            if ($state['current'] !== $entry['name']) {
                $reason = $startName ? 'rollover-from-' . $startName : 'initial';
                $state = tier2_state_record_rollover(
                    $state,
                    $startName ?? '(none)',
                    $entry['name'],
                    $reason
                );
                tier2_state_save($state);
            }
            return [
                'intent'   => $intent,
                'provider' => $entry['name'],
                'status'   => $status, // 'live'
                'detail'   => null,
            ];
        }

        if ($firstFailProvider === null) {
            $firstFailStatus   = $status;
            $firstFailDetail   = $detail;
            $firstFailProvider = $entry['name'];
        }
    }

    // Every provider returned null — surface the FIRST attempted provider's
    // detail (most actionable for the user — that's the one we *expected*
    // to serve and want to explain).
    return [
        'intent'   => null,
        'provider' => $firstFailProvider,
        'status'   => $firstFailStatus ?? 'error',
        'detail'   => $firstFailDetail,
    ];
}

// Reorder PROVIDER_CHAIN so the sticky current comes first (if it's a known
// provider). Unknown / null current → use PROVIDER_CHAIN order as-is.
function build_chain_order(?string $currentName): array {
    $rest = [];
    $first = null;
    foreach (PROVIDER_CHAIN as $entry) {
        if ($currentName !== null && $entry['name'] === $currentName) {
            $first = $entry;
        } else {
            $rest[] = $entry;
        }
    }
    return $first ? array_merge([$first], $rest) : $rest;
}

// Look up the attribution block for a provider name. Falls back to the head
// of the chain when the name is unknown (defensive — stale state file etc.).
function provider_attribution(string $name): array {
    foreach (PROVIDER_CHAIN as $entry) {
        if ($entry['name'] === $name) return $entry['attribution'];
    }
    return PROVIDER_CHAIN[0]['attribution'];
}

// --- Intent → groups pipeline -------------------------------------------------
// Both Tier-1 and Tier-2 produce the same shape (`['candidates' => [...], 'count' => N]`).
// This helper turns either one into the public `[{interpreted, stations[]}, ...]`
// list by geocoding each candidate and grounding it in live aviationweather.gov
// data. Capped at 3 candidates server-side so a malformed or malicious model
// response can't trigger an unbounded fan-out.
//
// When $tafOnly is true, the bbox lookup uses the AWC TAF endpoint instead of
// METAR — narrows results to stations that publish forecast TAFs (a subset of
// METAR-reporting stations). The group label also flips from "Nearest METAR
// to …" to "Nearest TAF to …" so the user can see the narrowed search applied.
//
// $geocodedAny: by-ref out param. Set to true when AT LEAST ONE candidate
// resolved to a location, regardless of whether nearby stations were found.
// Lets the caller distinguish "we couldn't work out a location" from "we
// found the location but no nearby <product> stations" — different errors
// from the user's point of view (the latter is common with $tafOnly=true
// since TAF-publishing stations are a small subset of METAR ones).
function intent_to_groups(?array $intent, bool $tafOnly = false, bool &$geocodedAny = false): array {
    $geocodedAny = false;
    if (!$intent) return [];
    $count      = max(1, min(10, (int) ($intent['count'] ?? NEAREST_DEFAULT)));
    $candidates = is_array($intent['candidates'] ?? null)
        ? array_slice($intent['candidates'], 0, 3)
        : [];

    $product = $tafOnly ? 'TAF' : 'METAR';
    $groups = [];
    foreach ($candidates as $candidate) {
        if (!is_array($candidate)) continue;
        $location = null;
        $queryUsed = null;
        if (!empty($candidate['zip'])) {
            $queryUsed = (string) $candidate['zip'];
            $location = geocode_place($queryUsed);
        }
        // If the ZIP geocode returned nothing (or there was no ZIP), fall through
        // to the place name so the candidate still has a chance to resolve.
        if ($location === null && !empty($candidate['place'])) {
            $queryUsed = (string) $candidate['place'];
            $location = geocode_place($queryUsed);
        }
        if ($location === null) continue;
        $geocodedAny = true;
        $stations = nearest_metar_stations($location['lat'], $location['lon'], $count, $tafOnly);
        if (!$stations) continue;
        $groups[] = [
            'interpreted' => "Nearest $product to " . $location['label'],
            // Diagnostic fields the client surfaces on hover so the user can
            // see WHY a query resolved here. `sent` is what we fed the
            // geocoder (the intent's place/zip — possibly LLM-rewritten);
            // `raw` is the geocoder's verbose match. Together they explain
            // results like "opossum → Ripley, TN".
            'sent'        => $queryUsed,
            'raw'         => $location['raw'] ?? null,
            // Coordinates of the resolved point — the client turns the group
            // header / status line into a link to openstreetmap.org centered
            // on this lat/lon so a click jumps straight to the map.
            'lat'         => $location['lat'],
            'lon'         => $location['lon'],
            'stations'    => $stations,
        ];
    }
    return $groups;
}

// Cheap heuristic for "this query might be a famously-ambiguous place name
// even though Tier-1 happened to resolve it to one Nominatim result". Used
// by the escalation logic to opportunistically probe Tier-2 for richer
// multi-group answers. Conservative — bails out for ZIPs (always unambiguous)
// and longer queries (usually carry disambiguating context).
function is_likely_ambiguous(string $q): bool {
    // Explicit US ZIP → unambiguous by construction.
    if (preg_match('/\b\d{5}\b/', $q)) return false;
    // Strip filler + connectives so "airports near Springfield" counts as
    // one word ("Springfield"), not three.
    $stripped = preg_replace(
        '/\b('
        . 'nearest|closest|near|both|either|or|and|'
        . 'airports?|airfields?|airforce|airbase|bases?|field|'
        . 'metars?|tafs?|stations?|reporting|weather|'
        . 'to|the|for|me|in|at|of'
        . ')\b/i',
        ' ',
        $q
    );
    $stripped = trim(preg_replace('/\s+/', ' ', $stripped));
    if ($stripped === '') return false;
    $wordCount = count(explode(' ', $stripped));
    // 1–3 meaningful words covers the famously-ambiguous bucket
    // (Springfield / King County / Portland / Boring / WA / Salem / Vienna ...).
    // 4+ words usually carry explicit disambiguating context.
    return $wordCount >= 1 && $wordCount <= 3;
}

// --- Tier 1: deterministic intent ---------------------------------------------
// Strip filler, detect a 5-digit ZIP, else treat the remainder as a place name.
// The filler list covers natural-language phrasings like "Airforce base in
// Washington" or "San Juan Islands airfields" so Nominatim sees a clean place.
// \b boundaries prevent false matches inside place names (e.g. "field" doesn't
// match inside "Springfield"). Keep additions narrow: words that almost always
// describe an aviation facility category or are prepositions.
function deterministic_intent(string $q): array {
    if (preg_match('/\b(\d{5})\b/', $q, $m)) {
        return [
            'candidates' => [['zip' => $m[1], 'place' => '']],
            'count'      => NEAREST_DEFAULT,
        ];
    }
    $place = preg_replace(
        '/\b('
        . 'nearest|closest|near|'
        . 'airports?|airfields?|airforce|airbase|bases?|field|'
        . 'metars?|tafs?|stations?|reporting|weather|'
        . 'to|the|for|me|in|at|of'
        . ')\b/i',
        ' ',
        $q
    );
    $place = trim(preg_replace('/\s+/', ' ', $place));
    return [
        'candidates' => [['zip' => '', 'place' => $place !== '' ? $place : $q]],
        'count'      => NEAREST_DEFAULT,
    ];
}

// --- Grounded station lookup --------------------------------------------------
// Query live aviationweather.gov stations in a bbox around the point, widening
// if too sparse, then sort by great-circle distance. Stations come ONLY from
// here. When $tafOnly is true, the TAF endpoint is queried instead of METAR —
// the subset of reporting stations that publish forecast TAFs (typically the
// major airports). Same record shape (icaoId, lat, lon, name) either way, so
// the rest of the loop is endpoint-agnostic.
function nearest_metar_stations(float $lat, float $lon, int $count, bool $tafOnly = false): array {
    $endpoint = $tafOnly ? 'taf' : 'metar';
    $half = 0.6; // degrees (~45–65 km); widen on retry
    for ($try = 0; $try < 3; $try++) {
        $bbox = sprintf('%.4f,%.4f,%.4f,%.4f', $lat - $half, $lon - $half, $lat + $half, $lon + $half);
        $data = http_get_json("https://aviationweather.gov/api/data/$endpoint?format=json&bbox=" . rawurlencode($bbox));

        if (is_array($data) && count($data) > 0) {
            $stations = [];
            $seen = [];
            foreach ($data as $m) {
                // Field names vary; be defensive.
                $icao = $m['icaoId'] ?? $m['station_id'] ?? $m['icao'] ?? null;
                $slat = isset($m['lat']) ? (float) $m['lat'] : null;
                $slon = isset($m['lon']) ? (float) $m['lon'] : null;
                if (!$icao || $slat === null || $slon === null || isset($seen[$icao])) continue;
                $seen[$icao] = true;
                $stations[] = [
                    'icao'        => (string) $icao,
                    'name'        => $m['name'] ?? null,
                    'distance_km' => round(haversine_km($lat, $lon, $slat, $slon), 1),
                ];
            }
            if ($stations) {
                usort($stations, fn($a, $b) => $a['distance_km'] <=> $b['distance_km']);
                return array_slice($stations, 0, $count);
            }
        }
        $half *= 2; // widen and retry
    }
    return [];
}
