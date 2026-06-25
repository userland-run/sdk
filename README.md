# @userland-run/nano-sdk

A typed, layered TypeScript SDK over [NanoVM](https://github.com/userland-run/nano) — run real
Linux binaries (BusyBox, Node.js) in the browser. Drive them from code, from your own terminal UI,
or connect the browser to HTTP apps running inside the VM.

- **Code mode** — write files, run commands, read results.
- **Terminal mode** — a renderer-agnostic shell engine (cwd/env state, `sh` semantics, node routing).
- **Serve mode** — a service-worker bridge so a preview iframe can talk to in-VM HTTP servers.
- **Worker transport** — host the VM in a Web Worker so it never blocks the UI thread.

ESM only, fully typed, zero runtime dependencies. The NanoVM runtime is vendored, so the package is
self-contained.

## Install

```sh
npm install @userland-run/nano-sdk
```

## Requirements

NanoVM allocates a **shared** `WebAssembly.Memory`, which requires the page to be **cross-origin
isolated**:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp   (or: credentialless)
```

If you can't set headers (e.g. GitHub Pages), register the shipped service worker — it injects them.
`createNano()` throws a descriptive error when isolation is missing; bypass with
`crossOriginIsolation: "ignore"`.

## Quick start

### Code mode
```ts
import { createNano, nanoImage } from "@userland-run/nano-sdk";

const nano = await createNano({ image: nanoImage({ baseUrl: "/nano/", withNode: true }) });
nano.fs.writeFile("/app/data.txt", "1\n2\n3\n");
const { stdout } = await nano.shExec("sort -rn /app/data.txt | head -1");
```

### Terminal mode (in a worker)
```ts
import { createNanoWorker, Shell } from "@userland-run/nano-sdk";

const client = await createNanoWorker(config);
const shell = new Shell(client, { cwd: "/root" });
async function onEnter(line: string) {
  await shell.run(line, { onData: (c) => term.write(c) });
  renderPrompt(shell.cwd);
}
```

### Serve mode
```ts
import { createNano, ServeBridge, startServer, nanoImage } from "@userland-run/nano-sdk";

const nano = await createNano({ image: nanoImage({ baseUrl: "/nano/", withNode: true }) });
const bridge = await ServeBridge.register({ injector: nano.virtualServer, swUrl: "/nano-sw.js" });
nano.fs.writeFile("/srv/server.js", SERVER_SOURCE);
await startServer(nano, { node: ["/srv/server.js"] });
iframe.src = bridge.previewUrl(8080);
```

### Fast repeated Node
```ts
const rt = nano.nodeRuntime();
await rt.warmup();                 // one V8 boot
await rt.run("console.log(1 + 1)"); // fast restore
await rt.run("console.log(Date.now())");
```

## Consumer setup checklist

1. Serve cross-origin isolated, **or** register `nano-sw.js` (exported as `./service-worker`).
2. Host `nano.wasm` (and `images/busybox`, `images/node`, `build/devenv.tar.gz` for the small build).
3. For serve mode, copy `nano-sw.js` to your public root and pass its URL to `ServeBridge`.

The escape hatch: `nano.raw` is the underlying `NanoVM` instance. The SDK never hides capability.

## Notes & caveats

- **Combined output.** NanoVM funnels stdout and stderr into one stream; `ExecResult.stdout` is the
  combined output. Split via the shell's `captureStderr` (costs a redirect, loses live interleaving).
- **Servers don't resolve.** A listening server never resolves its run promise; use `startServer`
  (readiness by output regex, default `/listening/i`) and `stop()` to cancel.
- **RAM is auto-sized for Node.** V8 needs ~1.8GB of guest RAM to boot (512MB OOMs). When you omit
  `ramMB`, the SDK sizes it to keep guest RAM + the wasm's embedded binaries under the 2GB ceiling.
  BusyBox-only consumers can pass a smaller `ramMB` to shrink the footprint.
- **Node isolation.** Every `NodeRuntime.run` restores the *same* warm snapshot — runs don't see each
  other's mutations. Seed per-run inputs with `extraFiles`.
- **Warm-restore exit code.** `NodeRuntime.run` output is reliable, but its `exitCode` is not: V8's
  platform worker thread can't be joined after a snapshot restore, so node aborts (exit `134`) *after*
  printing correct output. Check `stdout`, not `exitCode`, for warm runs. Cold `nano.node()` exits cleanly.
- **Interactive stdin.** Beyond the original spec, the runtime supports interactive stdin; the SDK
  exposes `nano.writeStdin()` / `setInteractiveStdin()` / `closeStdin()`. Most "terminal" usage is
  still line-by-line command dispatch.

## License

GPL-3.0-or-later. This package vendors NanoVM (GPL-3.0). The copyright is held by the same party, so
relicensing is a rights-holder decision — see the spec's licensing section. Replace `LICENSE.md` with
the full GPLv3 text before publishing.
