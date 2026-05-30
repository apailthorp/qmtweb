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

// Tier 2 (free LLM) with silent fallback to Tier 1 (deterministic). Both tiers
// now return a list of candidates: 1 for unambiguous queries, 2-3 for ambiguous
// ones like "WA" (state vs. country code) or "King County" (TX vs. WA).
$intent     = gemini_intent($q) ?? deterministic_intent($q);
$count      = max(1, min(10, (int) ($intent['count'] ?? NEAREST_DEFAULT)));
// Cap server-side regardless of what the LLM returned, so a malformed or
// malicious Gemini response can't trigger an unbounded fan-out of geocode +
// aviationweather.gov calls. Matches the documented 2-3 candidate contract.
$candidates = is_array($intent['candidates'] ?? null)
    ? array_slice($intent['candidates'], 0, 3)
    : [];

// Geocode each candidate, collect the nearest stations per location into a
// group. Silently drop candidates that don't geocode or have no reporters.
$groups = [];
foreach ($candidates as $candidate) {
    if (!is_array($candidate)) continue;
    $location = null;
    if (!empty($candidate['zip'])) $location = geocode_place((string) $candidate['zip']);
    // If the ZIP geocode returned nothing (or there was no ZIP), fall through
    // to the place name so the candidate still has a chance to resolve.
    if ($location === null && !empty($candidate['place'])) {
        $location = geocode_place((string) $candidate['place']);
    }
    if ($location === null) continue;
    $stations = nearest_metar_stations($location['lat'], $location['lon'], $count);
    if (!$stations) continue;
    $groups[] = [
        'interpreted' => 'Nearest METAR to ' . $location['label'],
        'stations'    => $stations,
    ];
}

if (!$groups) {
    json_err("Couldn't work out a location from \"$q\". Try a city or 5-digit ZIP.", 404);
}

header('Cache-Control: no-store');
json_out(['groups' => $groups]);

// --- Tier 1: deterministic intent ---------------------------------------------
// Strip filler, detect a 5-digit ZIP, else treat the remainder as a place name.
// The filler list covers natural-language phrasings like "Airforce base in
// Washington" or "San Juan Islands airfields" so Nominatim sees a clean place.
// \b boundaries prevent false matches inside place names (e.g. "field" doesn't
// match inside "Springfield"). Keep additions narrow: words that almost always
// describe an aviation facility category or are prepositions.
function deterministic_intent(string $q): array {
    if (preg_match('/\b(\d{5})\b/', $q, $m)) {
        return [
            'candidates' => [['zip' => $m[1], 'place' => '']],
            'count'      => NEAREST_DEFAULT,
        ];
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
    return [
        'candidates' => [['zip' => '', 'place' => $place !== '' ? $place : $q]],
        'count'      => NEAREST_DEFAULT,
    ];
}

// --- Tier 2: Gemini intent extraction (free tier) -----------------------------
// Returns null (→ Tier 1) when no key, error, or unparseable. NEVER returns a
// station — only the location to feed the grounded pipeline.
function gemini_intent(string $q): ?array {
    $key = server_secret('GEMINI_API_KEY');
    if (!$key) return null;

    $prompt = 'You extract LOCATION candidates from an aviation-weather query. '
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

    $payload = [
        'contents'         => [['parts' => [['text' => $prompt]]]],
        'generationConfig' => ['responseMimeType' => 'application/json', 'temperature' => 0],
    ];
    // Free-tier model. Google rotates which models are on the free tier (e.g.
    // gemini-2.0-flash had its free quota set to 0 in May 2026; gemini-2.5-flash
    // is the current free-tier default). Re-verify on key setup if Tier 2 stops
    // firing — a 429 with `limit: 0` here usually means the model has rotated.
    $url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

    // Pass the key in the x-goog-api-key header (Google's preferred method) rather
    // than a ?key= URL param, so it never lands in server/proxy access logs.
    $resp = http_post_json($url, $payload, ['x-goog-api-key: ' . $key]);
    $text = $resp['candidates'][0]['content']['parts'][0]['text'] ?? null;
    if (!$text) return null;

    $intent = json_decode($text, true);
    if (!is_array($intent)) return null;

    // Clean each candidate: keep only ones with a usable ZIP or place. Trim
    // whitespace and validate the ZIP format. Drop empties so the caller can
    // fall back to Tier-1 when Gemini returns nothing actionable.
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
