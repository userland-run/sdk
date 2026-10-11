# @userland-run/nano-sdk

A typed TypeScript SDK over [NanoVM](https://github.com/userland-run/nano): run real Linux binaries
(BusyBox, Node.js) in the browser, plus WASI apps and sandboxed JavaScript, all over one shared
kernel and virtual filesystem. Drive it from code, wire up your own terminal UI, or serve in-VM
HTTP apps to a preview iframe.

ESM only, fully typed, no runtime dependencies. The NanoVM runtime is vendored, so the package is
self-contained.

> **Full documentation: <https://userland.run/docs/>**

## Install

```sh
npm install @userland-run/nano-sdk
```

## Requirements

NanoVM uses a **shared** `WebAssembly.Memory`, so the page must be **cross-origin isolated**:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp   (or: credentialless)
```

If you can't set headers (e.g. GitHub Pages), copy the shipped service worker
(`@userland-run/nano-sdk/service-worker`, i.e. `static/nano-sw.js`) to your public root and register
it. It injects the headers and also backs the serve bridge:

```ts
import { ensureCrossOriginIsolated } from "@userland-run/nano-sdk";

const isolated = await ensureCrossOriginIsolated({ swUrl: "/nano-sw.js" });
// false → no SW support, or the page is reloading once to pick up the headers
```

`registerNanoServiceWorker(opts)` is the lower-level variant; it returns
`{ registered, controlling, crossOriginIsolated, reloading }`. `createNano()` throws a descriptive
error when isolation is missing. Bypass the check with `crossOriginIsolation: "ignore"`, which is
useful in Node and tests.

## Images

| Wasm build | Contents | Use for |
| ---------- | -------- | ------- |
| `console.wasm` / `nano.busybox.wasm` | BusyBox embedded | terminals and BusyBox-only work (pass `ramMB` 256 to 512) |
| `nano.wasm` (slim) | emulator only | add ELFs as separate files, or install them from the catalog (`node`, `typescript`, …) |

```ts
import { createNano, nanoImage } from "@userland-run/nano-sdk";

const nano = await createNano({ image: { wasm: "/nano/nano.busybox.wasm" }, ramMB: 512 });

// Slim build plus separate ELFs: <baseUrl>/nano.wasm, images/busybox, images/node, build/devenv.tar.gz
const nano2 = await createNano({ image: nanoImage({ baseUrl: "/nano/", withNode: true }) });
```

`ImageConfig` is `{ wasm, busybox?, node?, overlays? }`. Each source can be a URL, an `ArrayBuffer`,
or a `Uint8Array`. Byte `busybox`/`node` need a browser (they become object URLs). Overlays are
`.tar.gz` archives unpacked at boot. When `ramMB` is omitted it is auto-sized for Node as
`2000 − wasmMB − 20` (a URL wasm is assumed to be about 138 MB), because V8 needs about 1.8 GB of
guest RAM.

## Runners

| Runner | What runs | How you reach it |
| ------ | --------- | ---------------- |
| **RISC-V VM** | RV64GC Linux ELFs: BusyBox, the node ELF, catalog `elf-app`s | `run`, `exec`, `shExec`, `node()` with `engines.node: "vm"` (the default) |
| **Node host engine ("nodert")** | Node programs on the browser's own JS engine (JIT speed), over the shared VFS | `engines.node: "host"` or `"auto"` |
| **Wasm** | `wasm32-wasip1` apps and services | catalog `wasm-app` / `wasm-service`, `registerWasmApp`, `execWasmApp` |
| **Boa** | sandboxed, capability-scoped JS (no guest process) | `scripting()` / `script()` |

```ts
const nano = await createNano({
  image,
  engines: { node: "auto", routing: { jest: "vm" } }, // pins match the entry script/bin basename
});
nano.resolveNodeEngine(["node_modules/.bin/jest"]); // "vm"
```

- `"vm"` (default) runs the RISC-V node ELF. It is the most faithful option and supports native addons.
- `"host"` runs on nodert. It rejects with `ERR_NODE_HOST_UNSUPPORTED` when a program needs something
  nodert can't provide, and with `ERR_NODE_HOST_RUNTIME_UNAVAILABLE` when the runtime can't load. The
  runtime is a vendored worker tree loaded from `dist/vendor/runners/node` or the site root
  `/vendor/runners/node`, and loading it needs a CSP that allows `'unsafe-eval'`.
- `"auto"` tries nodert and falls back to the VM on either of those errors.

## Exec

```ts
await nano.run("ls -la /bin");                       // one BusyBox command, whitespace-split, no shell
await nano.exec(["grep", "-n", "a b", "/f.txt"]);    // exact argv, quoted, via sh
await nano.shExec("sort -rn /app/data.txt | head -1"); // full sh line/script (pipes, redirects)
await nano.node(["/app/main.js"], { cwd: "/app", env: { DEBUG: "1" } });
```

All four return `ExecResult` `{ exitCode, stdout, cancelled? }`, where `stdout` holds stdout and
stderr combined. `ExecOptions`:

- `onData(chunk)` streams combined output.
- `maxSteps` is the instruction budget: 2M by default, 2e9 for `node()`.
- `cwd` / `env` apply to **`node()` only**; `run`/`exec`/`shExec` start at `/`. On the VM path they
  need `/usr/bin/node` in the VFS. With only an embedded node ELF they are ignored.

Interactive stdin is available through `writeStdin()`, `setInteractiveStdin()`, and `closeStdin()`.
`cancel()` stops the current run. `nano.raw` is the underlying `NanoVM`.

## Filesystem

`nano.fs` (`Vfs`) is synchronous on the main thread and async over the worker:
`writeFile(path, data, mode?)`, `readText`, `readFile`, `list`, `exists`, `walk`, `mkdir`, `remove`,
`move`, `copy`, `loadTarGz`.

## Shell

`Shell` is a renderer-agnostic line engine for your own terminal UI. It tracks cwd and env, uses `sh`
semantics, routes `node`, and sends a leading `script …` to Boa. It works over `Nano` or the worker
client.

```ts
const shell = nano.shell({ cwd: "/root" });
const r = await shell.run(line, { onData: (c) => term.write(c) }); // r.cwd, r.output
```

Pass `captureStderr: true` to split stderr. This costs a redirect and loses live interleaving.

## NodeRuntime

Use this for fast repeated Node: one V8 boot, then a snapshot restore per run.

```ts
const rt = nano.nodeRuntime();
await rt.warmup();
await rt.run("console.log(1 + 1)", { extraFiles: [{ path: "/in.json", content: "{}" }] });
rt.reset(); // drop the snapshot
```

Every run restores the **same** snapshot, so runs are isolated from each other. Read `stdout`, not
`exitCode`: warm runs can exit `134` after printing correct output.

## Scripting (Boa)

```ts
const nano = await createNano({ image, scripting: { wasm: "/nano/boa.wasm" } }); // lazy-loaded

await nano.script(`nano.fs.list("/").map(e => e.name).join(" ")`, { expose: { fs: "readonly" } });

const sandbox = await nano.scripting({
  expose: { fs: "none", run: false, node: false, webapis: ["console"] },
  limits: { loopIterations: 1e6, recursion: 256 },
  timeoutMs: 1000,
  syncOnly: true,
});
sandbox.registerFunction("emit", (e) => bus.publish(e));
sandbox.defineGlobal("VERSION", "1.4.2");
await sandbox.eval(pluginSource);
sandbox.dispose();
```

`expose` is the security boundary. A new engine has no capabilities until you grant them:

- `fs`: `"none"` (the default), `"readonly"`, or `"readwrite"`
- `run`: BusyBox `nano.run` / `sh` / `exec`
- `node`: the in-VM `nano.node`
- `webapis`: any of `console`, `encoding`, `url`, `timers`

`limits` caps loops and recursion. `timeoutMs` is a host watchdog that disposes the engine. Values
cross the boundary as JSON.

## Serve

```ts
import { ServeBridge, startServer } from "@userland-run/nano-sdk";

const bridge = await ServeBridge.register({ injector: nano.virtualServer, swUrl: "/nano-sw.js" });
const { stop } = await startServer(nano, { node: ["/srv/server.js"] }, { readyPattern: /listening/i });
iframe.src = bridge.previewUrl(8080, "/"); // => <sw scope>sw/8080/
```

`startServer` resolves when the server prints a line matching `readyPattern`, since a listening
server never exits. It accepts `{ node: [...] }` or `{ command: "sh line" }`. The worker client is
also a `ConnectionInjector`.

`nano.injectConnection` (which `nano.virtualServer` returns, so use either as the injector) routes
each request by the Kernel port table. A server that listens on another runner, such as a Node
server started with `nano.node()` on the host engine (`engines: { node: "host" }`), gets the
request over a Kernel loopback connection, the same path nodert's `net.connect` uses. Every other
port goes to the in-VM server. One bridge previews both kinds:

```ts
const nano = await createNano({ image, engines: { node: "host" } });
const bridge = await ServeBridge.register({ injector: nano, swUrl: "/nano-sw.js" });
void nano.node(["-e", 'require("http").createServer((q, s) => s.end("hi")).listen(3000)']);
iframe.src = bridge.previewUrl(3000); // served by the host-engine server
nano.listeners(); // => [{ port: 3000, ownerPid, kind: "node" }]
```

Loopback requests are sent with `Connection: close`, and the response ends when the server closes
the connection or the `Content-Length` is reached. `listeners()` lists the port table. A VM port
shows up there only after the VM has served on it. `startServer`'s `stop()` cancels VM runs. A
host-engine server keeps running until its process exits.

## Headless

`createHeadless({ wasmUrl?, ramMB?, serviceWorkerUrl? })` gives you the terminal's features without
the UI. It returns `vm`, `fs`, `catalog()`, `installApp`, `run`, `sh`,
`serve(launch, { port, readyPattern })` (which resolves to `{ url(path), stop }`), and `dispose()`.

## Worker

Run the VM in a Web Worker so it never blocks the UI thread. The client mirrors `Nano` with async
methods.

```ts
import { createNanoWorker } from "@userland-run/nano-sdk";

const client = await createNanoWorker(
  config,
  () => new Worker(new URL("@userland-run/nano-sdk/worker", import.meta.url), { type: "module" }),
  { transferBuffers: true }, // zero-copy, but DETACHES your ArrayBuffers
);
await client.shExec("echo hi", { onData: console.log });
await client.installApp("ripgrep", { onProgress: (e) => bar.update(e) });
await client.execWasmApp(["photon", "in.png", "out.png"], { cwd: "/work" });
await client.resolveNodeEngine(["app.js"]);
```

- Pass a `workerFactory` when you use a bundler. Without one, the default `new URL("./worker/worker.js", import.meta.url)` only resolves from the unbundled `dist/`.
- `onData`, `onProgress`, and scripting `registerFunction` callbacks are proxied back to the main thread.
- `client.fs`, `shell()`, `nodeRuntime()`, `scripting()`, `installBundle`, snapshot helpers
  (`setWarmup` / `warmup` / `loadSnapshot` / `restoreRun` / `restoreServe`), and `destroy()` are also
  available.

## Agent tools & WebMCP

Give an LLM agent a Linux sandbox. `@userland-run/nano-sdk/agent` (about 11 KB, no VM runtime inside)
turns a `Nano` or worker client into capability-scoped tools that any model can call. It also registers
them with the browser's built-in agent over [WebMCP](https://github.com/webmachinelearning/webmcp).

```ts
import { createVmTools, exposeWebMcp } from "@userland-run/nano-sdk/agent";

const tools = createVmTools(nano, {
  fs: "readwrite", // "none" | "readonly" (default) | "readwrite"
  exec: true,      // run_shell; also node, install, script (all default false)
  approve: async (call) => confirm(`${call.tool}: ${call.summary}`), // gates every non-read call
});
const unregister = exposeWebMcp(tools); // no-op where document.modelContext is missing
```

- Each tool is `{ name, description, inputSchema, kind, readOnly, execute }`. Map it to Claude or OpenAI
  tool definitions, an MCP server, or your own loop.
- `execute` resolves to `{ ok, output, data? }` and never throws. "VM is busy serving" and guest errors
  come back as text, and output is capped by `maxOutputChars` (default 32,000).
- Read tools: `list_dir`, `read_file`, `file_exists`, and `list_ports` (main-thread `Nano` only).
  Opt-in: `write_file` / `make_dir` / `move_path` / `delete_path`, `run_shell`, `run_node`, `install_app`,
  `run_script` (Boa). `prefix` namespaces the names when you expose several VMs.
- WebMCP tools carry `readOnlyHint` and `untrustedContentHint`. Treat tool output as untrusted: it can
  carry prompt injection.

Full guide: <https://userland.run/docs/sdk-agent/>

## Local folders

`@userland-run/nano-sdk/folder` copies a folder from the user's disk into the VM, tells you what changed,
and writes the changes back. Nothing is uploaded: files move between the browser's File System Access
handle and the VM's in-memory filesystem. It works with a `Nano`, a worker client, or a raw `NanoVM`
(for example `TerminalHandle.vm`).

```ts
import { mountFolder, zipFolder, isFileSystemAccessSupported } from "@userland-run/nano-sdk/folder";

const dir = await showDirectoryPicker({ mode: "readwrite" });
const folder = await mountFolder(nano, dir, {
  at: "/work",                                   // default
  maxBytes: 256 * 1024 * 1024,                   // default; checked before anything is copied
  include: (path) => !path.startsWith("node_modules/"), // directories end with "/"
  onProgress: (p) => console.log(p.phase, p.done, p.total),
});

await nano.shExec("cd /work && mkdir -p out && sort data.csv > out/sorted.csv");

await folder.diff();      // { added: ["out/sorted.csv"], changed: [], removed: [] }
await folder.writeBack(); // { written: ["out/sorted.csv"], deleted: [], failed: [], bytes }
```

- The snapshot taken at mount time stores a size and content hash per file. `diff()` compares the VM's
  copy against it, and `writeBack()` refreshes it.
- `writeBack({ onlyChanged = true, deleteRemoved = false, paths?, onProgress? })` writes only new and
  changed files by default. It never deletes a file on disk unless you pass `deleteRemoved: true`. It
  asks for `readwrite` permission when the handle doesn't have it yet (the prompt needs a user gesture).
- Errors: `FolderTooLargeError` (with `bytes`, `maxBytes`, `files`) and `FolderPermissionError`.
- Firefox and Safari have no directory picker. Use `<input type="file" webkitdirectory>` and
  `mountFiles(nano, input.files, { at })` instead. Paths come from `webkitRelativePath`, and such a mount
  can't write back, so offer a download instead.
- `zipFolder(nano, "/work/out", { compress = true })` returns a zip `Blob`. It deflates with
  `CompressionStream("deflate-raw")` where available and stores otherwise. There is no zip64, so the
  limits are 65,535 entries and 4 GiB. `folder.zip()` zips the mount itself.

## Tools

`@userland-run/nano-sdk/tools` runs a catalog app on a folder from the user's disk. A tool is a data-only
definition; the built-ins are `exif` (exifstrip), `pdf` (pdfcpu), `csv-sql` (sqlite3) and `imagemagick`
(magick on the RISC-V VM).

```html
<script type="module">
  import { defineNanoTool } from "@userland-run/nano-sdk/tools";
  defineNanoTool(); // <nano-tool>
</script>
<nano-tool tool="pdf" wasm-url="/nano.wasm" service-worker-url="/nano-sw.js" terminal url-params></nano-tool>
```

The element lets the user pick a folder (`showDirectoryPicker`, or `<input webkitdirectory>` where it's missing,
then results download as a zip), choose a preset, edit the generated command, and press Run. It boots a VM on the
first run, installs the tool's signed catalog apps, copies the folder to `/work` (`./folder`), runs the command,
lists new and changed files with previews, and saves them back (never deleting) or zips them. A trust panel counts
requests that leave the page's origin.

- Attributes: `tool`, `wasm-url`, `service-worker-url`, `ram-mb` (default 512), `terminal` (adds a Terminal tab
  with `<nano-terminal>` on the same folder, the command pre-typed), `no-terminal`, `preset`, `command`,
  `url-params` (read `?preset=` / `?cmd=` and offer a share link). A command from an attribute or URL is validated
  (one printable line that runs one of the tool's commands) and only pre-filled; nothing runs until Run is pressed.
- Properties: `definition` (a custom definition), `appSource` (async `(app) => Uint8Array` to register local builds
  instead of installing from the catalog, for development and tests), `loadTerminal` (for bundlers:
  `() => import("@userland-run/nano-sdk/terminal")`), `hostNotes` (labels for the trust panel).
- The host element mirrors `data-state` (`idle|running|done|error|stopped`), `data-exit` and `data-terminal`.
  Theme it with `--nano-tool-*` custom properties (`--nano-tool-bg`, `-fg`, `-text`, `-accent`, `-border`,
  `-font`, `-mono`, `-radius`, …).

Headless, with a folder from `./folder`:

```ts
import { runTool } from "@userland-run/nano-sdk/tools";
import { mountFolder } from "@userland-run/nano-sdk/folder";

const folder = await mountFolder(nano, dirHandle, { at: "/work" });
const r = await runTool(nano, { tool: "pdf", preset: "merge", values: { name: "all.pdf" }, folder, signal });
// r = { exitCode, output, command: "mkdir -p out && pdfcpu merge -c disable out/all.pdf *.pdf", changes, cancelled }
if (r.exitCode === 0) await folder.writeBack();
```

A definition is plain data, so a tool can be written for any catalog app:

```ts
const resize: ToolDefinition = {
  id: "thumbs",
  title: "Make thumbnails",
  apps: [{ ref: "imagemagick", command: "magick", tier: "riscv" }],
  accepts: ["jpg", "jpeg", "png"],
  stepsPerFile: 15e9, // RISC-V runs are instruction-bounded: budget = this × matching files
  presets: [{
    id: "thumb", label: "Thumbnails", description: "800 px JPEGs in out/.",
    fields: [{ id: "size", label: "Size", type: "number", default: 800, min: 16, max: 4000 }],
    command: 'mkdir -p out && for f in *.jpg; do magick "$f" -thumbnail {{size}}x{{size}} out/"$f"; done',
  }],
};
```

Command templates are expanded by a fixed engine (no code from the definition runs), and every value is
shell-quoted:

| placeholder | expands to |
| --- | --- |
| `{{field}}` | the field's value, quoted (numbers as digits) |
| `{{field? --flag}}` | ` --flag` when the checkbox is on / the value is non-empty |
| `{{files:pdf}}` | the matching files, each quoted |
| `{{each:csv:.import <path> <name>}}` | the text once per matching file, each quoted as one word; `<path>` is the file (double-quoted when needed), `<name>` an identifier from its stem |
| `{{first:csv:name}}` | first matching file's identifier (or `:path`) — for field defaults |

Field types: `text`, `textarea`, `number`, `select`, `checkbox`, `password`. A field with `env` is exported as
that environment variable for the run and can't be templated, so passwords never appear in the command, a share
link or the terminal history. `checkDefinition(def)` reports structural problems.

## Catalog

Install signed, content-addressed apps from the CDN:

```ts
await nano.installApp("ripgrep");                                          // eager
await nano.installApp("ripgrep@14.1.0", { lazy: true, onProgress: console.log }); // fetch on first open
await nano.installBundle("data");                                          // a topic bundle
await nano.run("rg --version");
```

- **Signatures.** Every index, manifest, bundle, and chunk is verified against the bundled catalog key
  (Ed25519 and SHA-256) before it touches the VFS.
- **Rollback protection.** The client remembers the highest signed index `generation` it has seen,
  per origin and key, and rejects older ones. The default store uses `localStorage` and falls back to
  memory. Override it with `CatalogOptions.generations`.
- **Caching.** Chunks are cached in OPFS (with a memory fallback).
- **Wasm apps.** `wasm-app` and `wasm-service` apps are always installed eagerly and registered with
  their runner automatically.
- **Tiers.** `Catalog` exposes `index()`, `manifest()`, `categories()`, and `collections()`.
  `manifestTier()` / `kindToTier()` map an app to its runner (`riscv` / `node` / `wasm` / `boa`).

## Provision

`provision(catalog, ref, { wasm, swUrl, workerFactory, … })` starts a worker VM, installs the app plus
the dependencies listed in its signed recipe, and builds a warm snapshot (or loads a prebuilt one
through `snapshotFetcher`). It returns `{ client, run(file), evalCode(code), serve(file, { port }), sh }`.

## Terminal

The UI ships as a separate subpath, so headless users never download it:

```ts
import { defineNanoTerminal, createTerminal } from "@userland-run/nano-sdk/terminal";

defineNanoTerminal(); // <nano-terminal>
const term = await createTerminal("#app", {
  wasmUrl: "/nano.wasm",           // default
  ramMB: 1800,                     // default
  fontPx: 12,                      // default
  shellCommand: "sh -i",           // default
  serviceWorkerUrl: "/nano-sw.js", // default
  features: { catalog: true, palette: true, files: true, editor: true, preview: { ports: [8080, 3000], defaultPort: 3000 } },
});
await term.installApp("node", { quiet: true });
term.openFile("/root/app.js"); term.showPreview(3000); term.refreshFiles(); term.dispose();
```

```html
<nano-terminal wasm-url="/nano/console.wasm" ram-mb="512" font-px="13"
               shell-command="sh -i" service-worker-url="/nano-sw.js"
               no-catalog no-palette no-files no-editor no-preview></nano-terminal>
```

All features are on by default. The element's `config` property overrides its attributes,
`el.ready` resolves to the handle, and removing the element disposes it.

## Behavior notes

- **VM ops are serialized.** A NanoVM runs one thing at a time, so `run`, `shExec`, `node` (VM),
  fs mutations, and snapshots queue in FIFO order. Use `nano.withVmLock(fn)` to wrap direct `nano.raw`
  use.
- **A server holds the VM.** While a `startServer` / `restoreServe` launch runs, other VM calls reject
  immediately with "VM is busy serving" until `stop()` / `cancel()`. Use a second instance for
  concurrent work.
- **Combined output.** stdout and stderr share one stream.
- **Error codes.** `ERR_NODE_HOST_UNSUPPORTED` and `ERR_NODE_HOST_RUNTIME_UNAVAILABLE` are set on
  `err.code`. Catalog failures throw `catalog: …` errors: signature, hash, or a possible rollback.

## Testing

```sh
NANO_WASM=../nano/wasm/nano.busybox.wasm npm test  # node --test integration suite (headless VM)
npm run test:e2e                                   # Playwright, real cross-origin-isolated browser
```

## Part of userland.run

| Repo | What it is |
| ---- | ---------- |
| [nano](https://github.com/userland-run/nano) | The multi-runner platform (RV64GC emulator + node/wasm/boa) this SDK vendors |
| **[sdk](https://github.com/userland-run/sdk)** | `@userland-run/nano-sdk`: **this repo** |
| [terminal](https://github.com/userland-run/terminal) | `<nano-terminal>`, re-exported at `@userland-run/nano-sdk/terminal` |
| [catalog](https://github.com/userland-run/catalog) | Signed app marketplace the SDK installs from |
| [website](https://github.com/userland-run/website) | Landing page + docs at [userland.run/docs](https://userland.run/docs/) |

## License

`MPL-2.0 OR LicenseRef-UEL`. You can use the SDK under the **Mozilla Public License 2.0** or under the
commercial **Userland Enterprise License** from And The Next GmbH. The vendored NanoVM runtime is
licensed `AGPL-3.0 OR UEL`. See [LICENSE.md](./LICENSE.md) and [NOTICE](./NOTICE).
