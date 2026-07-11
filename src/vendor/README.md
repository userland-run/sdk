# Vendored NanoVM runtime

`nanovm.mjs` (+ `nanovm.d.mts`, `memfs.mjs`) is a **curated copy** of the browser
VM module from the `nano` repo (`nano/runners/riscv/host/nanovm.mjs`). The SDK vendors it so
it ships as one self-contained package instead of depending on the core repo's
layout.

## It is NOT a blind mirror

The vendored copy and the upstream container copy have legitimately diverged in
**both** directions, so you cannot `cp` one over the other:

- **vendor-only** — lazy catalog demand-fetch (`_lazyFiles`, `registerLazyFile`,
  `_maybeMaterializeLazy`, and its run-loop hook). The SDK installs catalog apps
  lazily; the bare container does not.
- **container-only** — the boa scripting engine (dynamic `import("./boa.mjs")`)
  and the live server-footer indicators (`_serverMode`, `_servingPort`,
  banner-port detection). The SDK exposes scripting through its own module and
  doesn't surface those UI indicators.
- Even the shared `_runLoop` differs in those container-only lines.

## What MUST stay in sync — and is enforced

The **shared mechanism** has to match exactly, or it drifts silently. That's how
this copy once lost the adaptive yield and ran ~9× slower (every run-loop yield
fell back to `setTimeout(0)`, which is clamped to ~4 ms).

`scripts/check-vendor.mjs` (run on `prebuild` + `pretest`, or `npm run check:vendor`)
fails if the shared core drifts. It checks:

- these methods are byte-identical (modulo comments/whitespace) to the container:
  `_fastYield`, `_adaptiveYield`, `snapshotApp`, `snapshot`, `restoreAndRun`;
- `_runLoop` yields **only** via `_adaptiveYield` — never a bare `setTimeout(0)`.

## Updating the vendor

When the container's VM changes:

1. Port the change into `nanovm.mjs` here — but **preserve the vendor-only
   lazy-fetch** and **don't pull in** the container-only boa/footer code.
2. If a *shared* method changed (the ones the guard checks), copy it verbatim.
3. Run `npm run check:vendor` until it's green, then `npm run build`.

If you add a new pure-mechanism method that both copies share, add it to
`SHARED_METHODS` in `scripts/check-vendor.mjs` so it's guarded too.
