// Whole-site version tag.
//
// Shows the deployed version (semver + short build SHA, e.g. "v1.0.0 · a1b2c3d")
// pinned to the bottom-left of the viewport, in very small text. Its home is the
// bottom of the page, resting just below the footer over empty margin. Because
// it's position:fixed, scrolling UP from the bottom makes it float over page
// content — a collision — so it hides while you're scrolled away from the
// bottom, and shows only when you're at the bottom (or the page is too short to
// scroll, in which case there's nothing to collide with).
//
// The version string is stamped into <html data-version="…"> at deploy time by
// scripts/stamp-version.mjs. In local dev the token is left intact, so we show
// "dev" instead. Cache freshness is handled by the server (site/.htaccess sends
// no-cache/must-revalidate on markup + code), so there's nothing to force here —
// we just surface and record the version.
//
// Full design + troubleshooting: docs/VERSIONING.md

const PLACEHOLDER = "__APP_VERSION__";
const SHA_PLACEHOLDER = "__APP_VERSION_SHA__";
const COMMIT_BASE = "https://github.com/apailthorp/qmtweb/commit/";
export const VERSION_STORE_KEY = "qmtweb.appVersion";

// Turn the raw stamped value into a display string. Unstamped (local dev) or
// empty falls back to "dev".
export function resolveVersion(raw) {
  const value = (raw ?? "").trim();
  if (!value || value.includes(PLACEHOLDER)) return "dev";
  return value;
}

// Build the commit-link URL for the deployed SHA, or null when the SHA isn't
// stamped (local dev / pre-stamp). Hex-only guard: stamp-version writes a 7-
// char hex SHA from git; anything else (e.g. the literal "local" fallback or
// an unsubstituted token) returns null so we don't render a broken link.
export function commitUrl(sha) {
  const value = (sha ?? "").trim();
  if (!value || value === SHA_PLACEHOLDER) return null;
  if (!/^[0-9a-f]{7,40}$/i.test(value)) return null;
  return COMMIT_BASE + value;
}

// Decide whether to hide the tag. The tag's home is the bottom of the page; it's
// position:fixed, so while you're scrolled UP from the bottom it floats over page
// content — a collision — and should hide. It shows only when you're at (or
// within `threshold` of) the bottom. A short, non-scrollable page has nothing to
// collide with, so the tag always shows. Position-agnostic: works at either edge.
export function shouldHide({ scrollHeight, viewportHeight, scrollY, threshold = 8 }) {
  const scrollable = scrollHeight > viewportHeight + threshold;
  if (!scrollable) return false; // nothing to scroll over → never a collision
  const atBottom = scrollY + viewportHeight >= scrollHeight - threshold;
  return !atBottom; // hide while scrolled up (floating over content)
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
  const href = version === "dev" ? null : commitUrl(el.dataset.sha);
  if (href) {
    // Wrap the whole stamp in an anchor pointing at the deployed commit so a
    // click jumps to the exact source on GitHub. `.app-version` itself is
    // pointer-events:none (so it never intercepts page clicks); the inner
    // anchor re-enables hits via CSS (.app-version a { pointer-events: auto }).
    el.textContent = "";
    const a = doc.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = version;
    a.className = "app-version-link";
    el.append(a);
  } else {
    el.textContent = version;
  }
  // Expose for quick support ("what version are you on?") / debugging.
  globalThis.__APP_VERSION__ = version;

  // Detect a cross-session version change (a new deploy/release). Assets are
  // already fresh via server revalidation, so we only need to record it.
  if (version !== "dev") recordVersion(version, safeLocalStorage());

  const update = () => {
    const root = doc.documentElement;
    // Toggle opacity (not display) so the tag keeps its layout box — hiding via
    // display would zero its rect and could fight future measurements.
    el.classList.toggle(
      "is-hidden",
      shouldHide({
        scrollHeight: root.scrollHeight,
        viewportHeight: window.innerHeight,
        scrollY: window.scrollY,
      }),
    );
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
  // `load` also covers the browser restoring a saved scroll position after a
  // reload, which can happen after this module's initial pass.
  window.addEventListener("load", schedule);

  // The document can grow/shrink without a scroll or resize event — e.g. the
  // manage panel expanding/collapsing or search results appearing. That changes
  // scrollHeight (and whether we're "at the bottom"), so recompute on it too.
  if (typeof ResizeObserver !== "undefined" && doc.body) {
    new ResizeObserver(schedule).observe(doc.body);
  }

  schedule(); // initial pass once layout has settled
}
