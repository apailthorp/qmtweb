#!/usr/bin/env node
// Summarise qmtweb-stats.jsonl (the per-resolve.php log written above docroot
// on the production host). Designed to be run against a locally-downloaded
// copy of the file — no network, no UI, stdout only. Lets you actually use
// the stats we've been logging.
//
// Usage:
//   node scripts/stats-summary.mjs <path-to-qmtweb-stats.jsonl>
//
// Stats reported: total records, time range, unique-query count, Tier-2
// usage rate, provider distribution, status breakdown, 429 frequency per
// provider, cache hit rate, latency percentiles.

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("Usage: node scripts/stats-summary.mjs <path-to-qmtweb-stats.jsonl>");
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(path, "utf8");
} catch (e) {
  console.error(`Cannot read ${path}: ${e.message}`);
  process.exit(1);
}

const records = raw
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && typeof r === "object");

if (!records.length) {
  console.error("No valid JSON lines found.");
  process.exit(1);
}

const total = records.length;
const tsFirst = records[0]?.ts ?? "(unknown)";
const tsLast  = records[total - 1]?.ts ?? "(unknown)";

// Helper for percentage formatting.
const pct = (n, d) => (d > 0 ? `${(100 * n / d).toFixed(1)}%` : "n/a");

// Unique queries (q_hash is sha1[:8] of the lowercased query).
const uniqHashes = new Set(records.map((r) => r.q_hash).filter(Boolean));

// Tier-2 usage. Records where tier2_used is set went through a provider
// (live or cache-hit); the rest were served by Tier-1 alone.
const tier2Records = records.filter((r) => r.tier2_used);
const tier2Used = tier2Records.length;

const providers = {};
for (const r of tier2Records) {
  providers[r.tier2_used] = (providers[r.tier2_used] || 0) + 1;
}

const statuses = {};
for (const r of records) {
  if (r.tier2_status) statuses[r.tier2_status] = (statuses[r.tier2_status] || 0) + 1;
}

const throttledByProvider = {};
for (const r of records) {
  if (r.tier2_status === "throttled" && r.tier2_used) {
    throttledByProvider[r.tier2_used] = (throttledByProvider[r.tier2_used] || 0) + 1;
  }
}

const cacheHits = records.filter((r) => r.tier2_cache_hit).length;

const latencies = records
  .map((r) => r.latency_ms)
  .filter((n) => Number.isFinite(n) && n >= 0)
  .sort((a, b) => a - b);

function percentile(sorted, p) {
  if (!sorted.length) return null;
  // p × len rounded UP then -1 maps a fractional percentile to the matching
  // zero-based index. p95 with 100 samples → ceil(95) - 1 = 94, the 95th
  // value. Floor of len × p would yield 95 (the 96th value) when len × p
  // lands on an integer, shifting the percentile by one.
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx];
}

// --- Output ---

console.log(`qmtweb-stats.jsonl  —  ${path}`);
console.log(`Records: ${total}`);
console.log(`Range:   ${tsFirst}  →  ${tsLast}`);
console.log(`Unique queries (q_hash): ${uniqHashes.size}`);
console.log("");

console.log(`Tier-2 used: ${tier2Used} of ${total} (${pct(tier2Used, total)})`);
if (tier2Used > 0) {
  console.log("Provider distribution:");
  for (const [name, count] of Object.entries(providers).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name.padEnd(12)} ${String(count).padStart(6)}  (${pct(count, tier2Used)})`);
  }
}
console.log("");

if (Object.keys(statuses).length) {
  console.log("Tier-2 status breakdown:");
  for (const [s, c] of Object.entries(statuses).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(12)} ${String(c).padStart(6)}`);
  }
  console.log("");
}

if (Object.keys(throttledByProvider).length) {
  console.log("429s per provider:");
  for (const [name, count] of Object.entries(throttledByProvider).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name.padEnd(12)} ${String(count).padStart(6)}`);
  }
  console.log("");
}

if (tier2Used > 0) {
  console.log(`Cache hit rate (of Tier-2 calls): ${cacheHits} of ${tier2Used} (${pct(cacheHits, tier2Used)})`);
}

if (latencies.length) {
  console.log("");
  console.log("Latency (ms):");
  console.log(`  p50  ${percentile(latencies, 0.50)}`);
  console.log(`  p95  ${percentile(latencies, 0.95)}`);
  console.log(`  p99  ${percentile(latencies, 0.99)}`);
  console.log(`  max  ${latencies[latencies.length - 1]}`);
}
