#!/usr/bin/env node
// Stamp the whole-site version into the deployable HTML.
//
// Replaces the __APP_VERSION__ token in site/index.html with a display string
// built from package.json's semver + the short git SHA, e.g. "v1.0.0 · a1b2c3d".
// Run by .github/workflows/deploy.yml right before the FTPS upload, so the
// committed source stays token-only and every deploy carries an accurate,
// unique version.
//
// Usage:
//   node scripts/stamp-version.mjs [path/to/index.html]
//
// The semver part bumps by hand in package.json (per release); the SHA part is
// automatic and changes every deploy, so the combined version is always unique.
//
// Full design + troubleshooting: docs/VERSIONING.md

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const TOKEN = "__APP_VERSION__";

// Pure helpers (unit-tested).
export function applyVersionToken(text, version) {
  return text.split(TOKEN).join(version);
}

export function buildVersion(pkgVersion, sha) {
  return `v${pkgVersion} · ${sha}`;
}

// Prefer the CI-provided commit SHA; fall back to git for local runs.
export function shortSha(env = process.env) {
  if (env.GITHUB_SHA) return env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "local";
  }
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..");
  const target = process.argv[2]
    ? resolve(process.cwd(), process.argv[2])
    : resolve(repoRoot, "site/index.html");

  const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
  const version = buildVersion(pkg.version, shortSha());

  const html = readFileSync(target, "utf8");
  if (!html.includes(TOKEN)) {
    console.warn(`stamp-version: no ${TOKEN} token in ${target}; nothing to stamp.`);
    return;
  }
  writeFileSync(target, applyVersionToken(html, version));
  console.log(`stamp-version: stamped "${version}" into ${target}`);
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
