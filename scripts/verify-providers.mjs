#!/usr/bin/env node
// Verify that each Tier-2 provider's documented default model still exists on
// its /v1/models (or equivalent) endpoint. Catches the case where a provider
// rotates their free roster — which has bitten this codebase before (Cerebras
// dropped llama3.1-8b for gpt-oss-120b mid-v1.4 development; the running
// default 404'd until we caught it via a curl on the live API).
//
// Usage:
//   node scripts/verify-providers.mjs
//   QMTWEB_SECRETS=/path/to/qmtweb-secrets.php node scripts/verify-providers.mjs
//
// Reads API keys from qmtweb-secrets.php at the repo root (via PHP). Providers
// without a key are skipped. Exits non-zero if any provider's default model
// is missing from its model list, with the available IDs printed for context
// so updating the default is a one-line edit.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const secretsFile = process.env.QMTWEB_SECRETS || resolve(repoRoot, "qmtweb-secrets.php");

function readSecrets(file) {
  // Use PHP itself to evaluate the secrets file (it's a `return [...]` form)
  // rather than parsing PHP from Node — keeps the script tolerant of comments,
  // string escapes, etc.
  try {
    const out = execFileSync(
      "php",
      ["-r", `echo json_encode(require ${JSON.stringify(file)});`],
      { encoding: "utf8" },
    );
    return JSON.parse(out);
  } catch (e) {
    console.error(`Cannot read secrets from ${file}: ${e.message}`);
    process.exit(1);
  }
}

const providers = [
  {
    name: "Gemini",
    keyName: "GEMINI_API_KEY",
    defaultModel: "gemini-2.5-flash",
    url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
    headers: (key) => ({ "x-goog-api-key": key }),
    // Gemini's response shape: { models: [{ name: "models/gemini-...", ... }] }
    extractIds: (data) =>
      (data?.models ?? []).map((m) =>
        typeof m.name === "string" ? m.name.replace(/^models\//, "") : null,
      ).filter(Boolean),
  },
  {
    name: "OpenRouter",
    keyName: "OPENROUTER_API_KEY",
    defaultModel: "meta-llama/llama-3.2-3b-instruct:free",
    url: "https://openrouter.ai/api/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    extractIds: (data) => (data?.data ?? []).map((m) => m.id).filter(Boolean),
  },
  {
    name: "Cerebras",
    keyName: "CEREBRAS_API_KEY",
    defaultModel: "gpt-oss-120b",
    url: "https://api.cerebras.ai/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    extractIds: (data) => (data?.data ?? []).map((m) => m.id).filter(Boolean),
  },
  {
    name: "Groq",
    keyName: "GROQ_API_KEY",
    defaultModel: "llama-3.1-8b-instant",
    url: "https://api.groq.com/openai/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    extractIds: (data) => (data?.data ?? []).map((m) => m.id).filter(Boolean),
  },
];

const secrets = readSecrets(secretsFile);
let drift = 0;

console.log(`Tier-2 provider model verification — ${new Date().toISOString()}`);
console.log("");

for (const p of providers) {
  const key = secrets[p.keyName];
  const label = p.name.padEnd(11);
  if (!key) {
    console.log(`  ${label} (no ${p.keyName} — skipping)`);
    continue;
  }
  try {
    const res = await fetch(p.url, { headers: p.headers(key) });
    if (!res.ok) {
      console.log(`  ${label} HTTP ${res.status} — couldn't list models`);
      drift++;
      continue;
    }
    const data = await res.json();
    const ids = p.extractIds(data);
    const found = ids.includes(p.defaultModel);
    const status = found ? "OK" : "MISSING ✗";
    console.log(`  ${label} default=${p.defaultModel.padEnd(48)} ${status}`);
    if (!found) {
      drift++;
      const sample = ids.slice(0, 8).join(", ");
      console.log(`    available (first 8): ${sample}${ids.length > 8 ? `, … (+${ids.length - 8})` : ""}`);
    }
  } catch (e) {
    console.log(`  ${label} ERROR: ${e.message}`);
    drift++;
  }
}

if (drift > 0) {
  console.error(`\n✗ ${drift} provider(s) drifted from documented defaults — update README + adapter default in the matching providers/intent-*.php.`);
  process.exit(1);
}
console.log("\nAll configured providers' defaults are present.");
