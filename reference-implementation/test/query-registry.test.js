import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeDb, initDb } from "../server/db.js";
import { loadReferenceQueries, referenceQueries, validateReferenceQueries } from "../server/queries/index.ts";

function withTempQueryDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-query-registry-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

test("loads query artifacts deterministically with camelCase keys", () => {
  withTempQueryDir((dir) => {
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "alpha-query.sql"), "SELECT 1 AS value\n");
    writeFileSync(join(dir, "nested", "beta_query.sql"), "SELECT 2 AS value;\n");
    writeFileSync(join(dir, "list-registered-connectors.sql"), "SELECT connector_id, manifest FROM connectors\n");

    const registry = loadReferenceQueries(dir);

    assert.deepEqual(Object.keys(registry), ["alphaQuery", "listRegisteredConnectors", "nestedBetaQuery"]);
    assert.equal(registry.alphaQuery.file, "alpha-query.sql");
    assert.equal(registry.nestedBetaQuery.sql, "SELECT 2 AS value");
  });
});

test("fails fast when a required query artifact is missing", () => {
  withTempQueryDir((dir) => {
    writeFileSync(join(dir, "other-query.sql"), "SELECT 1\n");

    assert.throws(() => loadReferenceQueries(dir), /Missing required query artifact: listRegisteredConnectors/);
  });
});

test("fails fast on malformed query artifacts", () => {
  withTempQueryDir((dir) => {
    writeFileSync(join(dir, "list-registered-connectors.sql"), "SELECT 1; SELECT 2;\n");

    assert.throws(() => loadReferenceQueries(dir), /must contain one statement/);
  });
});

test("validates extracted queries against the reference schema", () => {
  const db = initDb();
  try {
    validateReferenceQueries(db);
  } finally {
    closeDb();
  }

  assert.equal(referenceQueries.listRegisteredConnectors.key, "listRegisteredConnectors");
});
