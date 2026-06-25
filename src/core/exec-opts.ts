// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

import type { ExecOptions } from "../types";
import type { RuntimeRunOptions } from "../vendor/nanovm.mjs";

/**
 * Instruction budget for Node runs (cold boot and warm restore). V8 startup
 * alone exceeds the 2M default the runtime applies to BusyBox runs; the runtime
 * does not special-case node, so the SDK supplies this default (spec §5.3).
 */
export const NODE_DEFAULT_MAX_STEPS = 2_000_000_000;

/**
 * Adapter from the SDK's public {@link ExecOptions} (`onData`) to the vendored
 * runtime's options (`onStdout`). Single source of truth — used everywhere a
 * public exec option crosses into the runtime. `defaultMaxSteps` raises the
 * budget for node paths when the caller didn't set one.
 */
export function toRuntimeOpts(opts?: ExecOptions, defaultMaxSteps?: number): RuntimeRunOptions {
  const out: RuntimeRunOptions = {};
  if (opts?.onData) out.onStdout = opts.onData;
  if (opts?.maxSteps !== undefined) out.maxSteps = opts.maxSteps;
  else if (defaultMaxSteps !== undefined) out.maxSteps = defaultMaxSteps;
  return out;
}
