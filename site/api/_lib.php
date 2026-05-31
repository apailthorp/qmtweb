<?php
// Shared helpers for the qmtweb PHP proxy endpoints (AccuWeb LiteSpeed, PHP 8).
// These are read-only proxies of PUBLIC data; any API keys come from the server
// environment, never the client. Same-origin only (no CORS header) — the site
// fetches its own /api/*.php.
//
// NB: PHP can't run under `http-server` or in CI, so these are exercised by
// deploying + curl (see docs / NEXT_SESSION). Keep the logic thin.

declare(strict_types=1);

// JSON endpoints must never let PHP notices/warnings into the response body —
// they'd corrupt the JSON for the client. Errors still hit the server log.
ini_set('display_errors', '0');

const HTTP_TIMEOUT = 5;  // seconds per upstream call
const USER_AGENT   = 'qmtweb/1.x (+https://pailthorp.net; METAR station lookup)';

function json_out(array $data, int $status = 200): void {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function json_err(string $message, int $status = 400): void {
    header('Cache-Control: no-store');
    json_out(['error' => $message], $status);
}

// GET JSON over HTTPS via curl. Returns a decoded array, or null on any failure.
function http_get_json(string $url, array $headers = [], int $timeout = HTTP_TIMEOUT): ?array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_CONNECTTIMEOUT => $timeout,
        CURLOPT_USERAGENT      => USER_AGENT,
        CURLOPT_HTTPHEADER     => array_merge(['Accept: application/json'], $headers),
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 3,
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    // curl_close($ch) intentionally omitted: it has been a no-op since PHP 8.0
    // (the handle is released when $ch goes out of scope) and was deprecated in
    // PHP 8.5, where the call itself emits a notice that would corrupt JSON.
    if ($body === false || $code < 200 || $code >= 300) return null;
    $data = json_decode((string) $body, true);
    return is_array($data) ? $data : null;
}

// POST JSON over HTTPS (used for the LLM call). Returns decoded array or null.
//
// $statusOut: optional by-ref out-param that captures the HTTP response code
// (0 on connect/transport failure). Lets callers differentiate "transport
// failed" from "API said 429" from "API said 200 with garbage" — needed by
// gemini_intent() so the client can subtly indicate when Tier-2 fell back.
//
// $errorBodyOut: optional by-ref out-param that captures the PARSED non-2xx
// body when the API returned structured error details (e.g. Gemini 429s carry
// google.rpc.QuotaFailure / google.rpc.RetryInfo blocks the client can use to
// say "rate-limited on the daily quota; retry in ~7s"). Null on transport
// failure or unparseable bodies.
function http_post_json(string $url, array $payload, array $headers = [], int $timeout = HTTP_TIMEOUT, ?int &$statusOut = null, ?array &$errorBodyOut = null): ?array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode($payload),
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_CONNECTTIMEOUT => $timeout,
        CURLOPT_USERAGENT      => USER_AGENT,
        CURLOPT_HTTPHEADER     => array_merge(['Content-Type: application/json', 'Accept: application/json'], $headers),
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $statusOut = (int) $code;
    $errorBodyOut = null;
    // curl_close($ch) intentionally omitted: it has been a no-op since PHP 8.0
    // (the handle is released when $ch goes out of scope) and was deprecated in
    // PHP 8.5, where the call itself emits a notice that would corrupt JSON.
    if ($body === false) return null;
    $parsed = json_decode((string) $body, true);
    if ($code < 200 || $code >= 300) {
        if (is_array($parsed)) $errorBodyOut = $parsed;
        return null;
    }
    return is_array($parsed) ? $parsed : null;
}

// Great-circle distance in kilometres.
function haversine_km(float $lat1, float $lon1, float $lat2, float $lon2): float {
    $r = 6371.0;
    $dLat = deg2rad($lat2 - $lat1);
    $dLon = deg2rad($lon2 - $lon1);
    $a = sin($dLat / 2) ** 2 + cos(deg2rad($lat1)) * cos(deg2rad($lat2)) * sin($dLon / 2) ** 2;
    return $r * 2 * atan2(sqrt($a), sqrt(1 - $a));
}

// Tiny file cache — required for Nominatim fair-use given our shared egress IP.
function cache_get(string $key, int $ttl) {
    $f = _cache_path($key);
    if (!is_file($f) || (time() - filemtime($f)) > $ttl) return null;
    $raw = @file_get_contents($f);
    return $raw === false ? null : json_decode($raw, true);
}
function cache_set(string $key, $value): void {
    @file_put_contents(_cache_path($key), json_encode($value));
}
function _cache_path(string $key): string {
    $dir = sys_get_temp_dir() . '/qmtweb-cache';
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    return $dir . '/' . sha1($key) . '.json';
}

// Read a server-side secret (e.g. GEMINI_API_KEY) without ever shipping it in
// the repo or exposing it over HTTP. Resolution order:
//   1. process env  — getenv() (cPanel "Environment Variables", LiteSpeed, CLI)
//   2. $_SERVER      — e.g. an .htaccess `SetEnv NAME value`
//   3. a PHP config file ONE LEVEL ABOVE the web root: ../qmtweb-secrets.php,
//      returning ['NAME' => 'value', ...]. That dir is outside public_html (not
//      web-accessible) and outside the deploy's source (site/ → public_html),
//      so the key survives every deploy and is never committed.
function server_secret(string $name): ?string {
    $env = getenv($name);
    if ($env !== false && $env !== '') return $env;
    if (!empty($_SERVER[$name])) return (string) $_SERVER[$name];

    static $file = null;
    if ($file === null) {
        $loaded = @include __DIR__ . '/../../qmtweb-secrets.php';
        $file = is_array($loaded) ? $loaded : [];
    }
    return !empty($file[$name]) ? (string) $file[$name] : null;
}

// --- Shared LLM intent helpers ------------------------------------------------
// All Tier-2 providers ingest the same query, emit the same intent shape
// (`{candidates:[{zip?,place?}], count}`), and share the same prompt. Each
// provider file in providers/ is a thin wrapper around the HTTP details
// (URL, auth, response path); the prompt + normalisation live here so prompt
// changes apply uniformly.

// Maximum nearest-station fan-out per resolved location. Capped because each
// candidate triggers a geocode + an aviationweather.gov bbox call.
const NEAREST_DEFAULT = 6;

// Few-shot prompt that primes the model to extract LOCATION candidates as JSON.
// The model is instructed NOT to invent station IDs — stations always come
// from the live AWC bbox feed, never the LLM. JSON-mode keeps the response
// machine-parseable.
function intent_prompt(string $q): string {
    return 'You extract LOCATION candidates from an aviation-weather query. '
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
}

// Normalise the model's parsed JSON to our internal intent shape. Drops
// candidates without a usable ZIP or place; validates ZIP format; trims
// whitespace. Returns null when no candidate survives (caller treats as
// "model produced nothing useful" → fall through to next tier / provider).
function normalize_intent(array $intent): ?array {
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
    if (empty($candidates)) return null;
    return [
        'candidates' => $candidates,
        'count'      => (int) ($intent['count'] ?? NEAREST_DEFAULT),
    ];
}

// Best-effort 429 detail parse for OpenAI-compatible providers. None of them
// return Google's google.rpc.QuotaFailure shape; most return either a Retry-
// After HTTP header (curl gives us this via CURLOPT_HEADER, which we don't
// currently capture — TODO) or a plain JSON error body. We extract whatever
// scalar fields we can find and shape them into the same struct gemini_detail
// uses, so the client renders consistently.
//
// Common error shapes:
//   - OpenRouter: {"error": {"message": "...", "code": 429}}
//   - Groq:       {"error": {"message": "...", "type": "...", "code": "..."}}
//   - Cerebras:   {"message": "...", "type": "..."}
//
// We don't try to parse retry seconds out of the message text — providers
// vary wildly. The client falls back to a generic "busy" chip when
// retry_after_seconds is null.
function parse_openai_429_detail(?array $errBody, int $status): array {
    $msg = null;
    if (is_array($errBody)) {
        $msg = $errBody['error']['message'] ?? $errBody['message'] ?? null;
        if (!is_string($msg)) $msg = null;
    }
    return [
        'scope'               => 'unknown',
        'limit'               => null,
        'retry_after_seconds' => null,
        'quota_id'            => null,
        'message'             => $msg,
    ];
}

// Shared call path for OpenAI-compatible chat-completions providers
// (Cerebras, OpenRouter, Groq). Gemini doesn't use this — its endpoint
// shape is different and it has its own adapter.
//
// $config keys:
//   url      — full POST endpoint, e.g. "https://api.cerebras.ai/v1/chat/completions"
//   model    — model identifier the provider expects, e.g. "llama-3.1-8b-instant"
//   headers  — provider-specific headers (auth, attribution, etc.)
//
// $statusOut / $errorBodyOut: propagated from http_post_json so the orchestrator
// can decide whether a 429 should roll-over to the next provider.
function intent_call_openai_compatible(string $q, array $config, ?int &$statusOut = null, ?array &$errorBodyOut = null): ?array {
    $payload = [
        'model'           => $config['model'],
        'messages'        => [['role' => 'user', 'content' => intent_prompt($q)]],
        'temperature'     => 0,
        'response_format' => ['type' => 'json_object'],
    ];
    $resp = http_post_json($config['url'], $payload, $config['headers'] ?? [], HTTP_TIMEOUT, $statusOut, $errorBodyOut);
    if (!$resp) return null;
    $text = $resp['choices'][0]['message']['content'] ?? null;
    if (!is_string($text) || $text === '') return null;
    $parsed = json_decode($text, true);
    if (!is_array($parsed)) return null;
    return normalize_intent($parsed);
}

// --- Provider-agnostic intent cache -------------------------------------------
// All providers produce the same normalised intent shape, so the cache is
// keyed only on the query — one provider's "Springfield" result serves any
// other provider's call for the same query. Lives here (not in any adapter)
// so adapters don't have load-order dependencies on each other.

const INTENT_CACHE_TTL = 7 * 86400; // 7-day TTL; tuneable here

// Stable cache key for a freeform query. Normalised so casing + whitespace
// variants collide on the same slot. Prefixed so qmtweb-cache entries from
// other endpoints (Nominatim "geo:…") never alias intent entries.
function intent_cache_key(string $q): string {
    return 'intent:' . strtolower(trim($q));
}

// Cache-only lookup. Used by resolve.php's smart-conditional Tier-2 path: if
// we've served this query before with a richer multi-group intent, prefer it
// over Tier-1 — but WITHOUT spending a fresh provider call.
function intent_cached_only(string $q): ?array {
    $cached = cache_get(intent_cache_key($q), INTENT_CACHE_TTL);
    return is_array($cached) && !empty($cached['candidates']) ? $cached : null;
}

// --- Sticky Tier-2 state ------------------------------------------------------
// The orchestrator uses a "sticky current provider" model: stay on whoever
// last worked, only roll forward on 429. State persists across requests in a
// small JSON file above docroot (alongside qmtweb-secrets.php) so it survives
// FTPS deploys + system tmp wipes.
//
// Shape on disk:
//   {
//     "current": "cerebras",          // last provider that returned 'live'
//     "since": "2026-05-30T20:00:00Z", // when current became active
//     "rollovers": [                   // bounded history of roll-overs (last 10)
//       {"from": "gemini", "to": "openrouter", "at": "<iso>", "reason": "throttled"},
//       ...
//     ]
//   }
//
// First-ever request (no file) → returns ['current' => null, ...]; orchestrator
// walks the preference list from the top to pick a starting provider.

const TIER2_STATE_FILE = __DIR__ . '/../../qmtweb-tier2-state.json';
const TIER2_ROLLOVER_HISTORY_MAX = 10;

function tier2_state_load(): array {
    if (!is_file(TIER2_STATE_FILE)) {
        return ['current' => null, 'since' => null, 'rollovers' => []];
    }
    $raw = @file_get_contents(TIER2_STATE_FILE);
    if ($raw === false) {
        return ['current' => null, 'since' => null, 'rollovers' => []];
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        return ['current' => null, 'since' => null, 'rollovers' => []];
    }
    return [
        'current'   => is_string($data['current'] ?? null) ? $data['current'] : null,
        'since'     => is_string($data['since']   ?? null) ? $data['since']   : null,
        'rollovers' => is_array($data['rollovers'] ?? null) ? $data['rollovers'] : [],
    ];
}

function tier2_state_save(array $state): void {
    // Bound the rollover history so the file doesn't grow without limit.
    if (count($state['rollovers']) > TIER2_ROLLOVER_HISTORY_MAX) {
        $state['rollovers'] = array_slice($state['rollovers'], -TIER2_ROLLOVER_HISTORY_MAX);
    }
    // LOCK_EX serialises concurrent writers (two resolve.php requests racing
    // to record a rollover) so we don't half-write the JSON and corrupt the
    // file. Mirrors the qmtweb_stats_emit pattern; the write is a full-file
    // overwrite (not append) so a partial write would leave malformed JSON
    // that tier2_state_load() would fall back from — but better to prevent
    // the situation than rely on the fallback every time.
    @file_put_contents(TIER2_STATE_FILE, json_encode($state, JSON_UNESCAPED_SLASHES), LOCK_EX);
}

// Append a rollover event and update the current provider pointer. Called
// when the previous current provider returned 'throttled'/'error' and the
// orchestrator moved to the next provider that succeeded.
function tier2_state_record_rollover(array $state, string $from, string $to, string $reason): array {
    $state['current'] = $to;
    $state['since']   = gmdate('Y-m-d\TH:i:s\Z');
    $state['rollovers'][] = [
        'from'   => $from,
        'to'     => $to,
        'at'     => $state['since'],
        'reason' => $reason,
    ];
    return $state;
}

// --- Stats logging ------------------------------------------------------------
// Append-only JSON-lines log of every resolve.php call. Lives above docroot
// (next to qmtweb-secrets.php + qmtweb-tier2-state.json) so:
//   1. FTPS deploys never wipe it (deploy only touches public_html)
//   2. It's FTP-harvestable for later analysis
//   3. It's not web-accessible
//
// One line per call. NO raw query string (privacy — q_hash + length only),
// NO IP / user-agent. Shape (see qmtweb_stats_emit for fields):
//   {"ts":"2026-05-30T20:31:42Z","q_hash":"a1b2c3d4","q_len":12,
//    "tier1_groups":1,"tier2_used":"cerebras","tier2_status":"live",
//    "tier2_cache_hit":false,"retry_after":null,"latency_ms":134}

const TIER2_STATS_FILE = __DIR__ . '/../../qmtweb-stats.jsonl';

function qmtweb_stats_emit(array $fields): void {
    // Always force ts + the right shape regardless of what the caller passes —
    // we own the schema, callers just contribute values.
    $line = [
        'ts'              => gmdate('Y-m-d\TH:i:s\Z'),
        'q_hash'          => $fields['q_hash']          ?? null,
        'q_len'           => $fields['q_len']           ?? null,
        'tier1_groups'    => $fields['tier1_groups']    ?? null,
        'tier2_used'      => $fields['tier2_used']      ?? null,  // provider name or null
        'tier2_status'    => $fields['tier2_status']    ?? null,  // 'live'|'throttled'|'error'|'off'|null
        'tier2_cache_hit' => $fields['tier2_cache_hit'] ?? null,
        'retry_after'     => $fields['retry_after']     ?? null,
        'latency_ms'      => $fields['latency_ms']      ?? null,
    ];
    @file_put_contents(
        TIER2_STATS_FILE,
        json_encode($line, JSON_UNESCAPED_SLASHES) . "\n",
        FILE_APPEND | LOCK_EX
    );
}

// Hash a query for stats deduplication WITHOUT leaking the raw text. Short
// hex (first 8 chars of sha1) is enough to count unique queries without
// being reverseable to plaintext for any realistic harvest analysis.
function qmtweb_stats_hash_query(string $q): string {
    return substr(sha1(strtolower(trim($q))), 0, 8);
}

// Geocode a 5-digit US ZIP (zippopotam) or a place name (Nominatim) to
// { lat, lon, label }. Cached aggressively (locations are stable; Nominatim
// fair-use). Returns null if nothing matched.
function geocode_place(string $q): ?array {
    $q = trim($q);
    if ($q === '') return null;

    $cacheKey = 'geo:' . strtolower($q);
    $cached = cache_get($cacheKey, 30 * 86400);
    if (is_array($cached)) return $cached;

    if (preg_match('/^\d{5}$/', $q)) {
        $data = http_get_json("https://api.zippopotam.us/us/$q");
        if ($data && !empty($data['places'][0])) {
            $p = $data['places'][0];
            $out = [
                'lat'   => (float) $p['latitude'],
                'lon'   => (float) $p['longitude'],
                'label' => trim(($p['place name'] ?? '') . ', ' . ($p['state abbreviation'] ?? '') . " $q"),
            ];
            cache_set($cacheKey, $out);
            return $out;
        }
        return null;
    }

    // Place name → Nominatim. Fair-use: real UA (set globally) + Referer, low
    // volume (click-only), cached above. Attribute OpenStreetMap in the UI.
    $url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' . rawurlencode($q);
    $data = http_get_json($url, ['Referer: https://pailthorp.net']);
    if ($data && !empty($data[0]['lat'])) {
        $out = [
            'lat'   => (float) $data[0]['lat'],
            'lon'   => (float) $data[0]['lon'],
            'label' => $data[0]['display_name'] ?? $q,
        ];
        cache_set($cacheKey, $out);
        return $out;
    }
    return null;
}
