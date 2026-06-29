// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// Service-worker bootstrap. NanoVM needs SharedArrayBuffer, which requires the
// page to be cross-origin isolated (COOP/COEP). On static hosts where you can't
// set response headers (GitHub Pages, etc.), the shipped service worker
// (`./service-worker` → nano-sw.js) injects those headers — but a service
// worker can only do that for navigations it controls, so the *first* visit must
// register it and reload once before isolation kicks in. This helper does that
// (register → activate → reload-once), so consumers don't hand-roll it.

export interface RegisterServiceWorkerOptions {
  /** URL of the shipped service worker (the SDK's `./service-worker` export). */
  swUrl: string;
  /** SW scope; defaults to the SW's own directory. */
  scope?: string;
  /**
   * Reload the page once when the SW isn't yet controlling, so its COOP/COEP
   * header injection applies. Default true. A sessionStorage guard prevents a
   * reload loop if isolation still can't be achieved.
   */
  reloadIfUncontrolled?: boolean;
}

export interface ServiceWorkerStatus {
  /** The SW registered successfully (false if SWs are unavailable). */
  registered: boolean;
  /** The SW is controlling this page. */
  controlling: boolean;
  /** The page is cross-origin isolated (SharedArrayBuffer is usable). */
  crossOriginIsolated: boolean;
  /** A one-time reload was triggered; the caller should stop and let it reload. */
  reloading: boolean;
}

const RELOAD_GUARD = "nano-sw-reloaded";

const isolated = (): boolean =>
  typeof globalThis !== "undefined" &&
  (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;

/**
 * Register the NanoVM service worker and, on first visit, reload once so the page
 * becomes cross-origin isolated. Returns the resulting {@link ServiceWorkerStatus}.
 * When `reloading` is true the page is navigating away — halt and let it reload.
 */
export async function registerNanoServiceWorker(
  opts: RegisterServiceWorkerOptions,
): Promise<ServiceWorkerStatus> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return { registered: false, controlling: false, crossOriginIsolated: isolated(), reloading: false };
  }

  const swUrl = opts.swUrl;
  const scope = opts.scope ?? new URL("./", new URL(swUrl, location.href)).pathname;
  const reloadIfUncontrolled = opts.reloadIfUncontrolled ?? true;

  const wasControlled = !!navigator.serviceWorker.controller;

  let reg: ServiceWorkerRegistration;
  try {
    reg = await navigator.serviceWorker.register(swUrl, { scope, updateViaCache: "none" });
  } catch (err) {
    console.warn("[nano-sdk] service worker registration failed:", err);
    return { registered: false, controlling: false, crossOriginIsolated: isolated(), reloading: false };
  }
  if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
  await navigator.serviceWorker.ready;

  // First visit: the SW didn't control the initial navigation, so its COOP/COEP
  // headers weren't applied — reload once (guarded) to pick them up.
  if (!wasControlled && reloadIfUncontrolled && !sessionStorage.getItem(RELOAD_GUARD)) {
    sessionStorage.setItem(RELOAD_GUARD, "1");
    location.reload();
    return { registered: true, controlling: false, crossOriginIsolated: false, reloading: true };
  }
  sessionStorage.removeItem(RELOAD_GUARD);

  // Required, or sw-request messages from the SW queue forever (used by ServeBridge).
  navigator.serviceWorker.startMessages();

  return {
    registered: true,
    controlling: !!navigator.serviceWorker.controller,
    crossOriginIsolated: isolated(),
    reloading: false,
  };
}

/**
 * Convenience over {@link registerNanoServiceWorker}: returns true once the page
 * is cross-origin isolated (after any one-time reload), false if it can't be (no
 * SW support, or a reload is in progress — in which case stop and let it reload).
 */
export async function ensureCrossOriginIsolated(
  opts: RegisterServiceWorkerOptions,
): Promise<boolean> {
  if (isolated()) {
    // Already isolated (headers set by host or a prior visit) — still register the
    // SW so the serve bridge can route requests, but never reload.
    await registerNanoServiceWorker({ ...opts, reloadIfUncontrolled: false });
    return true;
  }
  const status = await registerNanoServiceWorker(opts);
  return status.reloading ? false : status.crossOriginIsolated;
}
