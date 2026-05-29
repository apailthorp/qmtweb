# qmtweb

Quick METAR & TAF (QMT): a browser front end to the NWS Aviation Weather
Center ([aviationweather.gov](https://aviationweather.gov)) that persists your
chosen station list.

Select ICAO stations once — search, reorder, and size the list from 1 to 20
fields. The list, its order, and the query options (decode, tabular, hours) are
stored in the browser (localStorage) and persist across visits. Submitting
forwards the stations to aviationweather.gov's METAR/TAF view, which
serves the METAR/TAF data.

The page also carries fixed weather links: NWS forecast products (Graphical
Forecast for Aviation, Seattle Area Forecast Discussion) and the KING 5
regional radar/satellite animations.

Source for [pailthorp.net](https://pailthorp.net), a demo/testing project for
persistence behavior and a test/CI/deploy pipeline.

## Layout

```text
.
├── site/                       # Deployed as-is (the document root)
│   ├── index.html
│   ├── styles.css
│   ├── .htaccess               # Cache policy (revalidate markup + code)
│   └── js/
│       ├── metar.js            # Pure helpers (unit-tested)
│       ├── version.js          # Version tag + collision-hide
│       └── main.js             # DOM glue
├── tests/
│   ├── unit/                   # Vitest
│   └── e2e/                    # Playwright (Chromium)
├── docs/                       # VERSIONING.md (versioning + cache strategy)
├── infra/                      # Terraform (GitHub repo + Actions secrets)
├── scripts/                    # Docker wrappers (terraform/tflint/validate-tf) + stamp-version.mjs
├── .github/workflows/          # ci.yml, deploy.yml
├── .terraform-version          # Pinned for the Docker wrappers
└── .tflint.hcl
```

## Local development

```sh
npm install
npm run dev               # serve site/ at http://127.0.0.1:8080
```

## Updating the airport search dataset

The in-page search box is backed by `site/data/airports.json` — a trimmed slice of [OurAirports](https://ourairports.com/data/). Regenerate it with:

```sh
node scripts/build-airport-data.mjs
```

This downloads the latest CSV (~12 MB) and writes a ~1 MB JSON (large/medium airports worldwide + small US/Canada). The output is committed; the site lazy-loads it the first time the user types into the search box.

### Why not a live external API for search?

The bundle was chosen over a live API (AviationStack, aviationweather.gov station info, etc.) because of constraints stacked against browser-side calls from a static HTTPS site:

- **aviationweather.gov** returns clean JSON but sends no `Access-Control-Allow-Origin` header — browsers block JS from reading it.
- **AviationStack** free tier is HTTP-only and requires an API key — HTTPS pages can't make mixed-content requests, and a key embedded in client JS is exposed to anyone viewing source.
- Most other aviation data APIs are paid, registration-walled, or CORS-restricted.

The realistic way to add hybrid live search later is a small **server-side proxy** (AccuWeb runs PHP, so a `site/api/*.php` shim is the path of least resistance), with keys living in the PHP file (server-side) and a pluggable provider interface in [site/js/search.js](site/js/search.js).

## Tests

```sh
npm test                          # Vitest unit tests
npm run test:e2e:install          # one-time: install Playwright browsers
npm run test:e2e                  # Playwright e2e (boots http-server itself)
npm run lint                      # ESLint on site/js + tests
```

## Terraform (Docker-wrapped)

Terraform never runs directly on your machine — every invocation goes through `scripts/terraform.sh`, which pins the version via `.terraform-version` and runs `hashicorp/terraform` in Docker.

Validate without touching real GitHub (no token needed):

```sh
npm run tf:validate       # fmt -check, init -backend=false, validate, tflint
```

Plan / apply (needs `GITHUB_TOKEN` and `terraform.tfvars` — see [`infra/README.md`](infra/README.md)):

```sh
cp infra/terraform.tfvars.example infra/terraform.tfvars
$EDITOR infra/terraform.tfvars
export GITHUB_TOKEN=ghp_...

./scripts/terraform.sh init
./scripts/terraform.sh plan
./scripts/terraform.sh apply
```

What Terraform manages:

- The `qmtweb` GitHub repository (settings, merge rules, branch protection)
- GitHub Actions secrets used by the deploy workflow

What Terraform does **not** manage (no provider exists):

- AccuWeb Hosting (the LiteSpeed server + cPanel)
- DNS for `pailthorp.net` (currently on AccuWeb's own nameservers)

## Branching model

```text
feature/* ──PR──▶ development ──PR──▶ main ──▶ FTPS deploy to AccuWeb
```

- `development` is the **default branch** (new clones and PR targets land there).
- Feature work lives on `feature/*` (or `fix/*`) and merges into `development` via PR — **squash merge** (one tidy commit per feature).
- `development → main` is the **promotion** PR — merging it triggers the production deploy. **Merge it with a "Create a merge commit", not squash.** Squashing the promotion gives `main` and `development` divergent histories (sharing only the root), which makes every later promotion PR diff the whole tree; a merge commit keeps them in lockstep so promotion PRs only show the new commits.
- Both `main` and `development` are PR-gated with required status checks via Terraform-managed branch protection.

## CI / deploy

| Workflow | Trigger | Does |
|---|---|---|
| `.github/workflows/ci.yml` | every PR + push to `main` or `development` | lint, Vitest, Playwright, `validate-tf.sh` |
| `.github/workflows/deploy.yml` | push to `main` (and manual dispatch) | runs the same checks, then FTPS-uploads `site/` to AccuWeb |

The deploy uses these repo secrets (managed by Terraform in `infra/`):

- `FTP_HOST` (e.g. `ftp.pailthorp.net`)
- `FTP_USERNAME` (e.g. `deploy@pailthorp.net`)
- `FTP_PASSWORD`
- `FTP_REMOTE_DIR` (usually `./` — the deploy FTP account is rooted at `public_html`)

Deploy is **FTPS** (explicit TLS on port 21) via `SamKirkland/FTP-Deploy-Action`; AccuWeb shared hosting doesn't expose SSH, so a scoped cPanel FTP account is used instead.

To bootstrap once: create the FTP account in cPanel → FTP Accounts (rooted at `public_html`), fill `infra/terraform.tfvars`, then run Terraform — that publishes the four secrets to the repo and the next push to `main` will deploy.

## Versioning & releases

> **Full design, extension points, and troubleshooting:**
> [`docs/VERSIONING.md`](docs/VERSIONING.md). The summary below is the
> quickstart.

The site carries a single whole-site version, shown in tiny text pinned to the
bottom-left of the viewport. It rests at the bottom of the page and auto-hides
while you're scrolled up, so the fixed tag never floats over content. It
combines the **semver** from `package.json` with the **short commit SHA** —
e.g. `v1.0.0 · a1b2c3d`:

- The **semver** is the human release number — bump it by hand in
  `package.json` when you cut a release.
- The **SHA** is stamped automatically at deploy by
  [`scripts/stamp-version.mjs`](scripts/stamp-version.mjs), which replaces the
  `__APP_VERSION__` token in `index.html` just before the FTPS upload. Source
  stays token-only; run locally the tag reads `dev`.

### How a deploy actually reaches returning visitors

AccuWeb's LiteSpeed otherwise caches static assets for 7 days *without*
revalidating, which hides a deploy from returning visitors for up to a week.
[`site/.htaccess`](site/.htaccess) overrides that: HTML, CSS, and JS are served
`no-cache, must-revalidate`, so each is revalidated on every load — cheap `304`s
via `Last-Modified` when unchanged, a fresh `200` when changed. That
revalidation is what busts the whole unbundled ES-module graph (deep imports
included) on each deploy; the version string is the human/traceable marker, not
the cache key. `js/version.js` also records the version in `localStorage` to
detect a change across sessions.

### Cutting a release

1. Bump `version` in `package.json` (e.g. `1.0.0` → `1.1.0`).
2. Merge through `development` → `main` as usual (squash features, merge-commit
   the promotion).
3. On the push to `main`, `deploy.yml` deploys, then creates a git tag
   `v<version>` and a GitHub Release with auto-generated notes — but only when
   that tag doesn't already exist, so deploys without a bump don't spam
   releases.
