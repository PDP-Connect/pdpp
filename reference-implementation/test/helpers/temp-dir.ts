// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const temporaryDirs = new Set<string>();

export function makeTemporaryDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.add(dir);
  return dir;
}

export function makeTemporaryDbPath(prefix: string): string {
  return join(makeTemporaryDir(prefix), "pdpp.sqlite");
}

export function removeTemporaryDir(dir: string): void {
  temporaryDirs.delete(dir);
  rmSync(dir, { force: true, recursive: true });
}

after(() => {
  for (const dir of [...temporaryDirs].reverse()) {
    removeTemporaryDir(dir);
  }
});
