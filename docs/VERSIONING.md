# Versioning & cache strategy

How the site stamps a single version, surfaces it, and makes sure a deploy
actually reaches returning visitors. This is the canonical reference; the
README has the short version.

## TL;DR

- The whole site has **one** version string: `v<semver> · <shortSHA>`
  (e.g. `v1.0.0 · a1b2c3d`), shown in tiny text at the bottom-left of every
  page.
- **You** bump the `semver` in `package.json` per release. The **short SHA** is
  added automatically at deploy.
- Asset freshness is **not** done with `?v=` query strings — it's done by
  serving markup + code with `no-cache, must-revalidate` (see
  [Cache strategy](#cache-strategy-the-important-part)). The version string is a
  human/traceable marker, not the cache key.
- To cut a release: bump `package.json`, merge through `development → main`, and
  the deploy stamps the build, tags it, and publishes a GitHub Release.

## The moving parts

| File | Responsibility |
|---|---|
| `package.json` → `version` | Semver source of truth (bumped by hand per release). |
| `scripts/stamp-version.mjs` | At deploy, replaces the `__APP_VERSION__` token in `index.html` with `v<semver> · <shortSHA>`. Exposes pure helpers (`buildVersion`, `applyVersionToken`, `shortSha`) for tests. |
| `site/index.html` | Carries the `__APP_VERSION__` token in three places: `<html data-version>`, `<meta name="app-version">`, and `<div id="app-version">`. |
| `site/js/version.js` | Reads the stamped version, renders the tag, hides it while you're scrolled up (when the fixed tag would float over content) and shows it at the bottom, and records it in `localStorage` to detect cross-session changes. Pure helpers are unit-tested. |
| `site/styles.css` → `.app-version` | Styles the fixed bottom-right tag; `.is-hidden` fades it out. |
| `site/.htaccess` | Cache policy — the **actual** freshness mechanism (revalidation). |
| `.github/workflows/deploy.yml` | Runs the stamp step before upload, then cuts the git tag + GitHub Release. |
| `tests/unit/version.test.js` | Unit tests for the version + stamp helpers. |

## How the version is built

`scripts/stamp-version.mjs`:

1. Reads `version` from `package.json` (the semver).
2. Gets the short SHA: `GITHUB_SHA` in CI (sliced to 7 chars), else
   `git rev-parse --short HEAD`, else the literal `local`.
3. Composes `buildVersion(semver, sha)` → `` `v${semver} · ${sha}` ``.

The SHA changes every commit/deploy, so the combined version is unique per
deploy even when the semver hasn't been bumped.

## How it gets onto the page

The committed source keeps the token `__APP_VERSION__` in three spots so the
repo never holds a stale version. At deploy, `stamp-version.mjs` replaces every
occurrence (`applyVersionToken` is a plain string replace of all instances).

Locally (and in CI, which runs before the stamp step) the token is **not**
replaced. `resolveVersion()` in `version.js` maps the untouched token — or an
empty/missing value — to the string `dev`, so local pages show `dev` instead of
a raw placeholder.

## Cache strategy (the important part)

**Problem.** AccuWeb's LiteSpeed serves static assets with
`Cache-Control: public, max-age=604800` (7 days) and no revalidation. A returning
visitor keeps the cached CSS/JS for up to a week, so a deploy is invisible to
them — this is exactly the "private tab shows the new layout, normal tab
doesn't" symptom.

**Solution.** `site/.htaccess` overrides the header for markup + code:

```apache
Header always set Cache-Control "no-cache, must-revalidate"
```

`no-cache` means "you may store it, but revalidate before every use." Because the
server already sends `Last-Modified`, revalidation is cheap: unchanged files
return `304 Not Modified` (no body), changed files return a fresh `200`.

**Why revalidation and not versioned `?v=` URLs.** This site uses **unbundled
ES modules** (`main.js` imports `storage.js`, `search.js`, …). A `?v=` on the
`<script>` tag would bust `main.js` but *not* its imports — the browser would
still fetch `./storage.js` (no query) from the 7-day cache. Truly versioning the
graph would require either rewriting every relative import specifier at deploy
(fragile) or adding a bundler (against the project's no-build-step principle).
Revalidation makes the **entire graph** fresh — deep imports included — with zero
per-import surgery. So the version string stays a human-facing marker; the cache
is keyed on `Last-Modified`, not the version.

> **First-deploy check:** confirm LiteSpeed honored the `.htaccess`:
> ```sh
> curl -sI https://pailthorp.net/styles.css | grep -i cache-control
> # expect: cache-control: no-cache, must-revalidate
> ```
> If it still shows `max-age=604800`, see [Troubleshooting](#troubleshooting).

## Cross-session detection

`recordVersion(version, storage)` stores the current version under
`localStorage["qmtweb.appVersion"]` and returns `true` when it differs from the
value stored on a prior visit. It's safe when storage is blocked (private mode):
it catches and returns `false`.

Today this is detection-only — there is **no forced reload**, because once the
assets revalidate the page is already fresh, so a reload would be a no-op. If you
ever want an explicit "a new version is live" affordance, wire it off the return
value, e.g. show a small toast or banner:

```js
const changed = recordVersion(version, localStorage);
if (changed) showUpdatedBanner(version); // your UI
```

(Avoid `location.reload()` as the action — modern browsers ignore the old
force-GET flag, so it won't bust the cache; revalidation already handles that.)

## Cutting a release

1. Bump `version` in `package.json` (e.g. `1.0.0` → `1.1.0`). Follow semver:
   patch for fixes, minor for features, major for breaking UX changes.
2. Open a feature PR into `development` (squash merge).
3. Promote `development → main` with a **merge commit** (see the branching model
   in the README — squashing the promotion diverges the histories).
4. The push to `main` runs `deploy.yml`, which:
   - stamps `v<semver> · <sha>` into `index.html`,
   - FTPS-uploads `site/` to AccuWeb,
   - creates git tag `v<semver>` + a GitHub Release with auto-generated notes —
     **only if that tag doesn't already exist**, so deploys without a bump don't
     create duplicate releases.

## Verifying a deploy

```sh
# Cache header is revalidating:
curl -sI https://pailthorp.net/styles.css | grep -i cache-control

# The stamped version is on the page:
curl -s https://pailthorp.net/ | grep -o 'data-version="[^"]*"'

# The release/tag exists:
gh release list --repo apailthorp/qmtweb
```

On the page itself, the version tag is bottom-left; it rests at the bottom and
disappears while you're scrolled up (so the fixed tag never floats over content).

## Troubleshooting

- **`cache-control` still shows `max-age=604800` after deploy.** LiteSpeed may
  not have `mod_headers` active, or a higher-level config wins. Options, in
  order: (a) confirm `.htaccess` actually uploaded (it's intentionally *not* in
  the deploy `exclude` list); (b) in cPanel, check for a global "Cache" / Expires
  setting overriding it; (c) try a LiteSpeed-native rule
  (`<IfModule LiteSpeed> ... </IfModule>` / `RewriteEngine` cache headers) or set
  the header via cPanel's "MIME Types"/"Optimize Website"; (d) as a last resort,
  fall back to `?v=` versioned URLs + import rewriting (a bundler) — but that's a
  bigger change.
- **Tag shows the literal `__APP_VERSION__`.** The stamp step didn't run (e.g.
  deploying outside `deploy.yml`). Run `node scripts/stamp-version.mjs` against
  the file being shipped. Locally this is expected to read `dev`.
- **Tag never hides / hides too eagerly.** `version.js` shows the tag only at
  (or within `threshold` of) the bottom of a scrollable page and hides it while
  scrolled up, where the fixed tag would otherwise float over content
  (`shouldHide`, on scroll/resize/load). Tune the `threshold` (px) if needed;
  it's unit-tested. (An earlier rect-overlap-with-footer check never fired,
  because the tag sits in `main`'s bottom padding, below the footer.)
- **No Release was created on deploy.** The tag already existed (no semver bump),
  or the workflow lacks `contents: write`. Both are in `deploy.yml`.

## Testing

- **Unit** (`tests/unit/version.test.js`): `resolveVersion` (placeholder → `dev`),
  `shouldHide` (show-at-bottom / hide-while-scrolled-up logic), `recordVersion`
  (cross-session + storage failure), and the stamp helpers `buildVersion` /
  `applyVersionToken` / `shortSha`.
- **E2E** (`tests/e2e/home.spec.js`): the tag renders with the expected text and
  is `position: fixed`. (E2E runs against unstamped source, so the tag reads
  `dev`.)
