// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * Shared VM bootstrap for the node:test suite (mirrors test/smoke.mjs).
 *
 * Boots the built SDK against a BusyBox-capable nano.wasm. Most suites only need
 * BusyBox, so they boot with a small guest RAM; the (opt-in) node suite passes
 * `{ node: true }` to let the SDK auto-size RAM for V8 (~1.8GB).
 *
 * Runtime artifacts are resolved in this order:
 *   1. $NANO_WASM / $NANO_BOA  (set by CI after downloading release assets)
 *   2. the sibling checkout    (../../../nano/wasm/*.wasm — local dev workspace)
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createNano } from "../../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));

export const WASM_PATH = process.env.NANO_WASM ?? join(here, "../../../nano/wasm/nano.wasm");
export const BOA_PATH = process.env.NANO_BOA ?? join(here, "../../../nano/wasm/boa.wasm");

export const wasmAvailable = existsSync(WASM_PATH);
export const boaAvailable = existsSync(BOA_PATH);

/**
 * Create a Nano instance for tests.
 *
 * @param {object} [opts]
 * @param {number} [opts.ramMB]      Override guest RAM (MB).
 * @param {boolean} [opts.node]      Reserve V8-sized RAM (let the SDK auto-size).
 * @param {boolean} [opts.scripting] Wire boa.wasm when present (default true).
 */
export async function boot({ ramMB, node = false, scripting = true } = {}) {
  if (!wasmAvailable) {
    throw new Error(
      `nano-sdk test: nano.wasm not found at ${WASM_PATH}. ` +
        "Set $NANO_WASM to a BusyBox-capable build (the bundled wasm/nano.wasm, " +
        "or a release nano.busybox.wasm).",
    );
  }
  const wasm = new Uint8Array(readFileSync(WASM_PATH));
  const config = {
    image: { wasm },
    crossOriginIsolation: "ignore",
  };
  // BusyBox-only suites cap RAM low; the node suite lets the SDK auto-size for V8.
  if (!node) config.ramMB = ramMB ?? 512;
  else if (ramMB) config.ramMB = ramMB;

  if (scripting && boaAvailable) {
    config.scripting = { wasm: new Uint8Array(readFileSync(BOA_PATH)) };
  }
  return createNano(config);
}
