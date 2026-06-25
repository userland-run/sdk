// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

import type { BinarySource, ImageConfig } from "../types";
import type { CreateOptions } from "../vendor/nanovm.mjs";

export interface ResolvedImage {
  createOpts: CreateOptions;
  /** Overlay archives (bytes) to loadTarGz, in order, after create(). */
  overlays: Uint8Array[];
  /** Revokes any object URLs minted for byte busybox/node sources. */
  revoke: () => void;
}

async function toBytes(src: BinarySource): Promise<Uint8Array> {
  if (typeof src === "string") {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`nano-sdk: failed to fetch ${src} (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }
  return src instanceof Uint8Array ? src : new Uint8Array(src);
}

/**
 * Normalize an {@link ImageConfig} into NanoVM.create options.
 *
 * - `wasm` flows straight through (create accepts URL or bytes).
 * - `busybox`/`node` bytes are minted into object URLs (the runtime accepts
 *   only URLs for those). This requires a browser; in Node use URLs or the
 *   bundled wasm build.
 * - `overlays` are fetched/normalized to bytes for post-boot `loadTarGz`.
 */
export async function resolveImage(image: ImageConfig): Promise<ResolvedImage> {
  const urls: string[] = [];
  const mkObjectUrl = (bytes: ArrayBuffer | Uint8Array): string => {
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      throw new Error(
        "nano-sdk: byte busybox/node sources require a browser (URL.createObjectURL). " +
          "In Node, pass a URL or use the bundled wasm build.",
      );
    }
    const u = URL.createObjectURL(new Blob([bytes as BlobPart]));
    urls.push(u);
    return u;
  };

  const createOpts: CreateOptions = { wasm: image.wasm };
  if (image.busybox !== undefined) {
    createOpts.busyboxUrl =
      typeof image.busybox === "string" ? image.busybox : mkObjectUrl(image.busybox);
  }
  if (image.node !== undefined) {
    createOpts.nodeUrl =
      typeof image.node === "string" ? image.node : mkObjectUrl(image.node);
  }

  const overlays: Uint8Array[] = [];
  for (const ov of image.overlays ?? []) {
    overlays.push(await toBytes(ov));
  }

  return {
    createOpts,
    overlays,
    revoke: () => {
      for (const u of urls) URL.revokeObjectURL(u);
      urls.length = 0;
    },
  };
}

export interface NanoImageOptions {
  /** Directory holding nano.wasm and (for the small build) images/ + build/. */
  baseUrl: string;
  /** Include images/busybox (small build). Default true. */
  withBusybox?: boolean;
  /** Include images/node (small build). Default false. */
  withNode?: boolean;
  /** Include build/devenv.tar.gz as an overlay. Default false. */
  withDevenv?: boolean;
}

/** Convenience builder over {@link ImageConfig} (spec §6.3). */
export function nanoImage(opts: NanoImageOptions): ImageConfig {
  const base = opts.baseUrl.endsWith("/") ? opts.baseUrl : opts.baseUrl + "/";
  const image: ImageConfig = { wasm: base + "nano.wasm" };
  if (opts.withBusybox !== false) image.busybox = base + "images/busybox";
  if (opts.withNode) image.node = base + "images/node";
  if (opts.withDevenv) image.overlays = [base + "build/devenv.tar.gz"];
  return image;
}
