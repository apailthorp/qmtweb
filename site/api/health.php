<?php
// Lightweight read-only health endpoint for the Tier-2 provider chain.
//
// Returns which providers have a configured API key — used by the client on
// page load to prune the footer credit list to only credit providers this
// deploy can actually call. Adding a key in qmtweb-secrets.php and reloading
// the page is enough to "go live" — no markup change needed.
//
// Response shape:
//   {
//     "tier2_providers": [
//       {"name": "gemini",     "configured": true,  "attribution": {"name":"...","url":"..."}},
//       {"name": "openrouter", "configured": true,  "attribution": {...}},
//       {"name": "cerebras",   "configured": true,  "attribution": {...}},
//       {"name": "groq",       "configured": false, "attribution": {...}}
//     ]
//   }
//
// `configured` simply means a non-empty API key exists at server_secret('<NAME>_API_KEY').
// We deliberately do NOT probe the provider here — that would cost quota on
// every page load. A configured key is the contract; if it's bad, the user
// will see the chain roll past that provider when they try a query.
//
// No raw keys, model overrides, or sticky state leak through this endpoint.

declare(strict_types=1);
require __DIR__ . '/_lib.php';
require __DIR__ . '/providers/intent-gemini.php';
require __DIR__ . '/providers/intent-openrouter.php';
require __DIR__ . '/providers/intent-cerebras.php';
require __DIR__ . '/providers/intent-groq.php';

// Same chain order as resolve.php's PROVIDER_CHAIN. Each entry exposes the
// public attribution constant defined in its adapter file + the secret key
// name to test for presence + the model accessor that mirrors the trim+default
// logic from the intent function. Kept in resolve order so the client renders
// the same default sequence on a fresh page load.
$entries = [
    ['name' => 'gemini',     'key' => 'GEMINI_API_KEY',     'attribution' => GEMINI_ATTRIBUTION,     'model_fn' => 'gemini_model'],
    ['name' => 'openrouter', 'key' => 'OPENROUTER_API_KEY', 'attribution' => OPENROUTER_ATTRIBUTION, 'model_fn' => 'openrouter_model'],
    ['name' => 'cerebras',   'key' => 'CEREBRAS_API_KEY',   'attribution' => CEREBRAS_ATTRIBUTION,   'model_fn' => 'cerebras_model'],
    ['name' => 'groq',       'key' => 'GROQ_API_KEY',       'attribution' => GROQ_ATTRIBUTION,       'model_fn' => 'groq_model'],
];

$providers = [];
foreach ($entries as $e) {
    $configured = !empty(server_secret($e['key']));
    $providers[] = [
        'name'        => $e['name'],
        'configured'  => $configured,
        // Only emit `model` when a key is actually present — otherwise we'd
        // be advertising a default the user hasn't opted into. Mirrors the
        // attribution data (already public-only).
        'model'       => $configured ? $e['model_fn']() : null,
        'attribution' => $e['attribution'],
    ];
}

header('Cache-Control: no-store');
json_out(['tier2_providers' => $providers]);
