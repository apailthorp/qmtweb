// Seed list for the user-editable ICAO list — the 12 Pacific Northwest
// airports the page ships with. Users can add/remove from this set; the
// "Restore defaults" button reverts to exactly this list.

export const SEED_AIRPORTS = Object.freeze([
  { icao: "KPAE", name: "Paine Field — Everett" },
  { icao: "KBFI", name: "Boeing Field — Seattle" },
  { icao: "KRNT", name: "Renton Municipal" },
  { icao: "KPWT", name: "Bremerton National" },
  { icao: "KOLM", name: "Olympia Regional" },
  { icao: "KHQM", name: "Bowerman — Hoquiam" },
  { icao: "KSEA", name: "Seattle–Tacoma Intl" },
  { icao: "KTIW", name: "Tacoma Narrows" },
  { icao: "KBLI", name: "Bellingham Intl" },
  { icao: "KAWO", name: "Arlington Municipal" },
  { icao: "KORS", name: "Eastsound — Orcas Island" },
  { icao: "KFHR", name: "Friday Harbor" },
]);

export const DEFAULT_SEED = Object.freeze(SEED_AIRPORTS.map((a) => a.icao));

export const DEFAULT_SELECTED = Object.freeze(
  SEED_AIRPORTS.slice(0, 6).map((a) => a.icao),
);

const SEED_BY_ICAO = new Map(SEED_AIRPORTS.map((a) => [a.icao, a]));

export function seedAirport(icao) {
  return SEED_BY_ICAO.get(icao) ?? null;
}
