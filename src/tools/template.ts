// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * Command templating for tool definitions: a fixed expansion grammar (no code
 * from the definition ever runs) with POSIX shell quoting.
 */

import type { ToolApp, ToolContext, ToolDefinition, ToolField, ToolPreset, ToolValue, ToolValues } from "./types";

/** Quote `s` as one POSIX shell word (unquoted when it is plainly safe). */
export function shellQuote(s: string): string {
  if (s === "") return "''";
  return /^[A-Za-z0-9._\/@%+=:,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A path for a tool's own argument syntax (e.g. an sqlite3 dot-command): double-quoted when needed. */
export function argQuote(s: string): string {
  return /^[A-Za-z0-9._\/-]+$/.test(s) ? s : `"${s.replace(/(["\\])/g, "\\$1")}"`;
}

/** "2024 sales-EU.csv" → "t2024_sales_EU": a bare identifier from a file's stem. */
export function identifierOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]*$/, "");
  const id = base.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_") || "t";
  return /^[0-9]/.test(id) ? `t${id}` : id;
}

export function toolApps(def: ToolDefinition): Required<ToolApp>[] {
  return def.apps.map((a) => {
    const app = typeof a === "string" ? { ref: a } : a;
    return { ref: app.ref, command: app.command ?? app.ref.replace(/@.*$/, ""), tier: app.tier ?? "wasm" };
  });
}

function extsOf(spec: string): string[] {
  return spec.split(",").map((e) => e.trim().toLowerCase().replace(/^\./, "")).filter(Boolean);
}

/** Files in `ctx` with one of the extensions (case-insensitive), sorted. */
export function matchingFiles(ctx: ToolContext, exts: string[]): string[] {
  const set = new Set(exts.map((e) => e.toLowerCase()));
  return ctx.files.filter((f) => set.has(f.slice(f.lastIndexOf(".") + 1).toLowerCase())).sort();
}

const TOKEN = /\{\{([^{}]*)\}\}/g;

function truthy(v: ToolValue | undefined): boolean {
  return v === true || (typeof v === "number" && !Number.isNaN(v)) || (typeof v === "string" && v.length > 0);
}

/** Expand a field default (`{{first:EXT:name|path}}` only; unquoted). */
export function expandDefault(text: string, ctx: ToolContext): string {
  return text.replace(TOKEN, (_m, body: string) => {
    const [kind, exts = "", what = "name"] = body.split(":");
    if (kind !== "first") throw new Error(`nano-sdk/tools: only {{first:…}} is allowed in a field default: {{${body}}}`);
    const f = matchingFiles(ctx, extsOf(exts))[0];
    if (!f) return what === "path" ? `data.${extsOf(exts)[0] ?? "txt"}` : "data";
    return what === "path" ? f : identifierOf(f);
  });
}

/** Default value of a field in `ctx`. */
export function fieldDefault(f: ToolField, ctx: ToolContext): ToolValue {
  const d = f.default ?? (f.type === "checkbox" ? false : f.type === "number" ? (f.min ?? 0) : f.type === "select" ? (f.options?.[0]?.value ?? "") : "");
  return typeof d === "string" ? expandDefault(d, ctx) : d;
}

/** Field values with defaults filled in for whatever `values` doesn't set. */
export function resolveValues(preset: ToolPreset, values: ToolValues | undefined, ctx: ToolContext): ToolValues {
  const out: ToolValues = {};
  for (const f of preset.fields ?? []) {
    const v = values?.[f.id];
    out[f.id] = v === undefined ? fieldDefault(f, ctx) : coerce(f, v);
  }
  return out;
}

function coerce(f: ToolField, v: ToolValue): ToolValue {
  if (f.type === "checkbox") return v === true || v === "true" || v === "on" || v === 1;
  if (f.type === "number") return typeof v === "number" ? v : Number(String(v).trim());
  return String(v);
}

/** Why a field value is invalid, or null when it is fine. */
export function fieldError(f: ToolField, v: ToolValue | undefined): string | null {
  if (f.type === "checkbox") return typeof v === "boolean" ? null : `${f.label}: expected on/off`;
  if (v === undefined) return `${f.label}: missing`;
  if (f.type === "number") {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return `${f.label}: not a number`;
    if (f.min != null && n < f.min) return `${f.label}: at least ${f.min}`;
    if (f.max != null && n > f.max) return `${f.label}: at most ${f.max}`;
    if (f.pattern && !new RegExp(`^(?:${f.pattern})$`).test(String(n))) return `${f.label}: invalid`;
    return null;
  }
  const s = String(v);
  if (f.type === "select" && f.options && !f.options.some((o) => o.value === s)) return `${f.label}: not one of the choices`;
  if (!s.trim()) return f.optional ? null : `${f.label}: required`;
  if (f.pattern && !new RegExp(`^(?:${f.pattern})$`).test(s)) return `${f.label}: invalid value`;
  if (/[\u0000]/.test(s)) return `${f.label}: invalid character`;
  return null;
}

/** All field errors of `values` for `preset` (empty when valid). */
export function validateValues(preset: ToolPreset, values: ToolValues): string[] {
  return (preset.fields ?? []).map((f) => fieldError(f, values[f.id])).filter((e): e is string => !!e);
}

/**
 * Expand a preset's command template against field values and the folder's
 * files. Every substituted value is shell-quoted; secret (`env`) fields can't
 * be referenced. Throws on unknown fields or malformed placeholders.
 */
export function expandCommand(preset: ToolPreset, values: ToolValues, ctx: ToolContext): string {
  const fields = new Map((preset.fields ?? []).map((f) => [f.id, f]));
  const used = new Set<string>();
  return preset.command.replace(TOKEN, (_m, body: string) => {
    if (body.startsWith("files:")) {
      return matchingFiles(ctx, extsOf(body.slice(6))).map(shellQuote).join(" ");
    }
    if (body.startsWith("each:")) {
      const rest = body.slice(5);
      const c = rest.indexOf(":");
      if (c < 0) throw new Error(`nano-sdk/tools: {{each:EXT:TEXT}} needs a text: {{${body}}}`);
      const files = matchingFiles(ctx, extsOf(rest.slice(0, c)));
      const text = rest.slice(c + 1);
      return files
        .map((f) => {
          let name = identifierOf(f);
          for (let i = 2; used.has(name); i++) name = `${identifierOf(f)}_${i}`;
          used.add(name);
          return shellQuote(text.replace(/<path>/g, argQuote(f)).replace(/<name>/g, name));
        })
        .join(" ");
    }
    if (body.startsWith("first:")) return shellQuote(expandDefault(`{{${body}}}`, ctx));
    const q = body.indexOf("?");
    const id = q < 0 ? body : body.slice(0, q);
    const f = fields.get(id);
    if (!f) throw new Error(`nano-sdk/tools: preset "${preset.id}" uses unknown field {{${id}}}`);
    if (f.env) throw new Error(`nano-sdk/tools: secret field "${id}" can't be templated — use "$${f.env}"`);
    const v = values[id];
    if (q >= 0) return truthy(v) && v !== false ? body.slice(q + 1) : "";
    if (f.type === "number") return String(Number(v));
    if (f.type === "checkbox") return v ? "true" : "false";
    return shellQuote(String(v ?? ""));
  }).trim();
}

/** `export NAME='value'` lines for a preset's secret fields. */
export function envExports(preset: ToolPreset, values: ToolValues): string {
  return (preset.fields ?? [])
    .filter((f) => f.env)
    .map((f) => `export ${f.env}=${shellQuote(String(values[f.id] ?? ""))}\n`)
    .join("");
}

/** Longest command accepted from outside (share links, attributes). */
export const MAX_COMMAND_LENGTH = 4000;

/**
 * Check a command that came from outside the form (a share link, an attribute):
 * one printable line, bounded, invoking one of the tool's own commands. Returns
 * the command or null. Such a command is only ever pre-filled — never run
 * without the user pressing Run.
 */
export function validateCommand(def: ToolDefinition, cmd: string): string | null {
  if (!cmd || cmd.length > MAX_COMMAND_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(cmd)) return null;
  const words = cmd.split(/[\s;&|()]+/);
  return toolApps(def).some((a) => words.includes(a.command)) ? cmd : null;
}

/** Structural check of a definition (ids, fields, templates). Returns problems (empty when valid). */
export function checkDefinition(def: ToolDefinition): string[] {
  const errs: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(def.id ?? "")) errs.push(`bad tool id "${def.id}"`);
  if (!def.apps?.length) errs.push(`${def.id}: no apps`);
  if (!def.presets?.length) errs.push(`${def.id}: no presets`);
  const ids = new Set<string>();
  for (const p of def.presets ?? []) {
    if (ids.has(p.id)) errs.push(`${def.id}: duplicate preset "${p.id}"`);
    ids.add(p.id);
    for (const f of p.fields ?? []) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.id)) errs.push(`${def.id}/${p.id}: bad field id "${f.id}"`);
    try {
      const ctx = { files: def.examples?.files ?? [] };
      expandCommand(p, resolveValues(p, undefined, ctx), ctx);
    } catch (e) {
      errs.push(`${def.id}/${p.id}: ${(e as Error).message}`);
    }
  }
  return errs;
}
