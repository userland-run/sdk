// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * Resolves catalog URLs. The default origin is jsDelivr over npm, which serves
 * immutable, content-addressed objects with a near-100% cache hit rate. The
 * newest generation is resolved through the jsDelivr **versions API** (not
 * permanently cached), then every other fetch uses an immutable `@<gen>` URL —
 * so no mutable file ever lives on the immutable CDN (spec §7.2).
 *
 * Any origin works because every object is content-addressed and
 * signature-verified (spec §7.4); pass `baseUrl` to point at an R2 mirror or a
 * local static dir (tests).
 */

export interface CdnOptions {
  /**
   * Override the CDN. When set, the client treats it as a flat, immutable origin:
   *   <baseUrl>/index.json   and   <baseUrl>/cas/<sha256>
   * (no generation resolution). Used for R2 mirrors and local testing.
   */
  baseUrl?: string;
  /** Override fetch (tests / custom transports). */
  fetchFn?: typeof fetch;
}

const JSDELIVR_CDN = "https://cdn.jsdelivr.net/npm";
const JSDELIVR_DATA = "https://data.jsdelivr.com/v1/packages/npm";
const INDEX_PKG = "@nano-apps/index";
const CAS_PKG = "@nano-apps/cas";

export class CdnClient {
  private readonly baseUrl?: string;
  private readonly fetchFn: typeof fetch;
  private genPromise?: Promise<number>;

  constructor(opts: CdnOptions = {}) {
    this.baseUrl = opts.baseUrl?.replace(/\/$/, "");
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  /** Resolve the newest catalog generation (memoized). jsDelivr-only. */
  async generation(): Promise<number> {
    if (this.baseUrl) return 0; // flat origin: no generations
    return (this.genPromise ??= (async () => {
      const r = await this.fetchFn(`${JSDELIVR_DATA}/${INDEX_PKG}`);
      if (!r.ok) throw new Error(`catalog: versions API ${r.status}`);
      const data = (await r.json()) as { versions?: Array<{ version: string }> };
      const versions = (data.versions ?? []).map((v) => v.version);
      if (versions.length === 0) throw new Error("catalog: no published generations");
      // Versions are 0.0.<gen>; newest gen = max patch.
      return Math.max(...versions.map((v) => Number(v.split(".").pop())));
    })());
  }

  private async versionString(): Promise<string> {
    return `0.0.${await this.generation()}`;
  }

  async indexUrl(): Promise<string> {
    if (this.baseUrl) return `${this.baseUrl}/index.json`;
    return `${JSDELIVR_CDN}/${INDEX_PKG}@${await this.versionString()}/index.json`;
  }

  async casUrl(sha256: string): Promise<string> {
    if (this.baseUrl) return `${this.baseUrl}/cas/${sha256}`;
    return `${JSDELIVR_CDN}/${CAS_PKG}@${await this.versionString()}/cas/${sha256}`;
  }

  async fetchJson<T>(url: string): Promise<T> {
    const r = await this.fetchFn(url);
    if (!r.ok) throw new Error(`catalog: GET ${url} → ${r.status}`);
    return (await r.json()) as T;
  }

  async fetchBytes(url: string): Promise<Uint8Array> {
    const r = await this.fetchFn(url);
    if (!r.ok) throw new Error(`catalog: GET ${url} → ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
}
