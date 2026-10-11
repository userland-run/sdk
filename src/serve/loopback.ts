// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Kernel loopback injection (spec §11.1): reach a server that listens in the
// shared Kernel port table but NOT inside the RISC-V VM — e.g. a Node server
// started with nano.node() on the host engine (nodert). Same wiring nodert's
// own `net.connect` uses (net.connect_loopback): two crossed Kernel pipes plus
// a "connection" event to the listener's process.

/** A listener in the Kernel port table. */
export interface PortListener {
  port: number;
  ownerPid: number;
  /** Tier that owns the listener: "vm" (RISC-V VM), "node" (host engine), … */
  kind: string;
}

interface KernelPipe {
  id: number;
  write(bytes: Uint8Array): void;
  read(maxLen: number): Uint8Array | null | "eof";
  waitReadable(): Promise<void>;
  closeWrite(): void;
}

/** The slice of the vendored Kernel loopback injection needs. */
export interface LoopbackKernel {
  ports: { lookup(port: number): PortListener | null; list(): PortListener[] };
  pipes: { create(): KernelPipe; destroy(id: number): void };
  hub: { sendEvent(pid: number, ev: Record<string, unknown>): void };
}

const RESPONSE_TIMEOUT_MS = 30_000;
/** Grace period before freeing the request pipe (the server may still have a read pending). */
const PIPE_GC_MS = 60_000;

const enc = new TextEncoder();

function indexOfCrlfCrlf(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  }
  return -1;
}

function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] as number);
  return s;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Rewrite the request head to `Connection: close` so the response ends with
 * EOF. Only the head is touched; a binary body passes through byte-for-byte.
 */
function forceConnectionClose(request: string | Uint8Array): Uint8Array {
  const bytes = typeof request === "string" ? enc.encode(request) : request;
  const sep = indexOfCrlfCrlf(bytes);
  if (sep === -1) return bytes;
  const lines = latin1(bytes.subarray(0, sep))
    .split("\r\n")
    .filter((l, i) => i === 0 || !/^connection\s*:/i.test(l));
  lines.push("Connection: close");
  const head = lines.join("\r\n");
  const out = new Uint8Array(head.length + (bytes.length - sep));
  for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i) & 0xff;
  out.set(bytes.subarray(sep), head.length);
  return out;
}

/** Total length of a complete response, if its head says (Content-Length); else null. */
function expectedLength(buf: Uint8Array): number | null {
  const sep = indexOfCrlfCrlf(buf);
  if (sep === -1) return null;
  const head = latin1(buf.subarray(0, sep));
  if (/\r\ntransfer-encoding:\s*chunked/i.test(head)) return null;
  const m = /\r\ncontent-length:\s*(\d+)/i.exec(head);
  return m ? sep + 4 + parseInt(m[1] as string, 10) : null;
}

/**
 * Inject one raw HTTP/1.1 request into the Kernel listener on `port` and
 * collect the raw response. Resolves when the server closes the connection
 * (or a Content-Length-delimited response is complete). Rejects if nothing
 * listens on `port` or the server does not finish within 30s.
 */
export async function injectLoopback(
  k: LoopbackKernel,
  port: number,
  request: string | Uint8Array,
): Promise<Uint8Array> {
  const listener = k.ports.lookup(port);
  if (!listener) throw new Error(`nano-sdk: no server listening on port ${port}`);
  const c2s = k.pipes.create(); // client → server
  const s2c = k.pipes.create(); // server → client
  try {
    k.hub.sendEvent(listener.ownerPid, {
      ev: "connection",
      port,
      readPipe: c2s.id,
      writePipe: s2c.id,
      remotePort: 0,
    });
    c2s.write(forceConnectionClose(request));

    const parts: Uint8Array[] = [];
    let got = 0;
    let want: number | null = null;
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    for (;;) {
      const r = s2c.read(1 << 16);
      if (r === "eof") break;
      if (r) {
        parts.push(r);
        got += r.length;
        if (want === null) want = expectedLength(concat(parts));
        if (want !== null && got >= want) break;
        continue;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`nano-sdk: server on port ${port} did not respond`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        s2c.waitReadable(),
        new Promise((res) => {
          timer = setTimeout(res, Math.min(left, 1000));
        }),
      ]);
      clearTimeout(timer);
    }
    return concat(parts);
  } finally {
    // EOF to the server's read side. The response pipe is ours alone; the
    // request pipe is freed after a grace period, since destroying it now
    // would fail a pipe_read the server has yet to issue (EBADF).
    c2s.closeWrite();
    k.pipes.destroy(s2c.id);
    const gc = setTimeout(() => k.pipes.destroy(c2s.id), PIPE_GC_MS);
    (gc as { unref?: () => void }).unref?.();
  }
}
