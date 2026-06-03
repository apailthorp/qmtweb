<?php
// Tier-2 provider adapter: Google Gemini.
//
// Gemini doesn't share the OpenAI-compatible chat-completions shape; its
// endpoint is generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
// with a {contents:[{parts:[{text}]}]} body and a candidates[0].content.parts[0].text
// response path. The provider-specific quirks live here:
//
//   - 429 responses carry a richly-structured error body (google.rpc.QuotaFailure,
//     google.rpc.RetryInfo) that we parse into scope / limit / retry-after for
//     the client. No other provider gives us this level of detail.
//   - The model identifier comes from GEMINI_MODEL secret with a hard-coded
//     fallback. Google rotates which models are on the free tier (e.g.
//     gemini-2.0-flash had its free quota set to 0 in May 2026; gemini-2.5-flash
//     is current). Swap via secrets, no redeploy.

declare(strict_types=1);

// ATTRIBUTION metadata for footer credit. The orchestrator reads this when
// crediting whichever provider served the most recent intent. Keep `name`
// short (used as the brand text); `url` is the public homepage to link.
const GEMINI_ATTRIBUTION = [
    'name' => 'Google Gemini',
    'url'  => 'https://ai.google.dev/',
];

// Default model when GEMINI_MODEL isn't set / is empty. Defined once here
// so gemini_intent() and gemini_model() can't drift apart on the fallback.
const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';

// Returns null (→ next provider in the chain) when no key, error, or
// unparseable. NEVER returns a station — only the location to feed the
// grounded pipeline. Sets gemini_status() / gemini_detail() side-effects
// for the orchestrator + UI.
function gemini_intent(string $q): ?array {
    $key = server_secret('GEMINI_API_KEY');
    if (!$key) { gemini_status('off'); return null; }

    $cacheKey = intent_cache_key($q);
    $cached = cache_get($cacheKey, INTENT_CACHE_TTL);
    if (is_array($cached) && !empty($cached['candidates'])) {
        gemini_status('live');
        return $cached;
    }

    $payload = [
        'contents'         => [['parts' => [['text' => intent_prompt($q)]]]],
        'generationConfig' => ['responseMimeType' => 'application/json', 'temperature' => 0],
    ];
    // GEMINI_MODEL override: swap models without a code deploy. Falls back to
    // the hard-coded default when unset. Whitespace trimmed so a stray newline
    // in the secrets file doesn't produce a 404 from the model endpoint.
    $model = gemini_model();
    $url = 'https://generativelanguage.googleapis.com/v1beta/models/'
        . rawurlencode($model) . ':generateContent';

    // Pass the key in the x-goog-api-key header (Google's preferred method) rather
    // than a ?key= URL param, so it never lands in server/proxy access logs.
    $status = 0; $errBody = null;
    $resp = http_post_json($url, $payload, ['x-goog-api-key: ' . $key], HTTP_TIMEOUT, $status, $errBody);
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

    $result = normalize_intent($intent);
    if ($result === null) { gemini_status('error'); return null; }

    cache_set($cacheKey, $result);
    gemini_status('live');
    return $result;
}

// Public read of the currently-configured Gemini model. Used by /api/health.php
// AND gemini_intent() so the value advertised in the health endpoint matches
// the one the next live call will send. Single source of truth for the
// default lives in GEMINI_DEFAULT_MODEL above.
function gemini_model(): string {
    $model = trim((string) (server_secret('GEMINI_MODEL') ?? GEMINI_DEFAULT_MODEL));
    return $model === '' ? GEMINI_DEFAULT_MODEL : $model;
}

// Tier-2 outcome from the most recent gemini_intent() call. The orchestrator
// reads this to decide whether to roll over to the next provider, and the
// client uses it to render the footer state. Values:
//   'off'       — no GEMINI_API_KEY configured; Gemini was skipped
//   'live'      — Gemini returned a usable intent (or cache hit)
//   'throttled' — Gemini responded with 429 (rate-limited)
//   'error'     — any other failure (5xx, network, unparseable response)
function gemini_status(?string $newValue = null): string {
    static $value = 'off';
    if ($newValue !== null) $value = $newValue;
    return $value;
}

// Structured detail captured from a 429 response (when available). Populated
// from the google.rpc.QuotaFailure / google.rpc.RetryInfo blocks inside
// Gemini's error body. Shape:
//   ['scope' => 'per_day'|'per_minute'|'unknown',
//    'limit' => int|null,
//    'retry_after_seconds' => int|null,
//    'quota_id' => string|null,
//    'message' => string|null]
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
        'message'             => is_string($errBody['error']['message'] ?? null)
            ? (string) $errBody['error']['message']
            : null,
    ];
    $details = $errBody['error']['details'] ?? null;
    if (!is_array($details)) return $detail;

    foreach ($details as $d) {
        if (!is_array($d)) continue;
        $type = (string) ($d['@type'] ?? '');

        if (str_contains($type, 'RetryInfo')) {
            $delay = (string) ($d['retryDelay'] ?? '');
            if (preg_match('/^(\d+(?:\.\d+)?)s$/', $delay, $m)) {
                $detail['retry_after_seconds'] = (int) ceil((float) $m[1]);
            }
        }

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

