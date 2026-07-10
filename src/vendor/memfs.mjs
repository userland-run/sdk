// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

// MemFS moved to vendor/kernel/vfs/memfs.mjs as part of the Kernel extraction
// (specs/nano/node-host-engine.md §4.1). The kernel tree is a strict
// byte-identical mirror of nano/kernel/** (enforced by scripts/check-vendor.mjs,
// unlike the curated nanovm.mjs). This shim keeps the historical import path
// working for the vendored nanovm.mjs.

export { MemFS, FSNode } from "./kernel/vfs/memfs.mjs";
