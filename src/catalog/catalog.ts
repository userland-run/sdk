// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

import { CdnClient, type CdnOptions } from "./cdn";
import { openChunkCache, type ChunkCache } from "./cache";
import { publicKeyFromB64 } from "./crypto";
import {
  installApp,
  resolveIndex,
  resolveManifest,
  type InstallContext,
} from "./installer";
import type { InstallOptions, InstallTarget, Manifest, SignedIndex } from "./types";

export interface CatalogOptions {
  /** CDN origin override (R2 mirror, local static dir for tests). */
  cdn?: CdnOptions;
  /** Provide a chunk cache; default is OPFS-backed (memory fallback). */
  cache?: ChunkCache;
  /** Override the verification key (raw base64). Default: bundled catalog.pub. */
  publicKeyB64?: string;
}

/**
 * Client for the nano app catalog: resolve and install signed, content-addressed
 * apps from the CDN, verifying every byte against the bundled catalog key.
 *
 * ```ts
 * const catalog = new Catalog();
 * await catalog.install(nano.fs, "ripgrep");        // eager
 * await catalog.install(nano.fs, "ripgrep", { lazy: true });
 * ```
 */
export class Catalog {
  private readonly cdn: CdnClient;
  private readonly cachePromise: Promise<ChunkCache>;
  private readonly publicKeyB64?: string;

  constructor(opts: CatalogOptions = {}) {
    this.cdn = new CdnClient(opts.cdn);
    this.cachePromise = opts.cache ? Promise.resolve(opts.cache) : openChunkCache();
    this.publicKeyB64 = opts.publicKeyB64;
  }

  private async ctx(): Promise<InstallContext> {
    const cache = await this.cachePromise;
    const key = this.publicKeyB64 ? await publicKeyFromB64(this.publicKeyB64) : undefined;
    return { cdn: this.cdn, cache, key };
  }

  /** The current signed index (verified). */
  async index(): Promise<SignedIndex> {
    return resolveIndex(await this.ctx());
  }

  /** A verified manifest for `name` or `name@version`. */
  async manifest(ref: string): Promise<Manifest> {
    return resolveManifest(await this.ctx(), ref);
  }

  /** Install `name`/`name@version` into `target` (e.g. `nano.fs`). */
  async install(target: InstallTarget, ref: string, opts?: InstallOptions): Promise<Manifest> {
    return installApp(target, ref, await this.ctx(), opts);
  }
}
