// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

import type {
  ParsedHttpResponse,
  ServeBridgeOptions,
  ServerLaunch,
  StartServerOptions,
} from "../types";
import type { Nano } from "../core/nano";

// ---------------------------------------------------------------------------
// HTTP response parsing (binary-safe)
// ---------------------------------------------------------------------------

function indexOfCrlfCrlf(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  }
  return -1;
}

function decodeChunked(data: Uint8Array): Uint8Array {
  // The decoded body is never larger than the encoded one: size it once and
  // copy whole chunks (no per-byte array growth).
  const out = new Uint8Array(data.length);
  const dec = new TextDecoder();
  let len = 0;
  let i = 0;
  while (i < data.length) {
    let lineEnd = i;
    while (lineEnd + 1 < data.length && !(data[lineEnd] === 13 && data[lineEnd + 1] === 10)) lineEnd++;
    // Chunk extensions (";name=value") follow the size.
    const sizeField = dec.decode(data.subarray(i, lineEnd)).split(";")[0] ?? "";
    const size = parseInt(sizeField.trim(), 16);
    if (!size || Number.isNaN(size)) break;
    i = lineEnd + 2; // skip CRLF after the size line
    const end = Math.min(i + size, data.length);
    out.set(data.subarray(i, end), len);
    len += end - i;
    i = end + 2; // skip CRLF after the chunk
  }
  return out.slice(0, len);
}

/**
 * Parse the guest's raw HTTP/1.1 response into status/headers/body. Splits on the
 * first CRLFCRLF, parses the status line and headers (lower-cased keys), decodes
 * `Transfer-Encoding: chunked`, and returns the body as a transferable ArrayBuffer.
 */
export function parseHttpResponse(raw: Uint8Array): ParsedHttpResponse {
  const sep = indexOfCrlfCrlf(raw);
  const headerBytes = sep === -1 ? raw : raw.subarray(0, sep);
  let bodyBytes = sep === -1 ? new Uint8Array(0) : raw.subarray(sep + 4);

  const lines = new TextDecoder().decode(headerBytes).split("\r\n");
  const m = /HTTP\/[\d.]+ (\d+)(?: (.*))?/.exec(lines[0] ?? "");
  const status = m ? parseInt(m[1] as string, 10) : 200;
  const statusText = m && m[2] ? m[2] : "";

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }

  if ((headers["transfer-encoding"] ?? "").toLowerCase().includes("chunked")) {
    bodyBytes = decodeChunked(bodyBytes);
  }

  return { status, statusText, headers, body: bodyBytes.slice().buffer };
}

// ---------------------------------------------------------------------------
// Service-worker bridge
// ---------------------------------------------------------------------------

/**
 * Wires the shipped service worker to a {@link ConnectionInjector}. The SW posts
 * `sw-request` messages (one MessagePort per request); this bridge injects the
 * raw HTTP into the guest server and replies with the parsed response.
 */
export class ServeBridge {
  private constructor(
    private readonly scope: string,
    private readonly registration: ServiceWorkerRegistration,
    private readonly listener: (event: MessageEvent) => void,
  ) {}

  static async register(opts: ServeBridgeOptions): Promise<ServeBridge> {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      throw new Error("nano-sdk: service workers are not available in this context.");
    }
    const scope = opts.scope ?? new URL("./", new URL(opts.swUrl, location.href)).pathname;
    const registration = await navigator.serviceWorker.register(opts.swUrl, { scope });
    await navigator.serviceWorker.ready;
    // Critical: without this, queued sw-request messages never reach the page.
    navigator.serviceWorker.startMessages();

    const listener = (event: MessageEvent): void => {
      const data = event.data as
        | { type?: string; port?: number; httpRequest?: string; httpRequestBytes?: ArrayBuffer }
        | undefined;
      if (!data || data.type !== "sw-request") return;
      const replyPort = event.ports[0];
      if (!replyPort) return;

      // Prefer the binary-safe request bytes (current SW); fall back to the
      // legacy string form from older service workers.
      const request: string | Uint8Array =
        data.httpRequestBytes instanceof ArrayBuffer
          ? new Uint8Array(data.httpRequestBytes)
          : (data.httpRequest as string);

      void opts.injector
        .injectConnection(data.port as number, request)
        .then((raw) => {
          const parsed = parseHttpResponse(raw);
          replyPort.postMessage(parsed, [parsed.body]);
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          replyPort.postMessage({
            status: 502,
            statusText: "Bad Gateway",
            headers: { "content-type": "text/plain" },
            body: new TextEncoder().encode(msg).buffer,
          });
        });
    };

    navigator.serviceWorker.addEventListener("message", listener);
    // Announce this page as a VM host so the SW routes preview requests here
    // (and not to some other same-origin window).
    ServeBridge.announce(registration, "nano-bridge-attach");
    return new ServeBridge(scope, registration, listener);
  }

  private static announce(registration: ServiceWorkerRegistration, type: string): void {
    try {
      (registration.active ?? navigator.serviceWorker.controller)?.postMessage({ type });
    } catch {
      /* best-effort: the SW falls back to its client heuristic */
    }
  }

  /** URL the preview iframe should load: `<scope>sw/<port>/<path>`. */
  previewUrl(port: number, path: string = "/"): string {
    const p = path.startsWith("/") ? path : "/" + path;
    return `${this.scope}sw/${port}${p}`;
  }

  /** Stop handling sw-request messages (keeps the SW registered). */
  detach(): void {
    navigator.serviceWorker.removeEventListener("message", this.listener);
    ServeBridge.announce(this.registration, "nano-bridge-detach");
  }

  async unregister(): Promise<void> {
    this.detach();
    await this.registration.unregister();
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle helper
// ---------------------------------------------------------------------------

/**
 * Start an in-VM server. Because a listening server never resolves its run
 * promise (§2.7), this resolves on output readiness (default `/listening/i`) and
 * returns `{ stop }`. Rejects if the run resolves before readiness (early exit).
 *
 * While the server runs it holds the VM: other run/shExec/node/fs-mutation
 * calls on the same Nano reject with a "VM is busy serving" error until
 * `stop()` (see {@link Nano.withVmLock}). Use a second instance for concurrent work.
 */
export function startServer(
  nano: Nano,
  launch: ServerLaunch,
  opts: StartServerOptions = {},
): Promise<{ stop: () => void }> {
  const readyPattern = opts.readyPattern ?? /listening/i;
  return new Promise((resolve, reject) => {
    let ready = false;
    let buffer = "";

    const onData = (chunk: string): void => {
      opts.onData?.(chunk);
      if (ready) return;
      buffer += chunk;
      if (readyPattern.test(buffer)) {
        ready = true;
        opts.onReady?.();
        resolve({ stop: () => nano.cancel() });
      }
    };

    const runPromise = nano.launchServer(launch, { onData });

    runPromise.then(
      (res) => {
        if (!ready) {
          reject(
            new Error(
              `nano-sdk: server exited before ready (exit ${res.exitCode}): ${res.stdout}`,
            ),
          );
        }
      },
      (err: unknown) => {
        if (!ready) reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
