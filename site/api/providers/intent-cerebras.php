<?php
// Tier-2 provider adapter: Cerebras.
//
// Sunnyvale chip company — NOT Elon's Grok. Free Llama inference via an
// OpenAI-compatible chat-completions endpoint. Generous free tier
// (~30 req/min, ~14k/day depending on model). API docs:
// https://inference-docs.cerebras.ai/
//
// Auth: `Authorization: Bearer <key>` header. Drop key into qmtweb-secrets.php
// as CEREBRAS_API_KEY. Optional CEREBRAS_MODEL override.

declare(strict_types=1);

const CEREBRAS_ATTRIBUTION = [
    'name' => 'Cerebras',
    'url'  => 'https://www.cerebras.ai/',
];

// Returns null on no-key / failure / unparseable. Sets cerebras_status() +
// cerebras_detail() for the orchestrator + footer rendering.
function cerebras_intent(string $q): ?array {
    $key = server_secret('CEREBRAS_API_KEY');
    if (!$key) { cerebras_status('off'); return null; }

    // Shared intent cache — provider-agnostic (helpers live in _lib.php).
    // A Springfield hit cached by Gemini serves Cerebras callers too; everyone
    // returns the same intent shape so the cache is a free upgrade across the
    // chain.
    $cacheKey = intent_cache_key($q);
    $cached = cache_get($cacheKey, INTENT_CACHE_TTL);
    if (is_array($cached) && !empty($cached['candidates'])) {
        cerebras_status('live');
        return $cached;
    }

    // Free-tier model. Override via CEREBRAS_MODEL secret. Cerebras's free
    // roster rotates aggressively — re-verify against the live /v1/models
    // endpoint if calls start 404ing on the model name (see README provider
    // table for current default). gpt-oss-120b is the current verified
    // free-tier model with reliable JSON-mode support.
    $model = trim((string) (server_secret('CEREBRAS_MODEL') ?? 'gpt-oss-120b'));
    if ($model === '') $model = 'gpt-oss-120b';

    $status = 0; $errBody = null;
    $result = intent_call_openai_compatible(
        $q,
        [
            'url'     => 'https://api.cerebras.ai/v1/chat/completions',
            'model'   => $model,
            'headers' => ['Authorization: Bearer ' . $key],
        ],
        $status,
        $errBody
    );

    if ($status === 429) {
        cerebras_status('throttled');
        cerebras_detail(parse_openai_429_detail($errBody, $status));
        return null;
    }
    if ($result === null) { cerebras_status('error'); return null; }

    cache_set($cacheKey, $result);
    cerebras_status('live');
    return $result;
}

// Public read of the currently-configured Cerebras model. Used by health.php.
function cerebras_model(): string {
    $model = trim((string) (server_secret('CEREBRAS_MODEL') ?? 'gpt-oss-120b'));
    return $model === '' ? 'gpt-oss-120b' : $model;
}

function cerebras_status(?string $newValue = null): string {
    static $value = 'off';
    if ($newValue !== null) $value = $newValue;
    return $value;
}
function cerebras_detail(?array $newValue = null): ?array {
    static $value = null;
    if ($newValue !== null) $value = $newValue;
    return $value;
}
