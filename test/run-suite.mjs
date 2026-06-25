// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Run the node:test suite programmatically and emit a userland-results.json
// (contract v1) for the userland.run status hub. Each test name carries one or
// more `[feat:<id>]` tokens naming the registry feature(s) it exercises; we
// subscribe to the runner's `test:pass` / `test:fail` events, extract those
// tokens, and map every leaf test to a result row. No TAP parsing.
//
//   node test/run-suite.mjs > userland-results.json
//
// Diagnostics go to stderr; the JSON document goes to stdout. The process exits
// 0 even when tests fail — failed results are still valid contract rows and must
// be published so the hub can show the regression.

import { run } from "node:test";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const SOURCE = "sdk";
const SUITE = "sdk-unit";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort()
  .map((f) => join(here, f));

// Extract `[feat:a.b.c]` tokens from a test name (a test may carry several).
const FEAT_RE = /\[feat:([a-z0-9][a-z0-9.-]*)\]/g;
const featuresFrom = (name = "") => [...name.matchAll(FEAT_RE)].map((m) => m[1]);

const results = [];
let passed = 0,
  failed = 0,
  skipped = 0;

function record(data, status) {
  const features = featuresFrom(data.name);
  if (features.length === 0) return; // suites/roots/untagged tests carry no feature
  results.push({
    test_id: `${basename(data.file ?? "unknown")}::${data.name}`,
    features,
    status,
    duration_ms: Math.round(data.details?.duration_ms ?? 0),
    retries: 0,
  });
  if (status === "passed") passed++;
  else if (status === "failed") failed++;
  else skipped++;
}

const stream = run({ files, concurrency: 1, timeout: 20 * 60_000 });

for await (const event of stream) {
  if (event.type === "test:pass") {
    const { skip, todo } = event.data;
    record(event.data, skip || todo ? "skipped" : "passed");
  } else if (event.type === "test:fail") {
    record(event.data, "failed");
    // Surface the failure reason on stderr so CI logs explain a red row.
    const err = event.data.details?.error;
    if (err) console.error(`✗ ${event.data.name}\n  ${err.message ?? err}`);
  }
}

const out = {
  contract: 1,
  source: SOURCE,
  suite: SUITE,
  commit: process.env.GITHUB_SHA?.slice(0, 7) || "local",
  branch: process.env.GITHUB_REF_NAME || "local",
  run_id: process.env.GITHUB_RUN_ID || "local",
  finished_at: new Date().toISOString(),
  results,
};

process.stdout.write(JSON.stringify(out, null, 2) + "\n");
console.error(
  `✓ ${results.length} results → ${SOURCE}/${SUITE} (${passed} passed, ${failed} failed, ${skipped} skipped)`,
);
// Always exit 0: a failed test is a valid result row that must still be published.
process.exit(0);
