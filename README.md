# qmtweb

Quick METAR and TAF plus weather links — the source for [pailthorp.net](https://pailthorp.net).

A deliberately simple static site (modeled on the existing pailthorp.net page) with a clean test and deploy pipeline, so it can be re-architected later without throwing the surrounding scaffolding away.

## Layout

```
.
├── site/                       # Deployed as-is (the document root)
│   ├── index.html
│   ├── styles.css
│   └── js/
│       ├── metar.js            # Pure helpers (unit-tested)
│       └── main.js             # DOM glue
├── tests/
│   ├── unit/                   # Vitest
│   └── e2e/                    # Playwright (Chromium)
├── infra/                      # Terraform (GitHub repo + Actions secrets)
├── scripts/                    # Docker wrappers — terraform / tflint / validate-tf
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

```
feature/* ──PR──▶ development ──PR──▶ main ──▶ FTPS deploy to AccuWeb
```

- `development` is the **default branch** (new clones and PR targets land there).
- Feature work lives on `feature/*` or similar and merges into `development` via PR.
- `development → main` is the **promotion** PR — merging it triggers the production deploy.
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
