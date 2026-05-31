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

// Tier-1 first — saves the bulk of LLM quota.
$tier1Intent = deterministic_intent($q);
$groups = intent_to_groups($tier1Intent);
$tier1GroupCount = count($groups);

// Tier-2 cache upgrade — preferred over Tier-1 when richer (multi-group).
$cacheHit = false;
$cachedTier2 = intent_cached_only($q);
if ($cachedTier2) {
    $cachedGroups = intent_to_groups($cachedTier2);
    if (count($cachedGroups) > count($groups)) {
        $groups = $cachedGroups;
        $cacheHit = true;
    }
}

// Tier-2 live call — only when Tier-1 + cache both came up empty.
$tier2Used   = null;
$tier2Status = null;
$tier2Detail = null;
if (!$groups) {
    $orchestration = run_tier2_chain($q);
    if ($orchestration['intent']) {
        $groups = intent_to_groups($orchestration['intent']);
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
    $errResp = [
        'error' => "Couldn't work out a location from \"$q\". Try a city or 5-digit ZIP.",
    ];
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
// METAR data. Capped at 3 candidates server-side so a malformed or malicious
// model response can't trigger an unbounded fan-out.
function intent_to_groups(?array $intent): array {
    if (!$intent) return [];
    $count      = max(1, min(10, (int) ($intent['count'] ?? NEAREST_DEFAULT)));
    $candidates = is_array($intent['candidates'] ?? null)
        ? array_slice($intent['candidates'], 0, 3)
        : [];

    $groups = [];
    foreach ($candidates as $candidate) {
        if (!is_array($candidate)) continue;
        $location = null;
        if (!empty($candidate['zip'])) $location = geocode_place((string) $candidate['zip']);
        // If the ZIP geocode returned nothing (or there was no ZIP), fall through
        // to the place name so the candidate still has a chance to resolve.
        if ($location === null && !empty($candidate['place'])) {
            $location = geocode_place((string) $candidate['place']);
        }
        if ($location === null) continue;
        $stations = nearest_metar_stations($location['lat'], $location['lon'], $count);
        if (!$stations) continue;
        $groups[] = [
            'interpreted' => 'Nearest METAR to ' . $location['label'],
            'stations'    => $stations,
        ];
    }
    return $groups;
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
// Query live aviationweather.gov METARs in a bbox around the point, widening if
// too sparse, then sort by great-circle distance. Stations come ONLY from here.
function nearest_metar_stations(float $lat, float $lon, int $count): array {
    $half = 0.6; // degrees (~45–65 km); widen on retry
    for ($try = 0; $try < 3; $try++) {
        $bbox = sprintf('%.4f,%.4f,%.4f,%.4f', $lat - $half, $lon - $half, $lat + $half, $lon + $half);
        $data = http_get_json('https://aviationweather.gov/api/data/metar?format=json&bbox=' . rawurlencode($bbox));

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
