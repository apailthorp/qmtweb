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

$q = trim($_GET['q'] ?? '');
if ($q === '') json_err('Type a place, ZIP, or airport to search online.', 422);

// Tier 2 (free LLM) with silent fallback to Tier 1 (deterministic).
$intent = gemini_intent($q) ?? deterministic_intent($q);

$location = null;
if (!empty($intent['zip']))        $location = geocode_place($intent['zip']);
elseif (!empty($intent['place']))  $location = geocode_place($intent['place']);

if ($location === null) {
    json_err("Couldn't work out a location from \"$q\". Try a city or 5-digit ZIP.", 404);
}

$count = max(1, min(10, (int) ($intent['count'] ?? NEAREST_DEFAULT)));
$stations = nearest_metar_stations($location['lat'], $location['lon'], $count);
if (!$stations) {
    json_err('No reporting stations found near ' . $location['label'] . '.', 404);
}

header('Cache-Control: no-store');
json_out([
    'interpreted' => 'Nearest METAR to ' . $location['label'],
    'stations'    => $stations,
]);

// --- Tier 1: deterministic intent ---------------------------------------------
// Strip filler, detect a 5-digit ZIP, else treat the remainder as a place name.
// The filler list covers natural-language phrasings like "Airforce base in
// Washington" or "San Juan Islands airfields" so Nominatim sees a clean place.
// \b boundaries prevent false matches inside place names (e.g. "field" doesn't
// match inside "Springfield"). Keep additions narrow: words that almost always
// describe an aviation facility category or are prepositions.
function deterministic_intent(string $q): array {
    if (preg_match('/\b(\d{5})\b/', $q, $m)) {
        return ['zip' => $m[1], 'count' => NEAREST_DEFAULT];
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
    return ['place' => $place !== '' ? $place : $q, 'count' => NEAREST_DEFAULT];
}

// --- Tier 2: Gemini intent extraction (free tier) -----------------------------
// Returns null (→ Tier 1) when no key, error, or unparseable. NEVER returns a
// station — only the location to feed the grounded pipeline.
function gemini_intent(string $q): ?array {
    $key = server_secret('GEMINI_API_KEY');
    if (!$key) return null;

    $prompt = 'You extract the LOCATION a weather query is about. Return ONLY JSON '
        . 'matching {"zip": string, "place": string, "count": integer}. "zip" is a '
        . '5-digit US ZIP or "". "place" is a city/place name or "". "count" is how '
        . 'many nearby stations were requested (default 6). Do NOT name any airport '
        . 'or station. Query: ' . $q;

    $payload = [
        'contents'         => [['parts' => [['text' => $prompt]]]],
        'generationConfig' => ['responseMimeType' => 'application/json', 'temperature' => 0],
    ];
    // Model is configurable; verify the current free-tier model when wiring the key.
    $url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

    // Pass the key in the x-goog-api-key header (Google's preferred method) rather
    // than a ?key= URL param, so it never lands in server/proxy access logs.
    $resp = http_post_json($url, $payload, ['x-goog-api-key: ' . $key]);
    $text = $resp['candidates'][0]['content']['parts'][0]['text'] ?? null;
    if (!$text) return null;

    $intent = json_decode($text, true);
    if (!is_array($intent)) return null;

    $zip = (string) ($intent['zip'] ?? '');
    $zip = preg_match('/^\d{5}$/', $zip) ? $zip : null;
    $place = !empty($intent['place']) ? (string) $intent['place'] : null;
    // Nothing usable extracted → return null so the caller falls back to the
    // Tier-1 deterministic parser instead of dead-ending on an empty intent.
    if ($zip === null && $place === null) return null;
    return [
        'zip'   => $zip,
        'place' => $place,
        'count' => (int) ($intent['count'] ?? NEAREST_DEFAULT),
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
