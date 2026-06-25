# License

**The userland.run SDK** (`@userland-run/nano-sdk`, <https://userland.run>) is
**dual-licensed**. You may use, modify, and distribute it under the terms of
**either**:

- the **Mozilla Public License, version 2.0** (MPL-2.0) — the open-source
  option; the full text is in [`LICENSE`](./LICENSE); or
- the **Userland Enterprise License** (UEL) — a commercial option available
  from **And The Next GmbH**.

`SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL`

Source files carry the license notice in their header; new files must include
it (copy it from any existing source file).

## Why MPL for the SDK (and AGPL for the apps)

The SDK is meant to be **embedded broadly** in other people's applications, so
it uses the **MPL-2.0** — a file-level (weak) copyleft that lets you combine it
with proprietary code while keeping changes to the MPL-covered files open. The
user-facing userland.run applications — the emulator (`nano`), the terminal, and
the surrounding specs and design system — are instead **AGPL-3.0**, whose §13
network clause covers hosted use. Both are available under the commercial **UEL**
for users who need terms the open-source licenses don't provide.

## Mozilla Public License v2.0 (open source)

The standard, **unmodified** MPL-2.0 governs — see [`LICENSE`](./LICENSE), or
obtain a copy at <https://www.mozilla.org/MPL/2.0/>. MPL-2.0 copyleft is
file-level: you may combine these files with code under other licenses, but
modifications to the MPL-covered files themselves must remain under MPL-2.0.

## Userland Enterprise License (commercial)

A commercial license is available from **And The Next GmbH** for users who need
terms MPL-2.0 does not provide — for example warranty, indemnification,
liability cover, support SLAs, and patent assurances. Contact And The Next GmbH
for terms.

## Bundled third-party components

This package vendors the NanoVM runtime and, when built, redistributes the
NanoVM WebAssembly artifact, which embeds further third-party software. Those
terms govern those files; see [`NOTICE`](./NOTICE).

## Contributions

Contributions are accepted under the project's Contributor License Agreement,
which lets And The Next GmbH distribute them under **both** the MPL-2.0 and the
Userland Enterprise License. See [`CLA.md`](./CLA.md).

## Trademarks

`userland`, `userland.run`, and the userland.run logo are trademarks of And The
Next GmbH. The open-source license grants copyright permissions, not trademark
permissions: you may use and modify the SDK, but you may not ship a derivative
*called* userland without permission.

© And The Next GmbH. All rights reserved except as expressly granted above.
