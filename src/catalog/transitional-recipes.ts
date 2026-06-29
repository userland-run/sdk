// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// ⚠️ TEMPORARY BRIDGE. The canonical home for an app recipe is its signed catalog
// manifest (built from catalog/recipes/<app>/recipe.toml). The currently-published
// manifests on jsDelivr predate the `recipe` field, so until the catalog is
// repackaged + republished, the runner falls back to these built-in recipes by
// app name. DELETE this file (and its use in provision()) once manifests carry
// their own `recipe`. Keep in sync with catalog/recipes/<app>/recipe.toml.

import type { AppRecipe } from "./types";

const NODE_RECIPE: AppRecipe = {
  // node runs standalone; busybox is a separate app (the shell), not a node dep.
  warmup: {
    elfPath: "/usr/bin/node",
    launcherPath: "/launcher.js",
    // Write the snapshot sentinel, then read+execute the per-run payload.
    launcher: [
      "const fs = require('fs');",
      "fs.writeFileSync('/dev/__snapshot__', 'snap');",
      "const __s = fs.readFileSync('/dev/__run__', 'utf8');",
      "(new Function(__s))();",
    ].join("\n"),
    argv: ["node", "/launcher.js"],
    env: { UV_THREADPOOL_SIZE: "0" },
    maxSteps: 2_000_000_000,
  },
  run: {
    // The launcher executes this as the /dev/__run__ payload.
    fileScript: "process.mainModule.require('${file}')",
    evalScript: "${code}",
  },
  // Node hits a libuv thread-join assertion on shutdown after a warm restore —
  // correct output is already produced, so the exit code is benign and the trace
  // is noise to strip.
  benignExitCodes: [134],
  outputFilters: ["WorkerThreadsTaskRunner", "Native stack trace", "Assertion failed: \\(0\\)"],
};

const TRANSITIONAL: Record<string, AppRecipe> = {
  node: NODE_RECIPE,
};

/** Built-in recipe for an app by name, used only when its manifest lacks one. */
export function transitionalRecipe(name: string): AppRecipe | undefined {
  return TRANSITIONAL[name];
}
