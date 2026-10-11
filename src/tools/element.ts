// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * `<nano-tool>` — a framework-free web component that runs a tool definition
 * on a folder from the user's disk, inside the page:
 *
 *   1. pick a folder (showDirectoryPicker, or <input webkitdirectory> where the
 *      File System Access API is missing — results then download as a zip);
 *   2. choose a preset; its command appears in an editable box (`preset` /
 *      `command` attributes, or `url-params` for ?preset=&cmd= share links,
 *      pre-fill it — validated, and never run until the user presses Run);
 *   3. Run: boot a NanoVM (lazily), install the tool's signed catalog apps,
 *      copy the folder to /work, run the command; Cancel stops it;
 *   4. results with image / PDF / text previews; Save to folder (write back new
 *      and changed files — never deletes) or Download zip;
 *   5. a trust panel counting requests that leave the page's origin;
 *   6. optional Terminal tab (`terminal` attribute): <nano-terminal> on the same
 *      folder, the command pre-typed.
 *
 * Attributes: tool, wasm-url, service-worker-url, ram-mb, terminal, no-terminal,
 * preset, command, url-params. Properties: definition (a custom
 * ToolDefinition), appSource, loadTerminal, hostNotes. Host attributes
 * data-state (idle|running|done|error|stopped), data-exit, data-terminal
 * mirror the run for styling and tests. Theme via CSS custom properties
 * (--nano-tool-*), see STYLES.
 *
 * Nothing touches the DOM at import time: the class is created by
 * {@link defineNanoTool}, and the VM runtime is imported on the first Run.
 */

import { mountFiles, mountFolder, MountedFolder } from "../folder/mount";
import { zipFolder } from "../folder/zip";
import type { FolderTarget, FsDirHandleLike } from "../folder/types";
import { installToolApps, resolveTool, runTool, type ToolAppSource, type ToolNano } from "./run";
import { envExports, expandCommand, fieldError, resolveValues, toolApps, validateCommand } from "./template";
import type { ToolDefinition, ToolField, ToolPreset, ToolValue, ToolValues } from "./types";

type State = "idle" | "running" | "done" | "error" | "stopped";

interface Picked {
  kind: "handle" | "files";
  name: string;
  handle?: FsDirHandleLike;
  files?: File[];
  paths: string[];
  bytes: number;
}

interface ResultFile {
  path: string;
  size: number;
  status: "added" | "changed";
  url: string;
  kind: "image" | "pdf" | "text" | "other";
  text?: string;
}

interface TerminalHandleLike {
  vm: { writeStdin(data: string): void; addFile(path: string, content: string | Uint8Array, mode?: number): void };
  dispose(): void;
}

/** Loads the terminal subpath (`@userland-run/nano-sdk/terminal`). */
export type TerminalLoader = () => Promise<{ defineNanoTerminal: (tag?: string) => void }>;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
const TEXT_EXT = /\.(csv|tsv|txt|json|md|sql|log|xml|html?)$/i;
const MIRROR = 'pre[aria-label="Terminal screen"]';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Strip sqlite3's harmless "no home directory" notice. */
function cleanOutput(s: string): string {
  return s.replace(/^.*cannot find home directory.*(\r?\n|$)/gm, "");
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "text") e.textContent = String(v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c != null && c !== false) e.append(c);
  return e;
}

async function listHandle(dir: FsDirHandleLike, rel = "", out = { paths: [] as string[], bytes: 0 }) {
  for await (const [name, h] of dir.entries()) {
    const p = rel ? `${rel}/${name}` : name;
    if (h.kind === "directory") await listHandle(h, p, out);
    else {
      out.paths.push(p);
      out.bytes += (await h.getFile()).size;
    }
  }
  return out;
}

function relPaths(files: File[]): string[] {
  const parts = files.map((f) => (f.webkitRelativePath || f.name).split("/").filter(Boolean));
  const top = parts[0]?.[0];
  const strip = !!top && parts.every((p) => p.length > 1 && p[0] === top);
  return parts.map((p) => (strip ? p.slice(1) : p).join("/"));
}

/** Native dynamic import, hidden from bundlers (for the default terminal loader). */
function nativeImport(url: string): Promise<unknown> {
  return (new Function("u", "return import(u)") as (u: string) => Promise<unknown>)(url);
}

export const STYLES = `
:host {
  --nano-tool-bg: #16161a; --nano-tool-surface: #1d1d22; --nano-tool-code-bg: #101013;
  --nano-tool-fg: #ececf1; --nano-tool-text: #d4d4dc; --nano-tool-muted: #9b9ba4; --nano-tool-faint: #74747d;
  --nano-tool-border: #2c2c33; --nano-tool-border-strong: #3a3a42; --nano-tool-accent: #a984f5;
  --nano-tool-accent-hover: #b99af7; --nano-tool-on-accent: #120d1d; --nano-tool-accent-tint: rgba(169,132,245,.08);
  --nano-tool-warn: #f0b45a; --nano-tool-ok: #5fd38d; --nano-tool-radius: 14px;
  --nano-tool-font: system-ui, -apple-system, "Segoe UI", sans-serif;
  --nano-tool-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  display: block; color: var(--nano-tool-text); font-family: var(--nano-tool-font); font-size: 14px;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.box { padding: 18px 18px 20px; border: 1px solid var(--nano-tool-border); border-radius: var(--nano-tool-radius);
  background: linear-gradient(180deg, var(--nano-tool-accent-tint), transparent 160px), var(--nano-tool-bg); }
@media (max-width: 640px) { .box { padding: 14px 12px 16px; } }
code { font-family: var(--nano-tool-mono); }
.dev { margin: 0 0 12px; padding: 8px 12px; border: 1px dashed var(--nano-tool-warn); border-radius: 8px;
  font: 12px var(--nano-tool-mono); color: var(--nano-tool-warn); }
.tabs { display: flex; gap: 4px; margin: 0 0 14px; border-bottom: 1px solid var(--nano-tool-border); }
.tab { font: 12.5px var(--nano-tool-mono); padding: 8px 14px; background: none; border: 0; border-bottom: 2px solid transparent;
  color: var(--nano-tool-muted); cursor: pointer; margin-bottom: -1px; }
.tab[aria-selected="true"] { color: var(--nano-tool-fg); border-bottom-color: var(--nano-tool-accent); }
.tab:disabled { opacity: .5; cursor: default; }
.step { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 12px; padding: 12px 0; }
.step + .step { border-top: 1px solid var(--nano-tool-border); }
.num { width: 24px; height: 24px; border-radius: 99px; border: 1px solid var(--nano-tool-accent); color: var(--nano-tool-accent);
  font: 12px var(--nano-tool-mono); display: flex; align-items: center; justify-content: center; }
.title { font-weight: 600; font-size: 15px; color: var(--nano-tool-fg); margin: 2px 0 10px; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 8px 0 0; }
button.primary, button.btn, label.primary { font: 12.5px var(--nano-tool-mono); padding: 8px 14px; border-radius: 8px;
  border: 1px solid var(--nano-tool-border-strong); cursor: pointer; display: inline-block; }
.primary { background: var(--nano-tool-accent); border-color: var(--nano-tool-accent) !important; color: var(--nano-tool-on-accent); font-weight: 600 !important; }
.primary:hover:not(:disabled) { background: var(--nano-tool-accent-hover); }
.btn { background: var(--nano-tool-surface); color: var(--nano-tool-muted); }
.btn:hover:not(:disabled) { color: var(--nano-tool-fg); }
button:disabled { opacity: .5; cursor: default; }
.linkish { font-size: 13px; color: var(--nano-tool-accent); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
label.primary, .linkish { position: relative; }
label.primary:focus-within, .linkish:focus-within, button:focus-visible, input:focus-visible, textarea:focus-visible {
  outline: 2px solid var(--nano-tool-accent); outline-offset: 2px; }
.file-input { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; }
.summary { margin: 10px 0 0; font-size: 13.5px; color: var(--nano-tool-muted); overflow-wrap: anywhere; }
.summary strong { color: var(--nano-tool-fg); }
.warn { color: var(--nano-tool-warn); }
.presets { display: flex; flex-wrap: wrap; gap: 6px; }
.preset { font: inherit; font-size: 13px; padding: 7px 12px; border-radius: 99px; border: 1px solid var(--nano-tool-border-strong);
  background: var(--nano-tool-surface); color: var(--nano-tool-text); cursor: pointer; }
.preset[aria-checked="true"] { border-color: var(--nano-tool-accent); background: var(--nano-tool-accent-tint); color: var(--nano-tool-fg); }
.desc { margin: 10px 0 12px; font-size: 14px; line-height: 1.6; }
.fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px 16px; margin: 0 0 14px; }
.field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.field.wide { grid-column: 1 / -1; }
.label { display: block; font: 11.5px var(--nano-tool-mono); letter-spacing: .04em; color: var(--nano-tool-faint); margin: 0 0 4px; }
.check { display: flex; align-items: center; gap: 8px; font-size: 14px; margin-top: 4px; }
.input, .command { width: 100%; padding: 8px 10px; border: 1px solid var(--nano-tool-border-strong); border-radius: 8px;
  background: var(--nano-tool-code-bg); color: var(--nano-tool-text); font: 13px var(--nano-tool-mono); }
.input[aria-invalid="true"] { border-color: var(--nano-tool-warn); }
.command { display: block; padding: 12px 14px; line-height: 1.6; resize: vertical; }
.help { font-size: 12px; line-height: 1.45; color: var(--nano-tool-faint); }
.notice { margin: 10px 0 0; padding: 8px 12px; border-left: 2px solid var(--nano-tool-warn); font-size: 13.5px; background: var(--nano-tool-surface); }
.status { font: 12px var(--nano-tool-mono); color: var(--nano-tool-faint); min-width: 0; overflow-wrap: anywhere; }
.error { margin: 10px 0 0; font-size: 13.5px; color: var(--nano-tool-warn); overflow-wrap: anywhere; }
.saved { margin: 10px 0 0; font-size: 13.5px; color: var(--nano-tool-ok); overflow-wrap: anywhere; }
.progress { position: relative; height: 3px; margin-top: 10px; border-radius: 99px; background: var(--nano-tool-border); overflow: hidden; }
.bar { height: 100%; background: var(--nano-tool-accent); transition: width .2s linear; }
.indet { position: absolute; inset: 0 auto 0 0; width: 30%; background: var(--nano-tool-accent); animation: indet 1.2s ease-in-out infinite; }
@keyframes indet { from { left: -30%; } to { left: 100%; } }
@media (prefers-reduced-motion: reduce) { .indet { animation: none; width: 100%; opacity: .5; } }
.output { margin: 12px 0 0; padding: 14px 16px; max-height: 360px; overflow: auto; border: 1px solid var(--nano-tool-border);
  border-radius: 12px; background: var(--nano-tool-code-bg); font: 12.5px/1.6 var(--nano-tool-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.results { list-style: none; margin: 14px 0 0; padding: 0; display: grid; gap: 10px; }
.result { padding: 10px 12px; border: 1px solid var(--nano-tool-border); border-radius: 10px; background: var(--nano-tool-surface); min-width: 0; }
.rhead { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.rname { font: 13px var(--nano-tool-mono); color: var(--nano-tool-accent); overflow-wrap: anywhere; }
.badge { font: 11px var(--nano-tool-mono); padding: 3px 6px; border-radius: 5px; border: 1px solid var(--nano-tool-border-strong); color: var(--nano-tool-muted); }
.badge.warn { color: var(--nano-tool-warn); }
.linkbtn { background: none; border: 0; padding: 0; font: 12px var(--nano-tool-mono); color: var(--nano-tool-accent); text-decoration: underline; cursor: pointer; }
.thumb { display: block; max-width: 100%; max-height: 220px; margin-top: 8px; border-radius: 8px; border: 1px solid var(--nano-tool-border); }
.textpre { margin: 8px 0 0; max-height: 180px; overflow: auto; padding: 8px 10px; border-radius: 8px; background: var(--nano-tool-code-bg);
  font: 12px var(--nano-tool-mono); white-space: pre; }
.pdf { display: block; width: 100%; height: 420px; margin-top: 8px; border: 1px solid var(--nano-tool-border-strong); border-radius: 8px; background: #fff; }
.termhost { height: 440px; margin-top: 10px; }
.trust { margin-top: 16px; padding: 12px 14px; border: 1px solid var(--nano-tool-border); border-radius: 10px; background: var(--nano-tool-code-bg);
  font-size: 13px; color: var(--nano-tool-muted); }
.trust strong { color: var(--nano-tool-fg); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 99px; background: var(--nano-tool-ok); margin-right: 6px; }
.trust ul { margin: 8px 0 0; padding-left: 18px; font-size: 12.5px; }
.trust p { margin: 8px 0 0; font-size: 12.5px; line-height: 1.55; color: var(--nano-tool-faint); }
`;

/** Register `<nano-tool>` (idempotent; a no-op outside the browser). Returns the class. */
export function defineNanoTool(tag = "nano-tool"): CustomElementConstructor | undefined {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined") return undefined;
  const existing = customElements.get(tag);
  if (existing) return existing;
  const cls = createElementClass();
  customElements.define(tag, cls);
  return cls;
}

function createElementClass(): CustomElementConstructor {
  return class NanoToolElement extends HTMLElement {
    static get observedAttributes() {
      return ["tool"];
    }

    /** A custom definition (overrides the `tool` attribute). */
    definition: ToolDefinition | null = null;
    /** Register app bytes from here instead of installing from the signed catalog (dev/test, self-hosting). */
    appSource: ToolAppSource | null = null;
    /** How to load `@userland-run/nano-sdk/terminal` (bundlers: `() => import("@userland-run/nano-sdk/terminal")`). */
    loadTerminal: TerminalLoader | null = null;
    /** Notes shown next to hosts in the trust panel ({ "api.github.com": "star counter" }). */
    hostNotes: Record<string, string> = {};

    private root!: ShadowRoot;
    private def!: ToolDefinition;
    private picked: Picked | null = null;
    private presetId = "";
    private values: Record<string, ToolValues> = {};
    private command = "";
    private commandEdited = false;
    private notice: string | null = null;
    private state: State = "idle";
    private exitCode: number | null = null;
    private phase: string | null = null;
    private frac: number | null = null;
    private output = "";
    private error: string | null = null;
    private saved: string | null = null;
    private results: ResultFile[] = [];
    private previewPdf: string | null = null;
    private hosts: Record<string, number> = {};
    private tab: "run" | "terminal" = "run";
    private ac: AbortController | null = null;
    private nano: (ToolNano & { destroy(): void; fs: unknown }) | null = null;
    private booting: Promise<ToolNano & { destroy(): void }> | null = null;
    private folder: MountedFolder | null = null;
    private term: { handle: TerminalHandleLike | null; el: HTMLElement | null; folder: MountedFolder | null; vm: unknown; dispose(): void } | null = null;
    private termState: "off" | "booting" | "ready" | "error" = "off";
    private termMsg: string | null = null;
    private termSaved: string | null = null;
    private observer: PerformanceObserver | null = null;
    private seen = new WeakSet<PerformanceEntry>();
    private connected = false;

    connectedCallback() {
      if (this.connected) return;
      this.connected = true;
      this.root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
      this.loadDefinition();
      this.readInitialCommand();
      this.startObserver();
      this.render();
      this.setState(this.state);
    }

    disconnectedCallback() {
      this.connected = false;
      this.ac?.abort();
      this.observer?.disconnect();
      this.disposeTerminal();
      this.teardownVm();
      this.clearResults();
    }

    attributeChangedCallback() {
      if (!this.connected) return;
      this.loadDefinition();
      this.render();
    }

    // --- definition / form state ---------------------------------------------

    private loadDefinition() {
      const def = this.definition ?? resolveTool(this.getAttribute("tool") ?? "");
      if (this.def !== def) {
        this.def = def;
        this.presetId = def.presets[0]!.id;
        this.values = {};
        this.commandEdited = false;
      }
    }

    private get preset(): ToolPreset {
      return this.def.presets.find((p) => p.id === this.presetId) ?? this.def.presets[0]!;
    }

    private ctx() {
      return { files: this.picked?.paths ?? this.def.examples?.files ?? [] };
    }

    private fieldValues(): ToolValues {
      return resolveValues(this.preset, this.values[this.preset.id], this.ctx());
    }

    private generated(): string {
      try {
        return expandCommand(this.preset, this.fieldValues(), this.ctx());
      } catch (e) {
        return `# ${(e as Error).message}`;
      }
    }

    private readInitialCommand() {
      const params = this.hasAttribute("url-params") ? new URLSearchParams(location.search) : null;
      const preset = this.getAttribute("preset") ?? params?.get("preset");
      if (preset && this.def.presets.some((p) => p.id === preset)) this.presetId = preset;
      const cmd = this.getAttribute("command") ?? params?.get("cmd");
      if (cmd != null) {
        const ok = validateCommand(this.def, cmd);
        if (ok) {
          this.command = ok;
          this.commandEdited = true;
          this.notice = "This command came from a shared link. Read it before you press Run — nothing runs until you do.";
        } else {
          this.notice = `Ignored the command in the link: it must be one line that runs ${toolApps(this.def).map((a) => a.command).join(" or ")}.`;
        }
      }
    }

    private currentCommand(): string {
      return this.commandEdited ? this.command : this.generated();
    }

    private fieldsOk(): boolean {
      const v = this.fieldValues();
      return (this.preset.fields ?? []).every((f) => !fieldError(f, v[f.id]));
    }

    private setState(s: State) {
      this.state = s;
      this.dataset.state = s;
      if (this.exitCode == null) delete this.dataset.exit;
      else this.dataset.exit = String(this.exitCode);
      this.dataset.terminal = this.termState;
    }

    // --- trust panel -----------------------------------------------------------

    private startObserver() {
      if (typeof PerformanceObserver === "undefined" || typeof performance === "undefined") return;
      const add = (entries: PerformanceEntryList) => {
        let changed = false;
        for (const e of entries) {
          if (this.seen.has(e)) continue;
          this.seen.add(e);
          let u: URL;
          try {
            u = new URL(e.name, location.href);
          } catch {
            continue;
          }
          if (!/^https?:$/.test(u.protocol) || u.origin === location.origin) continue;
          this.hosts[u.host] = (this.hosts[u.host] ?? 0) + 1;
          changed = true;
        }
        if (changed && this.connected) this.renderTrust();
      };
      add(performance.getEntriesByType("resource"));
      try {
        this.observer = new PerformanceObserver((list) => add(list.getEntries()));
        this.observer.observe({ type: "resource", buffered: false });
      } catch {
        this.observer = null;
      }
    }

    // --- VM ----------------------------------------------------------------------

    private async ensureVm(onPhase: (s: string) => void): Promise<ToolNano & { destroy(): void }> {
      if (this.nano) return this.nano;
      if (!this.booting) {
        this.booting = (async () => {
          onPhase("loading the runtime…");
          const sdk = await import("../index");
          const swUrl = this.getAttribute("service-worker-url") ?? "/nano-sw.js";
          if (!globalThis.crossOriginIsolated) {
            onPhase("enabling cross-origin isolation…");
            const ok = await sdk.ensureCrossOriginIsolated({ swUrl });
            if (!ok) throw new Error("this page is not cross-origin isolated (reloading to enable it)");
          }
          onPhase("booting NanoVM…");
          const nano = await sdk.createNano({
            image: { wasm: this.getAttribute("wasm-url") ?? "/nano.wasm" },
            ramMB: Number(this.getAttribute("ram-mb") ?? 512) || 512,
          });
          this.nano = nano as unknown as ToolNano & { destroy(): void; fs: unknown };
          return this.nano;
        })();
        this.booting.catch(() => (this.booting = null));
      }
      return this.booting;
    }

    private teardownVm() {
      const n = this.nano;
      this.nano = null;
      this.booting = null;
      this.folder = null;
      try {
        n?.destroy();
      } catch {
        /* ignore */
      }
    }

    // --- actions -----------------------------------------------------------------

    private async pickFolder() {
      this.error = null;
      try {
        const h = await (globalThis as unknown as { showDirectoryPicker(o: object): Promise<FsDirHandleLike> }).showDirectoryPicker({
          mode: "readwrite",
          id: "nano-tool",
        });
        const { paths, bytes } = await listHandle(h);
        paths.sort();
        this.setPicked({ kind: "handle", name: h.name, handle: h, paths, bytes });
      } catch (e) {
        if ((e as { name?: string })?.name === "AbortError") return;
        this.error = e instanceof Error ? e.message : String(e);
        this.render();
      }
    }

    private onFiles(list: FileList | null) {
      if (!list?.length) return;
      const files = Array.from(list);
      const top = (files[0]?.webkitRelativePath || "").split("/")[0] || "selected files";
      this.setPicked({ kind: "files", name: top, files, paths: relPaths(files), bytes: files.reduce((n, f) => n + f.size, 0) });
    }

    private setPicked(p: Picked) {
      if (this.term) this.closeTerminal();
      this.picked = p;
      this.clearResults();
      this.exitCode = null;
      this.output = "";
      this.setState("idle");
      this.render();
    }

    private setField(f: ToolField, v: ToolValue) {
      const id = this.preset.id;
      this.values[id] = { ...(this.values[id] ?? {}), [f.id]: v };
      if (!this.commandEdited) this.command = this.generated();
      this.render(f.id);
    }

    private clearResults() {
      for (const r of this.results) URL.revokeObjectURL(r.url);
      this.results = [];
      this.previewPdf = null;
      this.saved = null;
    }

    private async run() {
      const picked = this.picked;
      if (!picked || this.state === "running") return;
      if (this.term) this.closeTerminal(false);
      this.ac?.abort();
      const ac = new AbortController();
      this.ac = ac;
      this.output = "";
      this.error = null;
      this.exitCode = null;
      this.clearResults();
      this.setState("running");
      const progress = (label: string, frac: number | null) => {
        this.phase = label;
        this.frac = frac;
        this.renderStatus();
      };
      const append = (chunk: string) => {
        this.output += chunk;
        this.renderOutput();
      };
      this.render();
      try {
        const nano = await this.ensureVm((s) => progress(s, null));
        if (ac.signal.aborted) throw new Error("stopped");
        await runToolApps(this.def, this.appSource, nano, progress, append);
        progress("copying your folder into the sandbox…", 0);
        await nano.shExec("rm -rf /work; mkdir -p /work");
        const opts = {
          at: "/work",
          maxBytes: this.def.maxBytes,
          onProgress: (p: { phase: string; done: number; total: number }) => {
            if (p.phase === "copy") progress(`copying ${p.done}/${p.total} files into the sandbox…`, p.total ? p.done / p.total : null);
          },
        };
        const target = nano as unknown as FolderTarget;
        const folder = picked.kind === "handle" ? await mountFolder(target, picked.handle!, opts) : await mountFiles(target, picked.files!, opts);
        this.folder = folder;
        const command = this.currentCommand();
        append(`$ ${command}\n`);
        const r = await runTool(nano, {
          tool: this.def,
          preset: this.preset.id,
          values: this.values[this.preset.id],
          command: this.commandEdited ? command : undefined,
          files: picked.paths,
          folder,
          appSource: this.appSource ?? undefined,
          signal: ac.signal,
          onOutput: append,
          onProgress: (p) => progress(p.label, p.fraction),
        });
        const files: ResultFile[] = [];
        const read = (p: string) => (nano as unknown as { fs: { readFile(p: string): Uint8Array | null } }).fs.readFile(`/work/${p}`);
        for (const [list, status] of [
          [r.changes?.added ?? [], "added"],
          [r.changes?.changed ?? [], "changed"],
        ] as const) {
          for (const rel of list) {
            const bytes = read(rel);
            if (!bytes) continue;
            const kind = IMAGE_EXT.test(rel) ? "image" : /\.pdf$/i.test(rel) ? "pdf" : TEXT_EXT.test(rel) ? "text" : "other";
            const type = kind === "pdf" ? "application/pdf" : kind === "text" ? "text/plain;charset=utf-8" : "";
            const url = URL.createObjectURL(new Blob([bytes.slice()], type ? { type } : undefined));
            files.push({ path: rel, size: bytes.length, status, url, kind, text: kind === "text" ? new TextDecoder().decode(bytes.subarray(0, 4096)) : undefined });
          }
        }
        files.sort((a, b) => a.path.localeCompare(b.path));
        this.results = files;
        this.exitCode = r.exitCode;
        if (r.cancelled) {
          append("\n■ cancelled\n");
          this.setState("stopped");
        } else {
          if (r.exitCode !== 0) append(`\n[exit ${r.exitCode}]\n`);
          this.setState(r.exitCode === 0 ? "done" : "error");
        }
      } catch (e) {
        if (ac.signal.aborted) {
          append("\n■ cancelled\n");
          this.setState("stopped");
        } else {
          this.error = e instanceof Error ? e.message : String(e);
          append(`\nerror: ${this.error}\n`);
          this.setState("error");
        }
      } finally {
        this.phase = null;
        this.frac = null;
        this.render();
      }
    }

    private async save() {
      const f = this.folder;
      if (!f) return;
      this.error = null;
      try {
        const rep = await f.writeBack({ paths: this.results.map((r) => r.path) });
        this.saved =
          `Saved ${rep.written.length} file${rep.written.length === 1 ? "" : "s"} (${fmtBytes(rep.bytes)}) to “${this.picked?.name}”.` +
          (rep.failed.length ? ` ${rep.failed.length} failed: ${rep.failed.map((x) => `${x.path} (${x.error})`).join(", ")}` : "");
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      }
      this.render();
    }

    private async downloadZip(target: unknown, folder: MountedFolder, only: string[]) {
      const set = new Set(only);
      const blob = await zipFolder(target as FolderTarget, folder.at, {
        include: (p) => (p.endsWith("/") ? [...set].some((x) => x.startsWith(p)) : set.has(p)),
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${this.def.id}-results.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
    }

    // --- terminal ------------------------------------------------------------------

    private terminalEnabled(): boolean {
      return this.hasAttribute("terminal") && !this.hasAttribute("no-terminal");
    }

    private async openTerminal() {
      this.tab = "terminal";
      this.render();
      if (this.term || !this.picked) return;
      const picked = this.picked;
      const host = this.root.querySelector<HTMLElement>('[data-role="terminal"]');
      if (!host) return;
      // One VM at a time: the page VM goes; its unsaved results go with it.
      this.teardownVm();
      this.clearResults();
      let disposed = false;
      const t = {
        handle: null as TerminalHandleLike | null,
        el: null as HTMLElement | null,
        folder: null as MountedFolder | null,
        vm: null as unknown,
        dispose: () => {
          disposed = true;
          try {
            t.handle?.dispose();
          } catch {
            /* ignore */
          }
          t.el?.remove();
        },
      };
      this.term = t;
      const say = (msg: string | null, st: typeof this.termState = "booting") => {
        this.termMsg = msg;
        this.termState = st;
        this.dataset.terminal = st;
        this.renderTerminalBar();
      };
      try {
        say("loading the terminal…");
        const loader = this.loadTerminal ?? (() => nativeImport(new URL("./terminal.js", import.meta.url).href) as ReturnType<TerminalLoader>);
        const [mod, sdk] = await Promise.all([loader(), import("../index")]);
        if (disposed) return;
        mod.defineNanoTerminal();
        const term = document.createElement("nano-terminal") as HTMLElement & { ready: Promise<TerminalHandleLike> | null };
        term.setAttribute("wasm-url", this.getAttribute("wasm-url") ?? "/nano.wasm");
        term.setAttribute("service-worker-url", this.getAttribute("service-worker-url") ?? "/nano-sw.js");
        term.setAttribute("ram-mb", this.getAttribute("ram-mb") ?? "512");
        term.setAttribute("no-assistant", "");
        term.setAttribute("no-catalog", ""); // the tool's apps are provisioned here; no browsing sidebar
        term.style.display = "block";
        term.style.height = "100%";
        t.el = term;
        const before = new Set(document.querySelectorAll(MIRROR));
        host.appendChild(term);
        say("booting the terminal VM…");
        const handle = await term.ready;
        if (!handle) throw new Error("the terminal did not boot");
        t.handle = handle;
        t.vm = handle.vm;
        if (disposed) return;
        // The terminal's raw VM through Nano's methods (same kernel, same wasm-app runner).
        const shim = Object.create(sdk.Nano.prototype) as ToolNano;
        (shim as unknown as { raw: unknown }).raw = handle.vm;
        for (const app of toolApps(this.def)) {
          say(this.appSource ? `loading ${app.ref}…` : `installing ${app.ref} from the catalog…`);
          await provideApp(this.appSource, app, sdk, handle.vm, shim);
        }
        say("copying your folder to /work…");
        const opts = { at: "/work", maxBytes: this.def.maxBytes };
        const target = handle.vm as unknown as FolderTarget;
        t.folder = picked.kind === "handle" ? await mountFolder(target, picked.handle!, opts) : await mountFiles(target, picked.files!, opts);
        say("waiting for the shell prompt…");
        const deadline = Date.now() + 120_000;
        for (;;) {
          if (disposed) return;
          const mirror = term.shadowRoot?.querySelector(MIRROR) ?? [...document.querySelectorAll(MIRROR)].find((m) => !before.has(m)) ?? null;
          if (/[#$] ?$/m.test((mirror?.textContent ?? "").trimEnd())) break;
          if (Date.now() > deadline) throw new Error("timed out waiting for the shell prompt");
          await new Promise((r) => setTimeout(r, 200));
        }
        const env = envExports(this.preset, this.fieldValues());
        if (env) handle.vm.addFile("/tmp/.nano-tool-env", env);
        handle.vm.writeStdin(`cd /work${env ? " && . /tmp/.nano-tool-env" : ""}\r`);
        await new Promise((r) => setTimeout(r, 300));
        handle.vm.writeStdin(this.currentCommand());
        say(null, "ready");
      } catch (e) {
        if (!disposed) say(e instanceof Error ? e.message : String(e), "error");
      }
    }

    private disposeTerminal() {
      const t = this.term;
      this.term = null;
      t?.dispose();
      this.termState = "off";
      this.termMsg = null;
      this.termSaved = null;
      if (this.connected) this.dataset.terminal = "off";
    }

    private closeTerminal(render = true) {
      this.disposeTerminal();
      this.tab = "run";
      if (render) this.render();
    }

    private async saveTerminal() {
      const t = this.term;
      if (!t?.folder) return;
      this.termSaved = null;
      try {
        if (t.folder.writable) {
          const rep = await t.folder.writeBack();
          this.termSaved = `Saved ${rep.written.length} file${rep.written.length === 1 ? "" : "s"} to “${this.picked?.name}”: ${rep.written.join(", ") || "nothing changed"}.`;
        } else {
          const d = await t.folder.diff();
          await this.downloadZip(t.vm, t.folder, [...d.added, ...d.changed]);
          this.termSaved = `Downloaded ${d.added.length + d.changed.length} new or changed file(s) as a zip.`;
        }
      } catch (e) {
        this.termSaved = `error: ${e instanceof Error ? e.message : String(e)}`;
      }
      this.renderTerminalBar();
    }

    // --- rendering -------------------------------------------------------------------

    private render(focusField?: string) {
      if (!this.root) return;
      const active = this.root.activeElement as HTMLElement | null;
      const activeKey = active?.dataset?.field ?? active?.dataset?.role ?? null;
      const sel = active && "selectionStart" in active ? [(active as HTMLInputElement).selectionStart, (active as HTMLInputElement).selectionEnd] : null;

      const def = this.def;
      const busy = this.state === "running";
      const fsa = typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
      const picked = this.picked;
      const matching = picked ? picked.paths.filter((p) => def.accepts.includes(p.slice(p.lastIndexOf(".") + 1).toLowerCase())).length : 0;
      const tooBig = !!picked && !!def.maxBytes && picked.bytes > def.maxBytes;
      const preset = this.preset;
      const values = this.fieldValues();
      if (!this.commandEdited) this.command = this.generated();

      const box = el("div", { class: "box", part: "box" });
      if (this.appSource) box.append(el("p", { class: "dev", "data-role": "dev-override", text: "Apps are loaded from a custom app source (appSource), not the signed catalog." }));

      if (this.terminalEnabled()) {
        const tRun = el("button", { type: "button", role: "tab", class: "tab", "data-tab": "run", "aria-selected": String(this.tab === "run"), text: "Run a preset" });
        tRun.onclick = () => (this.tab === "terminal" ? this.closeTerminal() : undefined);
        const tTerm = el("button", { type: "button", role: "tab", class: "tab", "data-tab": "terminal", "aria-selected": String(this.tab === "terminal"), text: "Terminal", disabled: !picked || busy });
        tTerm.onclick = () => void this.openTerminal();
        box.append(el("div", { class: "tabs", role: "tablist", "aria-label": "Mode" }, tRun, tTerm));
      }

      // 1. folder
      const pickBtn = fsa ? el("button", { type: "button", class: "primary", "data-action": "pick", text: "Choose folder…", disabled: busy || this.tab === "terminal" }) : null;
      if (pickBtn) pickBtn.onclick = () => void this.pickFolder();
      const input = el("input", { type: "file", class: "file-input", "data-role": "folder-input", webkitdirectory: true, multiple: true, disabled: busy || this.tab === "terminal" });
      input.onchange = () => this.onFiles(input.files);
      const label = el("label", { class: fsa ? "linkish" : "primary" }, fsa ? "or select files instead" : "Choose folder…", input);
      const summary = picked
        ? el(
            "p",
            { class: "summary", "data-role": "picked" },
            el("strong", { text: picked.name || "folder" }),
            `: ${picked.paths.length} file${picked.paths.length === 1 ? "" : "s"}, ${fmtBytes(picked.bytes)} — ${matching} ${def.accepts.slice(0, 4).join("/")} file${matching === 1 ? "" : "s"}`,
            picked.kind === "files" ? " · results download as a zip (this browser can't write to folders)" : "",
            tooBig ? el("span", { class: "warn", text: ` · over the ${fmtBytes(def.maxBytes!)} limit — pick a smaller folder` }) : null,
          )
        : el("p", {
            class: "summary",
            text: fsa ? "Your browser will ask for access. Files are copied into this page only." : "Your browser copies the folder into this page; results download as a zip.",
          });
      box.append(step("1", el("div", { class: "title", text: "Pick a folder" }), el("div", { class: "row" }, pickBtn, label), summary));

      if (this.tab === "run") {
        // 2. preset + command
        const presets = el("div", { class: "presets", role: "radiogroup", "aria-label": "Preset" });
        for (const p of def.presets) {
          const b = el("button", { type: "button", role: "radio", class: "preset", "data-preset": p.id, "aria-checked": String(p.id === preset.id), text: p.label, disabled: busy });
          b.onclick = () => {
            this.presetId = p.id;
            this.commandEdited = false;
            this.notice = null;
            this.render();
          };
          presets.append(b);
        }
        const desc = el("p", { class: "desc" }, preset.description, preset.outputs === "in-place" ? el("span", { class: "warn", text: " Saving replaces the original files." }) : null);
        const fields = el("div", { class: "fields" });
        for (const f of preset.fields ?? []) fields.append(this.renderField(f, values[f.id]!, busy));
        const cmd = el("textarea", { class: "command", "data-role": "command", spellcheck: "false", rows: String(Math.min(6, Math.max(2, Math.ceil(this.command.length / 90)))), disabled: busy, id: "cmd", "aria-label": "Command" });
        cmd.value = this.command;
        cmd.oninput = () => {
          this.command = cmd.value.replace(/\n/g, " ");
          this.commandEdited = true;
          this.renderRunBar();
          this.root.querySelector<HTMLElement>('[data-action="reset-command"]')?.removeAttribute("hidden");
        };
        const reset = el("button", { type: "button", class: "btn", "data-action": "reset-command", text: "Reset to preset", hidden: !this.commandEdited, disabled: busy });
        reset.onclick = () => {
          this.commandEdited = false;
          this.render();
        };
        const extra: (Node | null)[] = [reset];
        if (this.hasAttribute("url-params")) {
          const share = el("button", { type: "button", class: "btn", "data-action": "share", text: "Copy share link" });
          share.onclick = async () => {
            const u = new URL(location.href);
            u.search = "";
            u.hash = "";
            u.searchParams.set("preset", this.preset.id);
            if (this.commandEdited) u.searchParams.set("cmd", this.command);
            try {
              await navigator.clipboard.writeText(u.toString());
              share.textContent = "Link copied";
              setTimeout(() => (share.textContent = "Copy share link"), 1600);
            } catch {
              share.textContent = "Copy failed";
            }
          };
          extra.push(share);
        }
        box.append(
          step(
            "2",
            el("div", { class: "title", text: "Choose what to do" }),
            presets,
            desc,
            (preset.fields ?? []).length ? fields : null,
            el("label", { class: "label", for: "cmd" }, "Command (runs in ", el("code", { text: "/work" }), ", your folder’s copy)"),
            cmd,
            el("div", { class: "row" }, ...extra),
            this.notice ? el("p", { class: "notice", "data-role": "notice", text: this.notice }) : null,
          ),
        );

        // 3. run
        const runBtn = el("button", { type: "button", class: "primary", "data-action": "run" });
        runBtn.onclick = () => void this.run();
        const cancel = el("button", { type: "button", class: "btn", "data-action": "cancel", text: "■ Cancel" });
        cancel.onclick = () => this.ac?.abort();
        const status = el("span", { class: "status", "aria-live": "polite", "data-role": "status" });
        const prog = el("div", { class: "progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "data-role": "progress" });
        const out = el("pre", { class: "output", "data-role": "output", "aria-label": "Output", hidden: this.state === "idle" });
        box.append(
          step("3", el("div", { class: "row", "data-role": "runbar" }, runBtn, cancel, status), prog, this.error ? el("p", { class: "error", text: this.error }) : null, out),
        );

        // 4. results
        if (this.results.length) box.append(step("4", ...this.renderResults(busy)));
      }

      // terminal panel (kept in the tree while the tab is open)
      if (this.terminalEnabled()) {
        let panel = this.root.querySelector<HTMLElement>('[data-role="terminal-panel"]');
        if (!panel) {
          const save = el("button", { type: "button", class: "primary", "data-action": "terminal-save" });
          save.onclick = () => void this.saveTerminal();
          const close = el("button", { type: "button", class: "btn", "data-action": "terminal-close", text: "Close terminal" });
          close.onclick = () => this.closeTerminal();
          panel = el(
            "div",
            { "data-role": "terminal-panel" },
            el("div", { class: "row" }, el("span", { class: "status", "data-role": "terminal-status" })),
            el("div", { class: "termhost", "data-role": "terminal" }),
            el("div", { class: "row" }, save, close),
            el("p", { class: "saved", "data-role": "terminal-saved", hidden: true }),
          );
        }
        panel.hidden = this.tab !== "terminal";
        box.append(panel);
      }

      box.append(el("aside", { class: "trust", "aria-label": "Network activity", "data-role": "trust" }));

      if (!this.root.querySelector("style")) this.root.append(el("style", { text: STYLES }));
      const old = this.root.querySelector(".box");
      if (old) old.replaceWith(box);
      else this.root.append(box);

      this.renderRunBar();
      this.renderStatus();
      this.renderOutput();
      this.renderTrust();
      this.renderTerminalBar();
      this.dataset.terminal = this.termState;

      const key = focusField ?? activeKey;
      if (key) {
        const t = this.root.querySelector<HTMLElement>(`[data-field="${key}"], [data-role="${key}"]`);
        if (t && t !== this.root.activeElement) {
          t.focus();
          if (sel && "setSelectionRange" in t) {
            try {
              (t as HTMLInputElement).setSelectionRange(sel[0] ?? null, sel[1] ?? null);
            } catch {
              /* not a text input */
            }
          }
        }
      }

      function step(n: string, ...children: (Node | null)[]) {
        return el("div", { class: "step" }, el("div", { class: "num", text: n, "aria-hidden": "true" }), el("div", {}, ...children));
      }
    }

    private renderField(f: ToolField, v: ToolValue, busy: boolean): HTMLElement {
      const id = `f-${this.preset.id}-${f.id}`;
      const wrap = el("div", { class: f.type === "textarea" ? "field wide" : "field" });
      if (f.type === "checkbox") {
        const c = el("input", { type: "checkbox", id, "data-field": f.id, disabled: busy });
        c.checked = !!v;
        c.onchange = () => this.setField(f, c.checked);
        wrap.append(el("label", { class: "check", for: id }, c, f.label));
      } else {
        wrap.append(el("label", { class: "label", for: id, text: f.label }));
        let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        if (f.type === "textarea") {
          input = el("textarea", { class: "input", id, "data-field": f.id, rows: "3", spellcheck: "false", disabled: busy });
        } else if (f.type === "select") {
          input = el("select", { class: "input", id, "data-field": f.id, disabled: busy });
          for (const o of f.options ?? []) input.append(el("option", { value: o.value, text: o.label ?? o.value }));
        } else {
          input = el("input", {
            class: "input",
            id,
            "data-field": f.id,
            type: f.type === "password" ? "password" : f.type === "number" ? "number" : "text",
            autocomplete: f.type === "password" ? "new-password" : "off",
            min: f.min != null ? String(f.min) : undefined,
            max: f.max != null ? String(f.max) : undefined,
            disabled: busy,
          });
        }
        input.value = String(v);
        input.setAttribute("aria-invalid", String(!!fieldError(f, v)));
        input.oninput = () => this.setField(f, input.value);
        wrap.append(input);
      }
      if (f.help) wrap.append(el("span", { class: "help", text: f.help }));
      return wrap;
    }

    private renderResults(busy: boolean): Node[] {
      const nodes: Node[] = [el("div", { class: "title", text: "Results" })];
      const writable = !!this.folder?.writable;
      const row = el("div", { class: "row" });
      if (writable) {
        const save = el("button", { type: "button", class: "primary", "data-action": "save", text: `Save to “${this.picked?.name}”`, disabled: busy });
        save.onclick = () => void this.save();
        row.append(save);
      }
      const zip = el("button", { type: "button", class: writable ? "btn" : "primary", "data-action": "zip", text: "Download zip", disabled: busy });
      zip.onclick = () => {
        if (this.folder && this.nano) void this.downloadZip(this.nano, this.folder, this.results.map((r) => r.path));
      };
      row.append(zip);
      nodes.push(row);
      if (this.saved) nodes.push(el("p", { class: "saved", "data-role": "saved", text: this.saved }));
      const list = el("ul", { class: "results", "data-role": "results" });
      for (const r of this.results) {
        const head = el(
          "div",
          { class: "rhead" },
          el("a", { href: r.url, download: r.path.split("/").pop(), class: "rname", text: r.path }),
          el("span", { class: "badge", text: fmtBytes(r.size) }),
          el("span", { class: r.status === "changed" ? "badge warn" : "badge", text: r.status === "changed" ? "replaces original" : "new" }),
        );
        const li = el("li", { class: "result", "data-path": r.path }, head);
        if (r.kind === "pdf") {
          const b = el("button", { type: "button", class: "linkbtn", text: this.previewPdf === r.url ? "hide preview" : "preview" });
          b.onclick = () => {
            this.previewPdf = this.previewPdf === r.url ? null : r.url;
            this.render();
          };
          head.append(b);
          if (this.previewPdf === r.url) li.append(el("iframe", { src: r.url, class: "pdf", title: `Preview of ${r.path}` }));
        }
        if (r.kind === "image") {
          const img = el("img", { src: r.url, alt: r.path, class: "thumb", loading: "lazy" });
          img.onerror = () => (img.style.display = "none");
          li.append(img);
        }
        if (r.kind === "text" && r.text) li.append(el("pre", { class: "textpre", text: r.text }));
        list.append(li);
      }
      nodes.push(list);
      return nodes;
    }

    private renderRunBar() {
      const run = this.root?.querySelector<HTMLButtonElement>('[data-action="run"]');
      if (!run) return;
      const busy = this.state === "running";
      const tooBig = !!this.picked && !!this.def.maxBytes && this.picked.bytes > this.def.maxBytes;
      run.textContent = busy ? "Running…" : "▶ Run";
      run.disabled = busy || !this.picked || tooBig || !this.fieldsOk() || !this.currentCommand().trim();
      const cancel = this.root.querySelector<HTMLButtonElement>('[data-action="cancel"]');
      if (cancel) cancel.disabled = !busy;
    }

    private renderStatus() {
      const s = this.root?.querySelector<HTMLElement>('[data-role="status"]');
      const prog = this.root?.querySelector<HTMLElement>('[data-role="progress"]');
      if (!s || !prog) return;
      const n = this.results.length;
      s.textContent =
        this.phase ??
        (this.state === "done"
          ? `✓ done${n ? ` — ${n} new or changed file${n === 1 ? "" : "s"}` : ""}`
          : this.state === "error"
            ? `✗ failed${this.exitCode != null ? ` (exit ${this.exitCode})` : ""}`
            : this.state === "stopped"
              ? "cancelled"
              : !this.picked
                ? "pick a folder first"
                : !this.fieldsOk()
                  ? "fill in the form above"
                  : this.appSource
                    ? "ready"
                    : "the first run downloads the program (once)");
      prog.hidden = this.state !== "running";
      prog.replaceChildren(this.frac == null ? el("div", { class: "indet" }) : el("div", { class: "bar", style: `width:${Math.round(this.frac * 100)}%` }));
    }

    private renderOutput() {
      const o = this.root?.querySelector<HTMLElement>('[data-role="output"]');
      if (!o) return;
      o.hidden = this.state === "idle";
      o.textContent = cleanOutput(this.output) || (this.state === "running" ? "" : "(no output)");
      o.scrollTop = o.scrollHeight;
    }

    private renderTrust() {
      const t = this.root?.querySelector<HTMLElement>('[data-role="trust"]');
      if (!t) return;
      const list = Object.entries(this.hosts).sort((a, b) => b[1] - a[1]);
      const n = list.reduce((s, [, c]) => s + c, 0);
      const note = (h: string) => this.hostNotes[h] ?? (/jsdelivr/.test(h) ? "signed app packages (catalog)" : "");
      const apps = toolApps(this.def).map((a) => a.command).join(", ");
      t.replaceChildren(
        el(
          "div",
          {},
          el("span", { class: "dot", "aria-hidden": "true" }),
          el("strong", {}, el("span", { "data-role": "trust-count", text: String(n) }), ` request${n === 1 ? "" : "s"} left this site`),
          " while this page was open · your files: 0 bytes uploaded",
        ),
        list.length
          ? el(
              "ul",
              { "data-role": "trust-hosts" },
              ...list.map(([h, c]) => el("li", {}, el("code", { text: h }), ` × ${c}`, note(h) ? ` — ${note(h)}` : "")),
            )
          : "",
        el("p", {
          text:
            `Counted live from the browser’s resource timing. The only requests a run makes are downloads of the signed ${apps} ` +
            "package from the jsDelivr CDN (once; then cached). Your files are processed in this page and written back only when you press Save.",
        }),
      );
    }

    private renderTerminalBar() {
      const s = this.root?.querySelector<HTMLElement>('[data-role="terminal-status"]');
      if (!s) return;
      s.textContent =
        this.termMsg ?? (this.termState === "ready" ? "Your folder is at /work. The command is typed in — press Enter to run it." : "");
      const save = this.root.querySelector<HTMLButtonElement>('[data-action="terminal-save"]');
      if (save) {
        save.disabled = this.termState !== "ready";
        save.textContent = this.picked?.kind === "handle" ? `Save changes to “${this.picked.name}”` : "Download changes as zip";
      }
      const saved = this.root.querySelector<HTMLElement>('[data-role="terminal-saved"]');
      if (saved) {
        saved.hidden = !this.termSaved;
        saved.textContent = this.termSaved ?? "";
      }
    }
  };
}

/** Install the tool's apps into the element's VM (catalog, or appSource). */
async function runToolApps(
  def: ToolDefinition,
  appSource: ToolAppSource | null,
  nano: ToolNano,
  progress: (label: string, frac: number | null) => void,
  append: (s: string) => void,
) {
  try {
    await installToolApps(nano, def, { appSource: appSource ?? undefined, onProgress: (p) => progress(p.label, p.fraction) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(/not found|unknown|404/i.test(msg) ? `an app of this tool is not in the published catalog yet (${msg})` : msg);
  }
  if (appSource) append(`(apps from a custom app source, not the signed catalog)\n`);
}

/**
 * Make a tool app runnable in the terminal's VM: install it from the signed
 * catalog straight into that VM (registering wasm apps), or take bytes from
 * `source` (RISC-V ELFs land in /usr/bin, wasm apps are registered).
 */
async function provideApp(
  source: ToolAppSource | null,
  app: Required<import("./types").ToolApp>,
  sdk: typeof import("../index"),
  vm: { addFile(path: string, content: string | Uint8Array, mode?: number): void },
  shim: ToolNano,
): Promise<void> {
  if (source) {
    const bytes = await source(app);
    if (app.tier === "riscv") vm.addFile(`/usr/bin/${app.command}`, bytes, 0o755);
    else await shim.registerWasmApp(app.command, bytes);
    return;
  }
  const files = new Map<string, Uint8Array>();
  const m = await new sdk.Catalog().install(
    {
      writeFile: (p, b, mode) => {
        files.set(p, b);
        vm.addFile(p, b, mode);
      },
    },
    app.ref,
  );
  if (sdk.manifestKind(m) !== "wasm-app") return;
  const file = m.files.find((f) => f.path.endsWith(".wasm")) ?? m.files[0];
  const bytes = file ? files.get(file.path) : undefined;
  if (!bytes) throw new Error(`${app.ref}: the catalog package has no module`);
  await shim.registerWasmApp(app.command, bytes);
}
