// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * The catalog's Ed25519 public key (raw 32 bytes, base64). The client verifies
 * every fetched index and manifest against this before trusting any CDN bytes —
 * so a compromised or stale CDN edge can only serve content that fails the
 * signature/hash check (spec §7.4).
 *
 * This MUST stay in sync with `catalog/keys/catalog.pub` in the catalog repo.
 *
 * ⚠️ Development placeholder — regenerate for production with the catalog's
 *    `tools/gen-keypair.mjs` and copy the new public key here.
 */
export const CATALOG_PUBLIC_KEY_B64 = "GwNoyczS8HN1lg05AKcD5ycQ5faAwztpev3CGwRpNf4=";
