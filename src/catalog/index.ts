// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/** Catalog client: fetch → verify → install nano apps from the CDN (spec §6–§7). */

export { Catalog, type CatalogOptions } from "./catalog";
export { CdnClient, type CdnOptions } from "./cdn";
export { openChunkCache, type ChunkCache } from "./cache";
export {
  installApp,
  resolveIndex,
  resolveManifest,
  fetchVerifiedChunk,
  assembleFile,
  type InstallContext,
} from "./installer";
export { verifySigned, sha256Hex, canonicalize, catalogPublicKey, publicKeyFromB64 } from "./crypto";
export { CATALOG_PUBLIC_KEY_B64 } from "./pubkey";
export { manifestKind, isWasmKind } from "./types";
export type {
  Manifest,
  ManifestFile,
  ArtifactKind,
  AppRecipe,
  SignedIndex,
  Collection,
  InstallTarget,
  InstallOptions,
  InstallProgress,
  LazyFileMeta,
} from "./types";
