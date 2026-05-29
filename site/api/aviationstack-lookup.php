<?php
// AviationStack lookup — DISABLED STUB.
//
// AviationStack's free tier is HTTP-only and key-walled, so it's not wired up.
// This stub returns 503 until AVIATIONSTACK_KEY is set server-side and the
// proxy logic is implemented. Kept so the endpoint exists for a future wire-up.

declare(strict_types=1);
require __DIR__ . '/_lib.php';

$key = getenv('AVIATIONSTACK_KEY') ?: ($_SERVER['AVIATIONSTACK_KEY'] ?? null);
if (!$key) {
    json_err('AviationStack lookup is not configured.', 503);
}

// TODO: when a key is configured, proxy the AviationStack airport endpoint here
// and normalize to { icao, iata, name, city }. Until then we report unavailable.
json_err('AviationStack lookup is not implemented yet.', 501);
