// Whole-site version tag.
//
// Shows the deployed version (semver + short build SHA, e.g. "v1.0.0 · a1b2c3d")
// pinned to the bottom-right of the viewport, in very small text. It hides
// itself whenever it would overlap the footer, so it never sits on top of real
// content.
//
// The version string is stamped into <html data-version="…"> at deploy time by
// scripts/stamp-version.mjs. In local dev the token is left intact, so we show
// "dev" instead. Cache freshness is handled by the server (site/.htaccess sends
// no-cache/must-revalidate on markup + code), so there's nothing to force here —
// we just surface and record the version.

const PLACEHOLDER = "__APP_VERSION__";
export const VERSION_STORE_KEY = "qmtweb.appVersion";

// Turn the raw stamped value into a display string. Unstamped (local dev) or
// empty falls back to "dev".
export function resolveVersion(raw) {
  const value = (raw ?? "").trim();
  if (!value || value.includes(PLACEHOLDER)) return "dev";
  return value;
}

// Axis-aligned overlap test for two DOMRect-like objects.
export function rectsOverlap(a, b) {
  return !(
    a.right <= b.left ||
    a.left >= b.right ||
    a.bottom <= b.top ||
    a.top >= b.bottom
  );
}

// Record the version seen this load and report whether it changed since a
// prior session. Always stores the current value. Safe when storage is
// unavailable (returns false, never throws).
export function recordVersion(version, storage) {
  if (!storage) return false;
  try {
    const prev = storage.getItem(VERSION_STORE_KEY);
    storage.setItem(VERSION_STORE_KEY, version);
    return prev !== null && prev !== version;
  } catch {
    return false;
  }
}

function safeLocalStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Access can throw in sandboxed/blocked contexts.
    return null;
  }
}

export function initVersionTag(doc = document) {
  const el = doc.getElementById("app-version");
  if (!el) return;

  const version = resolveVersion(doc.documentElement.dataset.version);
  el.textContent = version;
  // Expose for quick support ("what version are you on?") / debugging.
  globalThis.__APP_VERSION__ = version;

  // Detect a cross-session version change (a new deploy/release). Assets are
  // already fresh via server revalidation, so we only need to record it.
  if (version !== "dev") recordVersion(version, safeLocalStorage());

  const obstacle = doc.querySelector("footer") ?? doc.querySelector("main");

  const update = () => {
    if (!obstacle) return;
    const tag = el.getBoundingClientRect();
    const rect = obstacle.getBoundingClientRect();
    // Toggle opacity (not display) so the tag keeps its layout box and its
    // rect stays measurable — otherwise hiding would zero the rect and we'd
    // immediately re-show, causing a flicker loop.
    el.classList.toggle("is-hidden", rectsOverlap(tag, rect));
  };

  let ticking = false;
  const schedule = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      update();
      ticking = false;
    });
  };

  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  schedule(); // initial pass once layout has settled
}
