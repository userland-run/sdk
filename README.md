# @userland-run/nano-sdk

A typed, layered TypeScript SDK over [NanoVM](https://github.com/userland-run/nano) — run real
Linux binaries (BusyBox, Node.js) in the browser. Drive them from code, from your own terminal UI,
or connect the browser to HTTP apps running inside the VM.

- **Code mode** — write files, run commands, read results.
- **Terminal mode** — a renderer-agnostic shell engine (cwd/env state, `sh` semantics, node routing).
- **Serve mode** — a service-worker bridge so a preview iframe can talk to in-VM HTTP servers.
- **Scripting mode** — a sandboxed, capability-scoped JavaScript engine (Boa) that drives the VM
  without a guest process: instant, no V8 boot, only the host functions you grant.
- **Worker transport** — host the VM in a Web Worker so it never blocks the UI thread.

ESM only, fully typed, zero runtime dependencies. The NanoVM runtime is vendored, so the package is
self-contained.

> 📚 **Documentation: <https://userland.run/docs/>** — SDK overview, embedded terminal, headless
> features, exec/fs/shell/serve/scripting/worker, the app catalog, provisioning, and the full API
> reference. See also [Part of userland.run](#part-of-userlandrun).

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

### Scripting mode (Boa)
```ts
const nano = await createNano({
  image: nanoImage({ baseUrl: "/nano/" }),
  scripting: { wasm: "/nano/boa.wasm" },   // loaded lazily on first use
});

// One-shot automation driving the VM (capability-scoped: read-only fs + run).
await nano.script(`
  for (const f of nano.fs.list("/project/src")) {
    const out = await nano.run("wc -l /project/src/" + f.name);
    nano.log(out.stdout.trim());
  }
`, { expose: { fs: "readonly", run: true } });

// Long-lived sandbox for untrusted plugins — no fs, no run, sync only.
const sandbox = await nano.scripting({ expose: { fs: "none", run: false }, syncOnly: true });
sandbox.registerFunction("emit", (event) => bus.publish(event));
sandbox.defineGlobal("VERSION", "1.4.2");
await sandbox.eval(pluginSource);
sandbox.dispose();
```

The `expose` config is the security boundary: a fresh engine has **no** ambient authority — only
the standard language plus what you grant. Same API in worker mode (`boa.wasm` loads in the worker
next to the VM; `registerFunction` callbacks are proxied back to the main thread). The shell routes a
leading `script ` line to the engine, e.g. `script "nano.fs.list('/').map(e => e.name).join(' ')"`.

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
- **Scripting needs `boa.wasm`.** `nano.scripting()` / `nano.script()` throw unless you pass
  `scripting: { wasm }` to `createNano`. Values cross the script boundary as JSON (binary via
  `fs.readFile`/`writeFile` is marshalled as byte arrays). In worker mode, script console output is
  streamed back combined (stdout+stderr) on the engine's `onStdout`.

## Testing

Two layers, both runnable from this repo:

```sh
npm test          # Node integration suite (node --test): boots the VM headless
                  # with crossOriginIsolation:"ignore" — code/vfs/shell/scripting/catalog
npm run smoke     # the same surface as a single standalone script (SMOKE_NODE=1 adds node)

npx playwright install chromium
npm run test:e2e       # browser suite: the real cross-origin-isolated SharedArrayBuffer path —
                       # boot, code, vfs, shell, serve (SW bridge), scripting, worker, catalog,
                       # plus deep Node-in-nano cases (cold + snapshot fast path, projects) and
                       # TypeScript compiling inside the VM
npm run test:e2e:fast  # skip the @heavy Node specs (BusyBox-only, seconds)
npm run test:e2e:node  # only the @heavy Node + dev-tool specs
```

The Playwright suite (`tests/e2e/`) builds the SDK, stages runtime fixtures from the sibling `nano`
repo (`scripts/sync-fixtures.mjs`), and drives a Vite-previewed harness with the COOP/COEP headers
the VM needs. See [the docs](https://userland.run/docs/) for the full API.

## Part of userland.run

This is one repo in the **[userland.run](https://userland.run)** workspace:

| Repo | What it is |
| ---- | ---------- |
| [nano](https://github.com/userland-run/nano) | The RV64GC → WASM emulator core this SDK vendors + drives |
| **[sdk](https://github.com/userland-run/sdk)** | `@userland-run/nano-sdk` — **this repo** |
| [terminal](https://github.com/userland-run/terminal) | `<nano-terminal>` web component, re-exported at `@userland-run/nano-sdk/terminal` |
| [catalog](https://github.com/userland-run/catalog) | Signed app marketplace (node, typescript, eslint, …) the SDK installs from |
| [website](https://github.com/userland-run/website) | Landing page + the hosted docs at [userland.run/docs](https://userland.run/docs/) |

## License

`MPL-2.0 OR LicenseRef-UEL` — dual-licensed. Use under the **Mozilla Public License 2.0** (the
open-source option, deliberately permissive so the SDK can be embedded broadly), or under the
**Userland Enterprise License** (a commercial option from And The Next GmbH). The vendored NanoVM
runtime is itself dual-licensed (AGPL-3.0 OR UEL); see [LICENSE.md](./LICENSE.md) and NOTICE.
