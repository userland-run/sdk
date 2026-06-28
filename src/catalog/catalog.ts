// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

import { CdnClient, type CdnOptions } from "./cdn";
import { openChunkCache, type ChunkCache } from "./cache";
import { publicKeyFromB64, sha256Hex, verifySigned } from "./crypto";
import {
  installApp,
  resolveIndex,
  resolveManifest,
  type InstallContext,
} from "./installer";
import type { BundleManifest, Collection, InstallOptions, InstallTarget, Manifest, SignedIndex } from "./types";

/** Result of installing a topic bundle. */
export interface BundleInstallResult {
  topic: string;
  installed: Manifest[];
  failed: string[];
}

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

  /** Browse facets from the index: topic-slug -> member app refs. Empty if the
   *  index predates categories (gen ≤ 10) — fall back to {@link bundleManifest}. */
  async categories(): Promise<Record<string, string[]>> {
    return (await this.index()).categories ?? {};
  }

  /** Curated collections from the index: slug -> { title, description, members }.
   *  Empty on indexes that predate collections. */
  async collections(): Promise<Record<string, Collection>> {
    return (await this.index()).collections ?? {};
  }

  /** A verified topic-bundle manifest (the set of app refs in that topic). */
  async bundleManifest(slug: string): Promise<BundleManifest> {
    const ctx = await this.ctx();
    const idx = await resolveIndex(ctx);
    const sha = idx.bundles?.[slug];
    if (!sha) throw new Error(`catalog: bundle not found: ${slug}`);
    const bytes = await ctx.cdn.fetchBytes(await ctx.cdn.casUrl(sha));
    if ((await sha256Hex(bytes)) !== sha) throw new Error(`catalog: bundle hash mismatch ${slug}`);
    const bundle = JSON.parse(new TextDecoder().decode(bytes)) as BundleManifest;
    const v = await verifySigned(bundle as unknown as Record<string, unknown>, ctx.key);
    if (!v.ok) throw new Error(`catalog: bundle signature invalid for ${slug} (${v.reason})`);
    return bundle;
  }

  /**
   * Install every app in a topic bundle into `target`. Members share the same
   * musl, so the CAS dedups their chunks — a topic costs little more than its
   * largest member. A member that fails to install is reported, not thrown.
   */
  async installBundle(target: InstallTarget, slug: string, opts?: InstallOptions): Promise<BundleInstallResult> {
    const bundle = await this.bundleManifest(slug);
    const installed: Manifest[] = [];
    const failed: string[] = [];
    for (const ref of bundle.apps) {
      try { installed.push(await this.install(target, ref, opts)); }
      catch { failed.push(ref); }
    }
    return { topic: bundle.topic, installed, failed };
  }
}
