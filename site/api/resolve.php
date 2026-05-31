<?php
// "Online ↗" entry point. Accepts a freeform query (?q=) like
// "airport with METAR nearest to 98624" or "Ilwaco metar", resolves it to a
// location, and returns the nearest live METAR-reporting stations.
//
// GROUNDED: the LLM (Tier 2) only parses intent — station IDs ALWAYS come from
// the live aviationweather.gov bbox response, never the model. If GEMINI_API_KEY
// is unset / quota-spent / errors, it silently falls back to the deterministic
// Tier-1 parser.

declare(strict_types=1);
require __DIR__ . '/_lib.php';

const NEAREST_DEFAULT = 6;

// Tier-2 outcome from the most recent gemini_intent() call. The client uses
// this to subtly indicate "Gemini is degraded" in the footer attribution —
// see styles.css `.gemini-attribution.is-fallback` and the runOnlineSearch
// handler in icao-control.js. Values:
//   'off'       — no GEMINI_API_KEY configured; Tier-2 wasn't even attempted
//   'live'      — Gemini returned a usable intent
//   'throttled' — Gemini responded with 429 (rate-limited)
//   'error'     — any other failure (5xx, network, unparseable response)
// Mapped to a coarser 'live' / 'fallback' / 'off' for the client.
function gemini_status(?string $newValue = null): string {
    static $value = 'off';
    if ($newValue !== null) $value = $newValue;
    return $value;
}

// Structured detail captured from a 429 response (when available). Populated by
// gemini_intent() from the google.rpc.QuotaFailure / google.rpc.RetryInfo blocks
// inside Gemini's error body. Shape:
//   ['scope' => 'per_day'|'per_minute'|'unknown',
//    'limit' => int|null,
//    'retry_after_seconds' => int|null]
// The client uses this to render "rate-limited; retry in ~7s" next to the
// Gemini credit, so the user knows what's happening and when it might resolve.
function gemini_detail(?array $newValue = null): ?array {
    static $value = null;
    if ($newValue !== null) $value = $newValue;
    return $value;
}

// Pull what we can out of a Gemini 429 body. Tolerates missing fields: every
// path may be absent on edge-case error shapes (older API versions, partial
// errors). Returns the structured shape gemini_detail() expects.
//
// IMPORTANT: `retry_after_seconds` is Google's google.rpc.RetryInfo hint —
// for per-minute quotas it's meaningful (wait this long and the slot frees);
// for per-day quotas it's just an inter-request back-off suggestion. The
// daily quota itself usually resets at midnight Pacific time, not after the
// retryDelay elapses. The client uses `scope` to pick the right end-state
// text so we don't claim "ready" while still over the daily limit.
function parse_gemini_429_detail(?array $errBody): array {
    $detail = [
        'scope'               => 'unknown',
        'limit'               => null,
        'retry_after_seconds' => null,
        'quota_id'            => null,
        // Raw human-readable string from Google's error.message — included
        // so the client can surface the unmodified upstream text on hover.
        'message'             => is_string($errBody['error']['message'] ?? null)
            ? (string) $errBody['error']['message']
            : null,
    ];
    $details = $errBody['error']['details'] ?? null;
    if (!is_array($details)) return $detail;

    foreach ($details as $d) {
        if (!is_array($d)) continue;
        $type = (string) ($d['@type'] ?? '');

        // RetryInfo carries the suggested back-off as e.g. "7s" or "7.42s".
        if (str_contains($type, 'RetryInfo')) {
            $delay = (string) ($d['retryDelay'] ?? '');
            if (preg_match('/^(\d+(?:\.\d+)?)s$/', $delay, $m)) {
                $detail['retry_after_seconds'] = (int) ceil((float) $m[1]);
            }
        }

        // QuotaFailure tells us WHICH quota — per-day vs per-minute — and the
        // numeric limit. We expose the first violation; multi-violation 429s
        // are rare in this caller's request pattern.
        if (str_contains($type, 'QuotaFailure') && !empty($d['violations'][0]) && is_array($d['violations'][0])) {
            $v = $d['violations'][0];
            $qid = (string) ($v['quotaId'] ?? '');
            $detail['quota_id'] = $qid !== '' ? $qid : null;
            if (stripos($qid, 'PerDay')    !== false) $detail['scope'] = 'per_day';
            elseif (stripos($qid, 'PerMinute') !== false) $detail['scope'] = 'per_minute';
            if (isset($v['quotaValue'])) $detail['limit'] = (int) $v['quotaValue'];
        }
    }
    return $detail;
}

$q = trim($_GET['q'] ?? '');
if ($q === '') json_err('Type a place, ZIP, or airport to search online.', 422);

// Tier 2 (free LLM) with silent fallback to Tier 1 (deterministic). Both tiers
// now return a list of candidates: 1 for unambiguous queries, 2-3 for ambiguous
// ones like "WA" (state vs. country code) or "King County" (TX vs. WA).
$intent     = gemini_intent($q) ?? deterministic_intent($q);
$count      = max(1, min(10, (int) ($intent['count'] ?? NEAREST_DEFAULT)));
// Cap server-side regardless of what the LLM returned, so a malformed or
// malicious Gemini response can't trigger an unbounded fan-out of geocode +
// aviationweather.gov calls. Matches the documented 2-3 candidate contract.
$candidates = is_array($intent['candidates'] ?? null)
    ? array_slice($intent['candidates'], 0, 3)
    : [];

// Geocode each candidate, collect the nearest stations per location into a
// group. Silently drop candidates that don't geocode or have no reporters.
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

if (!$groups) {
    json_err("Couldn't work out a location from \"$q\". Try a city or 5-digit ZIP.", 404);
}

// Coarse public mapping — the client only needs to know if Tier-2 was
// degraded (`fallback`) so it can italicize the Gemini attribution. The full
// 'throttled' / 'error' / 'off' / 'live' detail stays server-side; "off" is
// indistinguishable from "live" in the UI because Gemini-was-never-asked is
// not a degradation worth surfacing.
$tier2Raw    = gemini_status();
$tier2Public = match ($tier2Raw) {
    'live'      => 'live',
    'off'       => 'off',
    'throttled' => 'fallback',
    default     => 'fallback', // 'error'
};

$response = ['groups' => $groups, 'tier2' => $tier2Public];
// Only attach detail when we actually have parsed quota info (throttled
// state). 'error' and 'live' / 'off' carry no detail to surface.
$detail = $tier2Raw === 'throttled' ? gemini_detail() : null;
if ($detail) $response['tier2_detail'] = $detail;

header('Cache-Control: no-store');
json_out($response);

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

// --- Tier 2: Gemini intent extraction (free tier) -----------------------------
// Returns null (→ Tier 1) when no key, error, or unparseable. NEVER returns a
// station — only the location to feed the grounded pipeline.
function gemini_intent(string $q): ?array {
    $key = server_secret('GEMINI_API_KEY');
    if (!$key) { gemini_status('off'); return null; }

    $prompt = 'You extract LOCATION candidates from an aviation-weather query. '
        . 'Station identifiers come from a separate live feed — never from you.'
        . "\n\n"
        . 'Return ONLY JSON matching {"candidates":[{"zip":"","place":""}],"count":6}.'
        . "\n"
        . '- "zip": 5-digit US ZIP or "".' . "\n"
        . '- "place": a city/county/region. Always include the state OR country '
        . 'when more than one place shares the name. Use postal-style: '
        . '"King County, WA" not "King County, Washington".' . "\n"
        . '- "count": stations per candidate (default 6).' . "\n\n"
        . 'When the query could refer to multiple real places worldwide, return '
        . '2-3 candidates covering the most plausible. List the strongest first. '
        . 'Otherwise return a single candidate.'
        . "\n\n"
        . 'Examples:' . "\n"
        . '- "King County" → [{"place":"King County, WA"},{"place":"King County, TX"}]' . "\n"
        . '- "WA" → [{"place":"Washington, USA"},{"place":"Western Australia, AU"}]' . "\n"
        . '- "Springfield" → [{"place":"Springfield, IL"},{"place":"Springfield, MO"},{"place":"Springfield, MA"}]' . "\n"
        . '- "Boring" → [{"place":"Boring, OR"},{"place":"Boring, MD"}]' . "\n"
        . '- "Ilwaco" → [{"place":"Ilwaco, WA"}]' . "\n"
        . '- "98624" → [{"zip":"98624","place":""}]' . "\n"
        . '- "where can I land near Spokane" → [{"place":"Spokane, WA"}]' . "\n\n"
        . 'Do NOT name any airport or station. Query: ' . $q;

    $payload = [
        'contents'         => [['parts' => [['text' => $prompt]]]],
        'generationConfig' => ['responseMimeType' => 'application/json', 'temperature' => 0],
    ];
    // Free-tier model. Google rotates which models are on the free tier (e.g.
    // gemini-2.0-flash had its free quota set to 0 in May 2026; gemini-2.5-flash
    // is the current free-tier default). Re-verify on key setup if Tier 2 stops
    // firing — a 429 with `limit: 0` here usually means the model has rotated.
    //
    // GEMINI_MODEL override: set `GEMINI_MODEL` in qmtweb-secrets.php (or env)
    // to swap models without a code deploy. Falls back to the hard-coded default
    // when unset. Whitespace is trimmed so a stray newline in the secrets file
    // doesn't produce a 404 from the model endpoint.
    $model = trim((string) (server_secret('GEMINI_MODEL') ?? 'gemini-2.5-flash'));
    if ($model === '') $model = 'gemini-2.5-flash';
    $url = 'https://generativelanguage.googleapis.com/v1beta/models/'
        . rawurlencode($model) . ':generateContent';

    // Pass the key in the x-goog-api-key header (Google's preferred method) rather
    // than a ?key= URL param, so it never lands in server/proxy access logs.
    $status = 0; $errBody = null;
    $resp = http_post_json($url, $payload, ['x-goog-api-key: ' . $key], HTTP_TIMEOUT, $status, $errBody);
    // Classify the outcome so the client can subtly indicate "Tier-2 fell back"
    // in the footer. 429 is the common case the user notices ("multi-group
    // results stopped working"); other failures collapse to a single 'error'.
    if ($status === 429) {
        gemini_status('throttled');
        gemini_detail(parse_gemini_429_detail($errBody));
        return null;
    }
    if (!$resp) { gemini_status('error'); return null; }
    $text = $resp['candidates'][0]['content']['parts'][0]['text'] ?? null;
    if (!$text) { gemini_status('error'); return null; }

    $intent = json_decode($text, true);
    if (!is_array($intent)) { gemini_status('error'); return null; }

    // Clean each candidate: keep only ones with a usable ZIP or place. Trim
    // whitespace and validate the ZIP format. Drop empties so the caller can
    // fall back to Tier-1 when Gemini returns nothing actionable.
    $raw = is_array($intent['candidates'] ?? null) ? $intent['candidates'] : [];
    $candidates = [];
    foreach ($raw as $c) {
        if (!is_array($c)) continue;
        $zip = (string) ($c['zip'] ?? '');
        $zip = preg_match('/^\d{5}$/', $zip) ? $zip : '';
        $place = is_string($c['place'] ?? null) ? trim($c['place']) : '';
        if ($zip === '' && $place === '') continue;
        $candidates[] = ['zip' => $zip, 'place' => $place];
    }
    if (empty($candidates)) { gemini_status('error'); return null; }

    gemini_status('live');
    return [
        'candidates' => $candidates,
        'count'      => (int) ($intent['count'] ?? NEAREST_DEFAULT),
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
