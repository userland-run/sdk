// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

import type { ExecResult, NodeRunOptions } from "../types";
import type { Nano } from "../core/nano";
import { NODE_DEFAULT_MAX_STEPS } from "../core/exec-opts";
import type { RestoreOptions, VMSnapshot } from "../vendor/nanovm.mjs";

/**
 * Snapshot-based fast path for repeated Node execution. `warmup()` boots V8 once
 * and captures the post-init snapshot; every `run()` restores that **same**
 * snapshot, so runs are isolated from each other's mutations (§10.2). Seed
 * per-run inputs with `extraFiles`.
 */
export class NodeRuntime {
  private snap: VMSnapshot | null = null;
  /** In-flight warmup, shared so concurrent run()/warmup() calls build once. */
  private warming: Promise<VMSnapshot> | null = null;

  constructor(private readonly nano: Nano) {}

  get isWarm(): boolean {
    return this.snap !== null;
  }

  async warmup(opts?: { maxSteps?: number }): Promise<void> {
    await this.ensureSnapshot(opts);
  }

  private ensureSnapshot(opts?: { maxSteps?: number }): Promise<VMSnapshot> {
    if (this.snap) return Promise.resolve(this.snap);
    if (!this.warming) {
      const warming = this.nano.withVmLock(() => this.nano.raw.nodeSnapshot(opts));
      this.warming = warming;
      warming.then(
        (s) => {
          if (this.warming === warming) this.snap = s;
        },
        () => undefined,
      );
      // Clear the in-flight marker once settled (a failure can be retried).
      void warming
        .catch(() => undefined)
        .then(() => {
          if (this.warming === warming) this.warming = null;
        });
    }
    return this.warming;
  }

  async run(source: string, opts?: NodeRunOptions): Promise<ExecResult> {
    const snap = await this.ensureSnapshot();

    const ro: RestoreOptions = {};
    if (opts?.onData) ro.onStdout = opts.onData;
    // restoreAndRun() defaults to the 2M BusyBox budget; a warm V8 still needs
    // far more to read /dev/__run__, compile, and run the script (spec §5.3).
    ro.maxSteps = opts?.maxSteps ?? NODE_DEFAULT_MAX_STEPS;
    if (opts?.extraFiles) ro.extraFiles = opts.extraFiles;

    return this.nano.withVmLock(() => this.nano.raw.restoreAndRun(snap, source, ro));
  }

  /** Drop the warm snapshot; the next run re-warms (optionally from new fs state). */
  reset(): void {
    this.snap = null;
    this.warming = null;
  }
}
