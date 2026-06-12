<?php
// Geocode helper endpoint: ?q=<5-digit ZIP | place name> → { lat, lon, label }.
// Used by resolve.php internally; exposed standalone for testing/reuse.
// ZIP via api.zippopotam.us, place via Nominatim (OSM — attribute in the UI).

declare(strict_types=1);
require __DIR__ . '/_lib.php';

// Same guard order as resolve.php: origin gate → rate limit → validation.
// Standalone abuse of this endpoint hits Nominatim from the host's shared
// egress IP, so it gets the same per-IP budget.
enforce_same_origin_fetch();
rate_limit_or_429('geocode', 30, 60);

$q = trim($_GET['q'] ?? '');
if ($q === '') json_err('Missing q (a ZIP or place name).', 422);
if (strlen($q) > MAX_QUERY_LEN) json_err('Query too long (max ' . MAX_QUERY_LEN . ' characters).', 422);

$result = geocode_place($q);
if ($result === null) json_err("Couldn't locate \"$q\".", 404);

header('Cache-Control: public, max-age=86400');
json_out($result);
