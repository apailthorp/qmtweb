<?php
// Shared helpers for the qmtweb PHP proxy endpoints (AccuWeb LiteSpeed, PHP 8).
// These are read-only proxies of PUBLIC data; any API keys come from the server
// environment, never the client. Same-origin only (no CORS header) — the site
// fetches its own /api/*.php.
//
// NB: PHP can't run under `http-server` or in CI, so these are exercised by
// deploying + curl (see docs / NEXT_SESSION). Keep the logic thin.

declare(strict_types=1);

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
    curl_close($ch);
    if ($body === false || $code < 200 || $code >= 300) return null;
    $data = json_decode((string) $body, true);
    return is_array($data) ? $data : null;
}

// POST JSON over HTTPS (used for the LLM call). Returns decoded array or null.
function http_post_json(string $url, array $payload, array $headers = [], int $timeout = HTTP_TIMEOUT): ?array {
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
    curl_close($ch);
    if ($body === false || $code < 200 || $code >= 300) return null;
    $data = json_decode((string) $body, true);
    return is_array($data) ? $data : null;
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
