// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Synthetic export-directory builder for Apple Photos connector tests.
 * Writes small, non-real binary files with recognizable extensions into a
 * temp directory, mirroring the shape of a Photos.app "Export Unmodified
 * Originals" output well enough to exercise filename/size/hash/mtime
 * extraction. No real image bytes are needed — the connector detects MIME
 * type from the extension, not by sniffing content.
 */

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FixtureFile {
  /** File contents. Small synthetic buffers are fine — no real photo data. */
  contents?: Buffer;
  /** Override mtime/atime; defaults to "now" if omitted. */
  mtime?: Date;
  /** Relative path (may include subdirectories) within the export dir. */
  relPath: string;
}

/**
 * Create a fresh temp directory and populate it with the given fixture
 * files (creating subdirectories as needed). Returns the directory path.
 */
export function buildExportDirFixture(files: FixtureFile[]): string {
  const dir = mkdtempSync(join(tmpdir(), "apple-photos-fixture-"));
  for (const file of files) {
    const fullPath = join(dir, file.relPath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, file.contents ?? Buffer.from(`synthetic-${file.relPath}`));
    if (file.mtime) {
      utimesSync(fullPath, file.mtime, file.mtime);
    }
  }
  return dir;
}

/** Create an empty temp directory (simulates an export dir with nothing in it). */
export function buildEmptyExportDirFixture(): string {
  return mkdtempSync(join(tmpdir(), "apple-photos-fixture-empty-"));
}
