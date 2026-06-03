<?php
// Tier-2 provider adapter: OpenRouter.
//
// Aggregator — one key, many models. Free tier exposes a rotating roster of
// `:free` model variants (Llama 3.x, Mistral, etc.). OpenAI-compatible
// chat-completions endpoint. API docs: https://openrouter.ai/docs
//
// Auth: `Authorization: Bearer <key>` header. The HTTP-Referer + X-Title
// headers attribute usage to this site so we stay in good standing on the
// free tier and don't get confused with anonymous abuse.
//
// Drop key into qmtweb-secrets.php as OPENROUTER_API_KEY. Optional
// OPENROUTER_MODEL override (the free roster rotates — re-verify periodically).

declare(strict_types=1);

const OPENROUTER_ATTRIBUTION = [
    'name' => 'OpenRouter',
    'url'  => 'https://openrouter.ai/',
];

// Default model when OPENROUTER_MODEL isn't set / is empty. OpenRouter's
// free roster rotates frequently; verify-providers catches drift before
// release.
const OPENROUTER_DEFAULT_MODEL = 'meta-llama/llama-3.2-3b-instruct:free';

function openrouter_intent(string $q): ?array {
    $key = server_secret('OPENROUTER_API_KEY');
    if (!$key) { openrouter_status('off'); return null; }

    $cacheKey = intent_cache_key($q);
    $cached = cache_get($cacheKey, INTENT_CACHE_TTL);
    if (is_array($cached) && !empty($cached['candidates'])) {
        openrouter_status('live');
        return $cached;
    }

    // OpenRouter free roster rotates frequently; verify availability via
    // `npm run verify:providers`. Default value lives in
    // OPENROUTER_DEFAULT_MODEL.
    $model = openrouter_model();

    $status = 0; $errBody = null;
    $result = intent_call_openai_compatible(
        $q,
        [
            'url'     => 'https://openrouter.ai/api/v1/chat/completions',
            'model'   => $model,
            'headers' => [
                'Authorization: Bearer ' . $key,
                // Optional but recommended — attribute the call to this site
                // so OpenRouter can apply free-tier rate-limits correctly.
                'HTTP-Referer: https://pailthorp.net',
                'X-Title: qmtweb',
            ],
        ],
        $status,
        $errBody
    );

    if ($status === 429) {
        openrouter_status('throttled');
        openrouter_detail(parse_openai_429_detail($errBody, $status));
        return null;
    }
    if ($result === null) { openrouter_status('error'); return null; }

    cache_set($cacheKey, $result);
    openrouter_status('live');
    return $result;
}

// Public read of the currently-configured OpenRouter model. Used by health.php
// AND openrouter_intent() so the advertised value matches the live call.
function openrouter_model(): string {
    $model = trim((string) (server_secret('OPENROUTER_MODEL') ?? OPENROUTER_DEFAULT_MODEL));
    return $model === '' ? OPENROUTER_DEFAULT_MODEL : $model;
}

function openrouter_status(?string $newValue = null): string {
    static $value = 'off';
    if ($newValue !== null) $value = $newValue;
    return $value;
}
function openrouter_detail(?array $newValue = null): ?array {
    static $value = null;
    if ($newValue !== null) $value = $newValue;
    return $value;
}
