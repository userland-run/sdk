// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * Web Crypto helpers for the catalog client: SHA-256 content hashing and Ed25519
 * signature verification. The canonicalization here MUST match the catalog's
 * tools/lib/manifest.mjs so signatures produced at publish time verify on the
 * client.
 *
 * Ed25519 in Web Crypto is available in modern browsers (2024+) and Node 20+.
 */

import { CATALOG_PUBLIC_KEY_B64 } from "./pubkey";

const b64ToBytes = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/** Deterministic JSON: object keys sorted recursively; array order preserved. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

let cachedKey: Promise<CryptoKey> | null = null;
function importPublicKey(rawB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", b64ToBytes(rawB64) as BufferSource, { name: "Ed25519" }, false, ["verify"]);
}

/** The bundled catalog public key (memoized import). */
export function catalogPublicKey(): Promise<CryptoKey> {
  return (cachedKey ??= importPublicKey(CATALOG_PUBLIC_KEY_B64));
}

/** Import an arbitrary raw-base64 Ed25519 public key (for tests / custom catalogs). */
export function publicKeyFromB64(rawB64: string): Promise<CryptoKey> {
  return importPublicKey(rawB64);
}

export async function verifyEd25519(
  key: CryptoKey,
  message: Uint8Array,
  signatureB64: string,
): Promise<boolean> {
  return crypto.subtle.verify({ name: "Ed25519" }, key, b64ToBytes(signatureB64) as BufferSource, message as BufferSource);
}

/**
 * Verify a signed manifest or index object: recompute the content hash and check
 * the Ed25519 signature. Mirrors verifyManifest in tools/lib/manifest.mjs.
 *   sha256    = sha256( canonical(obj without sha256, signature) )
 *   signature = ed25519( canonical(obj without signature) )   // includes sha256
 */
export async function verifySigned(
  obj: Record<string, unknown>,
  key?: CryptoKey,
): Promise<{ ok: boolean; reason?: string }> {
  const { signature, sha256, ...rest } = obj as { signature?: string; sha256?: string };
  if (!signature) return { ok: false, reason: "missing signature" };
  if (!sha256) return { ok: false, reason: "missing sha256" };
  const enc = new TextEncoder();
  const recomputed = await sha256Hex(enc.encode(canonicalize(rest)));
  if (recomputed !== sha256) return { ok: false, reason: "sha256 mismatch" };
  const k = key ?? (await catalogPublicKey());
  const signedBytes = enc.encode(canonicalize({ ...rest, sha256 }));
  if (!(await verifyEd25519(k, signedBytes, signature))) return { ok: false, reason: "bad signature" };
  return { ok: true };
}
