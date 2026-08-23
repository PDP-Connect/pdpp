// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, initDb } from "../server/db.ts";

test("initDb creates a missing nested parent for a persistent SQLite database", () => {
  const root = mkdtempSync(join(tmpdir(), "pdpp-init-db-parent-"));
  const dbPath = join(root, "missing", "nested", "pdpp.sqlite");
  try {
    initDb(dbPath);
    assert.ok(existsSync(dbPath), "initDb creates the configured persistent database");
  } finally {
    closeDb();
    rmSync(root, { force: true, recursive: true });
  }
});
