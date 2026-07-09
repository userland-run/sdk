// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

// The terminal DISPLAY service — `@userland-run/nano-sdk/terminal`.
//
// This subpath bundles the @userland-run/terminal front-end (the <nano-terminal>
// web component + createTerminal). It is UI-heavy (WebGPU renderer, CodeMirror,
// lucide icons), so it ships separately from the headless core on the main entry
// (`@userland-run/nano-sdk`): a headless consumer never pays for the UI bundle.
//
// Usage:
//   import { defineNanoTerminal } from "@userland-run/nano-sdk/terminal";
//   defineNanoTerminal();           // registers <nano-terminal>
//   // then in markup: <nano-terminal wasm-url="/nano/nano.wasm"></nano-terminal>
// or imperatively:
//   import { createTerminal } from "@userland-run/nano-sdk/terminal";
//   await createTerminal(el, { features: { editor: false } });
//
// The terminal source resolves `@container/nanovm.mjs` and `@sdk` through build
// aliases (see tsup.config.ts) to the SDK's own vendored runtime + core.

export { createTerminal } from "../../terminal/src/main";
export type { TerminalHandle } from "../../terminal/src/main";
export { NanoTerminalElement, defineNanoTerminal } from "../../terminal/src/web-component";
export type {
  TerminalConfig,
  TerminalFeatureConfig,
  TerminalPreviewConfig,
  TerminalAssistantConfig,
} from "../../terminal/src/config";
export type {
  AssistantMode,
  CloudModelConfig,
} from "../../terminal/src/assistant/types";
export type { LocalModelConfig } from "../../terminal/src/assistant/local";
