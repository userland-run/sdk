// SPDX-License-Identifier: MPL-2.0 OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run SDK; dual-licensed - see LICENSE.md.

/**
 * `@userland-run/nano-sdk/folder` — bridge a local folder and the VM's
 * filesystem: copy a picked folder in, diff what changed, write it back, or
 * zip a VFS directory for download. Works with `Nano`, `NanoWorkerClient`,
 * and a raw `NanoVM` (e.g. `TerminalHandle.vm`).
 */

export {
  mountFolder,
  mountFiles,
  MountedFolder,
  FolderTooLargeError,
  FolderPermissionError,
  isFileSystemAccessSupported,
  ensurePermission,
  DEFAULT_MAX_BYTES,
} from "./mount";
export { zipFolder, createZip, type ZipEntry, type ZipOptions, type ZipFolderOptions } from "./zip";
export { crc32, contentHash } from "./hash";
export { toFolderVfs } from "./target";
export type * from "./types";
