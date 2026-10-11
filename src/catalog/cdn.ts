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
const INDEX_PKG = "@userland-run/nano-catalog";
const CAS_PKG = "@userland-run/nano-cas";

export class CdnClient {
  private readonly baseUrl?: string;
  private readonly fetchFn: typeof fetch;
  private genPromise?: Promise<number>;

  constructor(opts: CdnOptions = {}) {
    this.baseUrl = opts.baseUrl?.replace(/\/$/, "");
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Resolve the newest catalog generation (memoized). jsDelivr-only. A failed
   * lookup is not memoized, so the next call retries.
   */
  async generation(): Promise<number> {
    if (this.baseUrl) return 0; // flat origin: no generations
    if (!this.genPromise) {
      const p = (async () => {
        const r = await this.fetchFn(`${JSDELIVR_DATA}/${INDEX_PKG}`);
        if (!r.ok) throw new Error(`catalog: versions API ${r.status}`);
        const data = (await r.json()) as { versions?: Array<{ version?: unknown }> };
        // Versions are 0.0.<gen>; newest gen = max patch. Ignore anything that
        // isn't a plain non-negative integer generation (pre-releases, junk).
        const gens = (data.versions ?? [])
          .map((v) => (typeof v?.version === "string" ? v.version : ""))
          .map((v) => {
            const m = /^0\.0\.(\d+)$/.exec(v);
            return m ? Number(m[1]) : NaN;
          })
          .filter((g) => Number.isSafeInteger(g) && g >= 0);
        if (gens.length === 0) throw new Error("catalog: no published generations");
        return Math.max(...gens);
      })();
      this.genPromise = p;
      p.catch(() => {
        if (this.genPromise === p) this.genPromise = undefined;
      });
    }
    return this.genPromise;
  }

  /**
   * The generation the next index fetch is pinned to, or null for a flat
   * `baseUrl` origin (which has no generation addressing).
   */
  async expectedGeneration(): Promise<number | null> {
    return this.baseUrl ? null : this.generation();
  }

  /**
   * Pin the generation (e.g. to a newer one already verified, when the
   * versions API answers from a stale edge). No-op for a flat origin.
   */
  pinGeneration(generation: number): void {
    if (!this.baseUrl) this.genPromise = Promise.resolve(generation);
  }

  /** Stable identity of this origin (for per-origin rollback state). */
  get originId(): string {
    return this.baseUrl ?? `${JSDELIVR_CDN}/${INDEX_PKG}`;
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
