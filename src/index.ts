// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * @userland-run/nano-sdk — a typed, layered SDK over NanoVM's browser runtime.
 *
 * Run BusyBox / Node.js Linux binaries in the browser: code mode (run/exec/node),
 * terminal mode (Shell), and serve mode (ServeBridge + in-VM HTTP servers).
 */

export { Nano, createNano } from "./core/nano";
export {
  createHeadless,
  type HeadlessConfig,
  type HeadlessSession,
  type HeadlessServer,
  type HeadlessServeOptions,
} from "./headless";
export { Vfs } from "./core/vfs";
export { nanoImage } from "./core/images";
export type { NanoImageOptions, ResolvedImage } from "./core/images";

export { Shell, tokenize } from "./shell/shell";

export { ScriptError } from "./scripting/script-engine";

export { ServeBridge, startServer, parseHttpResponse } from "./serve/bridge";
export type { PortListener } from "./serve/loopback";
export {
  registerNanoServiceWorker,
  ensureCrossOriginIsolated,
  type RegisterServiceWorkerOptions,
  type ServiceWorkerStatus,
} from "./serve/register-sw";

export { NodeRuntime } from "./node/node-runtime";

export { NanoWorkerClient, createNanoWorker, type NanoWorkerOptions } from "./worker/client";

export {
  provision,
  type ProvisionOptions,
  type ProvisionedApp,
  type ServiceHandle as ProvisionServiceHandle,
  type RunOptions as ProvisionRunOptions,
  type ServeOptions as ProvisionServeOptions,
} from "./provision";

export {
  Catalog,
  type CatalogOptions,
  type BundleInstallResult,
  CdnClient,
  type CdnOptions,
  openChunkCache,
  type ChunkCache,
  installApp,
  resolveIndex,
  resolveManifest,
  fetchVerifiedChunk,
  verifySigned,
  sha256Hex,
  canonicalize,
  catalogPublicKey,
  publicKeyFromB64,
  CATALOG_PUBLIC_KEY_B64,
  defaultGenerationStore,
  type GenerationStore,
  manifestKind,
  isWasmKind,
  kindToTier,
  manifestTier,
  type InstallContext,
  type Manifest,
  type ManifestFile,
  type ArtifactKind,
  type Tier,
  type AppMeta,
  type AppRecipe,
  type SignedIndex,
  type Collection,
  type InstallTarget,
  type InstallOptions,
  type InstallProgress,
  type LazyFileMeta,
  type BundleManifest,
} from "./catalog";

export * from "./types";
