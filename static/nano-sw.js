// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// NanoVM Service Worker — intercepts /sw/PORT/path and routes to VirtualServer
// via postMessage to the page hosting the VM (the ServeBridge). Also injects
// COOP/COEP headers on same-origin documents/workers so SharedArrayBuffer works
// on hosts without custom header support (e.g. GitHub Pages).

// Derive base path from SW location so it works at any mount point
const BASE = new URL("./", self.location).pathname; // e.g. "/nano/"
const SCOPE_PREFIX = BASE + "sw/";
const ORIGIN = self.location.origin;
const TIMEOUT_MS = 30000;

// Statuses whose Response must have a null body (Fetch spec "null body status").
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);
// Hop-by-hop / framing headers that don't apply to a synthesized Response.
const STRIP_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade"]);

// Pages that announced a ServeBridge ("nano-bridge-attach"), and which bridge
// page each preview frame (client id) was routed to — so a preview iframe's
// requests go to the VM in ITS tab, not to whichever window happens to be first.
const bridgeClients = new Set();
const frameOwner = new Map();

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data;
  const source = event.source;
  if (!data || !source || typeof source.id !== "string") return;
  if (data.type === "nano-bridge-attach") bridgeClients.add(source.id);
  else if (data.type === "nano-bridge-detach") bridgeClients.delete(source.id);
});

/** Parse "<PORT>[/rest]" (the part after SCOPE_PREFIX) → { port, path } or null. */
function parseScoped(pathname) {
  if (!pathname.startsWith(SCOPE_PREFIX)) return null;
  const rest = pathname.slice(SCOPE_PREFIX.length);
  const slashIdx = rest.indexOf("/");
  const portStr = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
  if (!/^\d+$/.test(portStr)) return null;
  const port = parseInt(portStr, 10);
  if (port < 1 || port > 65535) return null;
  return { port, path: slashIdx === -1 ? "/" : rest.slice(slashIdx) };
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Never intercept cross-origin requests: the browser handles them (the page's
  // COEP: credentialless already covers no-cors subresources).
  if (url.origin !== ORIGIN) return;

  // Direct /sw/PORT/path requests (e.g. iframe src="/nano/sw/8080/?q=1")
  const direct = parseScoped(url.pathname);
  if (direct) {
    event.respondWith(handleRequest(event, direct.port, direct.path + url.search));
    return;
  }

  // Sub-requests from a preview iframe: same-origin referrer under /sw/PORT/
  const referrer = event.request.referrer;
  if (referrer) {
    try {
      const refUrl = new URL(referrer);
      const scoped = refUrl.origin === ORIGIN ? parseScoped(refUrl.pathname) : null;
      if (scoped) {
        event.respondWith(handleRequest(event, scoped.port, url.pathname + url.search));
        return;
      }
    } catch {}
  }

  // Runtime assets (wasm images, the vendored /vendor/ runner tree, tarball
  // overlays) keep stable URLs, so a long-lived HTTP cache entry from an older
  // release would pair an old wasm with a new host — always revalidate them
  // (cheap 304 when unchanged).
  if (event.request.method === "GET" && isRuntimeAsset(url.pathname)) {
    event.respondWith(fetch(event.request.url, { cache: "no-cache", credentials: "same-origin" }));
    return;
  }

  // Everything else: only documents and workers need isolation headers. Leave
  // other subresources (and non-GET bodies) to the network untouched — no
  // re-fetch, so a POST body is never replayed.
  const dest = event.request.destination;
  const isDocument =
    event.request.mode === "navigate" || dest === "document" || dest === "iframe" || dest === "frame";
  const isWorker = dest === "worker" || dest === "sharedworker" || dest === "serviceworker";
  if (!isDocument && !isWorker) return;

  event.respondWith(
    fetch(event.request).then((response) => {
      // Opaque / opaque-redirect (navigation redirect: "manual") / error
      // responses can't be read or re-wrapped — hand them back as-is.
      if (response.type === "opaque" || response.type === "opaqueredirect" || response.type === "error") {
        return response;
      }
      const headers = new Headers(response.headers);
      let changed = false;
      if (isDocument && !headers.has("Cross-Origin-Opener-Policy")) {
        headers.set("Cross-Origin-Opener-Policy", "same-origin");
        changed = true;
      }
      if (!headers.has("Cross-Origin-Embedder-Policy")) {
        headers.set("Cross-Origin-Embedder-Policy", "credentialless");
        changed = true;
      }
      if (!changed) return response;
      return new Response(NULL_BODY_STATUS.has(response.status) ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    })
  );
});

const isRuntimeAsset = (pathname) =>
  pathname.endsWith(".wasm") || pathname.endsWith(".tar.gz") || pathname.includes("/vendor/");

const isPreviewClient = (client) => {
  try {
    return new URL(client.url).pathname.startsWith(SCOPE_PREFIX);
  } catch {
    return false;
  }
};

/**
 * Pick the window that hosts the VM for this request:
 *   1. the requester itself, when it's an app page (e.g. fetch("/sw/8080/api"));
 *   2. the bridge page a preview frame was previously routed to;
 *   3. an announced bridge page, else any non-preview window — preferring a
 *      focused, then visible one.
 * The choice is remembered for the resulting/requesting preview frame.
 */
async function pickClient(event) {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const byId = new Map(all.map((c) => [c.id, c]));

  // Forget clients that are gone.
  for (const id of bridgeClients) if (!byId.has(id)) bridgeClients.delete(id);
  for (const [frame, owner] of frameOwner) {
    if (!byId.has(owner) || (!byId.has(frame) && frame !== event.resultingClientId)) frameOwner.delete(frame);
  }

  const requester = event.clientId ? byId.get(event.clientId) : undefined;
  if (requester && !isPreviewClient(requester) && (bridgeClients.size === 0 || bridgeClients.has(requester.id))) {
    return requester;
  }
  // A preview frame navigating itself replaces its old client id.
  const prior = event.clientId || event.replacesClientId;
  const owned = prior ? byId.get(frameOwner.get(prior)) : undefined;
  if (owned) {
    if (event.resultingClientId) frameOwner.set(event.resultingClientId, owned.id);
    return owned;
  }

  const announced = all.filter((c) => bridgeClients.has(c.id));
  const candidates = announced.length ? announced : all.filter((c) => !isPreviewClient(c));
  if (candidates.length === 0) return undefined;
  const chosen =
    candidates.find((c) => c.focused) ||
    candidates.find((c) => c.visibilityState === "visible") ||
    candidates[0];
  const frameId = event.resultingClientId || (requester && isPreviewClient(requester) ? requester.id : "");
  if (frameId) frameOwner.set(frameId, chosen.id);
  return chosen;
}

function plainResponse(status, statusText, text) {
  return new Response(text, {
    status,
    statusText,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  });
}

/** Build a Response from the bridge's parsed guest reply; never throws. */
function toResponse(data, method) {
  const { status: rawStatus, statusText, headers: respHeaders, body: respBody } = data || {};
  // The Response constructor only accepts 200..599.
  const status = Number.isInteger(rawStatus) && rawStatus >= 200 && rawStatus <= 599 ? rawStatus : 502;
  const headers = new Headers();
  for (const [k, v] of Object.entries(respHeaders || {})) {
    if (STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
    try {
      headers.append(k, v);
    } catch {
      /* skip a header the Fetch API rejects */
    }
  }
  // Same-origin CORP + credentialless COEP, consistent with the site's own
  // isolation headers, so the preview iframe loads under the parent's COEP.
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "credentialless");
  const nullBody = NULL_BODY_STATUS.has(status) || method === "HEAD";
  return new Response(nullBody ? null : respBody, {
    status,
    statusText: status === rawStatus ? statusText || "" : "Bad Gateway",
    headers,
  });
}

async function handleRequest(event, port, path) {
  const request = event.request;
  // Build a minimal HTTP/1.1 request to inject into the guest
  const method = request.method;
  const headers = [];
  for (const [key, value] of request.headers) {
    if (/^(connection|host|content-length)$/i.test(key)) continue;
    headers.push(`${key}: ${value}`);
  }

  // Binary-safe body: raw bytes, never a UTF-8 round-trip.
  let body = new Uint8Array(0);
  if (method !== "GET" && method !== "HEAD") {
    try {
      body = new Uint8Array(await request.arrayBuffer());
    } catch {}
  }

  const head = [`${method} ${path} HTTP/1.1`, `Host: localhost:${port}`, "Connection: close", ...headers];
  if (body.length) head.push(`Content-Length: ${body.length}`);
  // Headers end with \r\n\r\n — the blank line is the HTTP separator
  const headBytes = new TextEncoder().encode(head.join("\r\n") + "\r\n\r\n");
  const requestBytes = new Uint8Array(headBytes.length + body.length);
  requestBytes.set(headBytes, 0);
  requestBytes.set(body, headBytes.length);
  // Legacy string form for bridges that predate `httpRequestBytes` (lossy for
  // non-UTF-8 bodies, exactly as before).
  const httpRequest = new TextDecoder().decode(requestBytes);

  // Send to the page hosting the VM and wait for the response
  const client = await pickClient(event);
  if (!client) return plainResponse(502, "Bad Gateway", "No active client");

  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    const settle = (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.onmessage = null;
      channel.port1.close();
      resolve(response);
    };

    channel.port1.onmessage = (msg) => {
      try {
        settle(toResponse(msg.data, method));
      } catch (err) {
        settle(plainResponse(502, "Bad Gateway", "Invalid response from VM: " + (err && err.message)));
      }
    };

    const timer = setTimeout(() => {
      settle(plainResponse(504, "Gateway Timeout", "Gateway Timeout"));
    }, TIMEOUT_MS);

    try {
      client.postMessage(
        { type: "sw-request", port, path, httpRequest, httpRequestBytes: requestBytes.buffer },
        [channel.port2, requestBytes.buffer]
      );
    } catch (err) {
      settle(plainResponse(502, "Bad Gateway", "postMessage failed: " + (err && err.message)));
    }
  });
}
