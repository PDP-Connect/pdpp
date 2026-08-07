// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * License-boundary gate: gmkit/libgm are AGPL-3.0. This connector must
 * spawn `gmcli` as an arms-length subprocess ONLY — never import or vendor
 * gmkit/libgm source. Also asserts the header comment documents the
 * AGPL-3.0 license and the never-send-capable posture, since the honesty
 * of those claims is the whole point of this connector's design.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const INDEX_PATH = join(PACKAGE_ROOT, "connectors", "google_messages", "index.ts");
const SOURCE = readFileSync(INDEX_PATH, "utf8");

const IMPORT_LINE_RE = /^\s*import\b.*$/gmu;

function importLines(source: string): string[] {
  return source.match(IMPORT_LINE_RE) ?? [];
}

test("index.ts never imports a path containing 'libgm'", () => {
  for (const line of importLines(SOURCE)) {
    assert.doesNotMatch(line, /libgm/iu);
  }
});

test("index.ts never imports a path containing 'gmkit'", () => {
  for (const line of importLines(SOURCE)) {
    assert.doesNotMatch(line, /gmkit/iu);
  }
});

test("index.ts header documents AGPL-3.0", () => {
  assert.match(SOURCE, /AGPL-3\.0/);
});

test("index.ts documents it never invokes gmcli auth/serve/mcp", () => {
  assert.match(SOURCE, /NEVER/);
  assert.match(SOURCE, /`gmcli auth`/);
  assert.match(SOURCE, /`gmcli serve`/);
  assert.match(SOURCE, /`gmcli mcp`/);
});

test("index.ts never passes a literal 'auth', 'serve', or 'mcp' gmcli subcommand to runGmcli", () => {
  // Conservative textual check: no call site in the connector source passes
  // one of the forbidden subcommands as a runGmcli argument literal.
  assert.doesNotMatch(SOURCE, /runGmcli\(\s*\[\s*["'](auth|serve|mcp)["']/u);
});
