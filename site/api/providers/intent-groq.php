<?php
// Tier-2 provider adapter: Groq.
//
// CRITICAL — Groq is NOT Grok. Groq is a Sunnyvale chip company offering free
// Llama inference via an OpenAI-compatible endpoint. Grok is X.ai's LLM, an
// Elon Musk product. Operator preference excludes Elon products; Groq is fine.
// Naming similarity bites — when adding or modifying this adapter, double-check
// you're not accidentally pointing at api.x.ai.
//
// API docs: https://console.groq.com/docs/api-reference
// Free tier: ~30 RPM / ~14k RPD on llama-3.1-8b-instant (varies by model).
//
// Drop key into qmtweb-secrets.php as GROQ_API_KEY. Optional GROQ_MODEL override.

declare(strict_types=1);

const GROQ_ATTRIBUTION = [
    'name' => 'Groq',
    'url'  => 'https://groq.com/',
];

function groq_intent(string $q): ?array {
    $key = server_secret('GROQ_API_KEY');
    if (!$key) { groq_status('off'); return null; }

    $cacheKey = gemini_intent_cache_key($q);
    $cached = cache_get($cacheKey, GEMINI_INTENT_TTL);
    if (is_array($cached) && !empty($cached['candidates'])) {
        groq_status('live');
        return $cached;
    }

    // Free-tier model. Override via GROQ_MODEL secret. llama-3.1-8b-instant is
    // fast + reliably hits the JSON-mode intent extraction; bump to
    // llama-3.3-70b-versatile if quality on edge cases is worth the higher
    // per-request quota cost.
    $model = trim((string) (server_secret('GROQ_MODEL') ?? 'llama-3.1-8b-instant'));
    if ($model === '') $model = 'llama-3.1-8b-instant';

    $status = 0; $errBody = null;
    $result = intent_call_openai_compatible(
        $q,
        [
            'url'     => 'https://api.groq.com/openai/v1/chat/completions',
            'model'   => $model,
            'headers' => ['Authorization: Bearer ' . $key],
        ],
        $status,
        $errBody
    );

    if ($status === 429) {
        groq_status('throttled');
        groq_detail(parse_openai_429_detail($errBody, $status));
        return null;
    }
    if ($result === null) { groq_status('error'); return null; }

    cache_set($cacheKey, $result);
    groq_status('live');
    return $result;
}

function groq_status(?string $newValue = null): string {
    static $value = 'off';
    if ($newValue !== null) $value = $newValue;
    return $value;
}
function groq_detail(?array $newValue = null): ?array {
    static $value = null;
    if ($newValue !== null) $value = $newValue;
    return $value;
}
