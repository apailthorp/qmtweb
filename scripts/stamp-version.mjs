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
const SHA_TOKEN = "__APP_VERSION_SHA__";

// Pure helpers (unit-tested).
export function applyVersionToken(text, version) {
  return text.split(TOKEN).join(version);
}

// Stamp the short SHA into a separate token so the client can hyperlink the
// version tag to the deployed commit without re-parsing the display string.
// Empty in local dev (no GITHUB_SHA, no git available) — version.js then
// renders the tag as plain text.
export function applyShaToken(text, sha) {
  return text.split(SHA_TOKEN).join(sha);
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
  const sha = shortSha();
  const version = buildVersion(pkg.version, sha);

  const html = readFileSync(target, "utf8");
  if (!html.includes(TOKEN)) {
    console.warn(`stamp-version: no ${TOKEN} token in ${target}; nothing to stamp.`);
    return;
  }
  // Stamp the SHA token first, then the version token. Order doesn't actually
  // matter here — the two tokens share a 13-char prefix (`__APP_VERSION_`) but
  // diverge at the next char, so neither is a substring of the other, and the
  // replacements (a short SHA / a "vX.Y.Z · sha" string) contain no token
  // substrings either. We pick SHA-first as the obvious read order.
  let next = applyShaToken(html, sha);
  next = applyVersionToken(next, version);
  writeFileSync(target, next);
  console.log(`stamp-version: stamped "${version}" into ${target}`);
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
