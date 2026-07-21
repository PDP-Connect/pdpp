import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { closeDb, initDb } from "../server/db.js";
import { loadReferenceQueries, referenceQueries, validateReferenceQueries } from "../server/queries/index.ts";

const PRODUCTION_QUERIES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "server",
  "queries"
);

function withTempQueryDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-query-registry-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

/**
 * Copies the entire production queries tree into the temp dir so the
 * required-keys assertion in `loadReferenceQueries` is satisfied. Tests
 * that need to add or override individual artifacts write to the
 * returned dir after calling this helper.
 *
 * Why copy rather than hand-author stubs: the registry's required-keys
 * list grows as the codebase migrates more call sites through the
 * wrapper. Hand-authored stubs fall behind every time. The production
 * tree is the source of truth and is itself validated against the
 * schema by `validateReferenceQueries`.
 */
function writeAllRequiredArtifacts(dir) {
  cpSync(PRODUCTION_QUERIES_DIR, dir, {
    recursive: true,
    // Only copy `.sql` artifacts; skip the registry loader index.ts.
    filter: (src) => !src.endsWith("index.ts"),
  });
}

test("loads query artifacts deterministically with camelCase keys", () => {
  withTempQueryDir((dir) => {
    writeAllRequiredArtifacts(dir);
    mkdirSync(join(dir, "nested"));
    writeFileSync(
      join(dir, "alpha-query.sql"),
      "-- @terminator: one\nSELECT 1 AS value\n"
    );
    writeFileSync(
      join(dir, "nested", "beta_query.sql"),
      "-- @terminator: one\nSELECT 2 AS value;\n"
    );

    const registry = loadReferenceQueries(dir);

    // Production tree contributes ~140+ keys (varies as more sites
    // migrate); the test asserts the loader's deterministic behavior on
    // the two ad-hoc artifacts it adds — nested kebab→camel mapping,
    // file path preservation, and trailing-semicolon stripping — without
    // pinning the full production key set.
    assert.equal(registry.alphaQuery.file, "alpha-query.sql");
    assert.equal(registry.alphaQuery.terminator, "one");
    assert.equal(registry.nestedBetaQuery.file, "nested/beta_query.sql");
    assert.equal(registry.nestedBetaQuery.terminator, "one");
    assert.equal(registry.nestedBetaQuery.sql, "SELECT 2 AS value");
    // Sanity: the production registry's required keys are also present.
    assert.ok(registry.listRegisteredConnectors);
    assert.ok(registry.spineListEventsByRunId);
  });
});

test("fails fast when a required query artifact is missing", () => {
  withTempQueryDir((dir) => {
    writeFileSync(join(dir, "other-query.sql"), "-- @terminator: one\nSELECT 1\n");

    assert.throws(
      () => loadReferenceQueries(dir),
      /Missing required query artifact: listRegisteredConnectors/
    );
  });
});

test("fails fast on multi-statement query artifacts", () => {
  withTempQueryDir((dir) => {
    writeAllRequiredArtifacts(dir);
    // Replace the production list-registered-connectors with a malformed
    // multi-statement variant to verify the loader's single-statement guard.
    writeFileSync(
      join(dir, "list-registered-connectors.sql"),
      "-- @terminator: many\n-- @bounded_by: small_enumeration_table\n-- @table: connectors\n-- @max_rows: 256\nSELECT 1; SELECT 2;\n"
    );

    assert.throws(() => loadReferenceQueries(dir), /must contain one statement/);
  });
});

test("rejects artifacts without @terminator frontmatter", () => {
  withTempQueryDir((dir) => {
    writeAllRequiredArtifacts(dir);
    writeFileSync(join(dir, "no-frontmatter.sql"), "SELECT 1 AS value\n");

    assert.throws(
      () => loadReferenceQueries(dir),
      /missing or invalid @terminator/
    );
  });
});

test("rejects terminator=many SQL without LIMIT and without small-enum annotation", () => {
  withTempQueryDir((dir) => {
    writeAllRequiredArtifacts(dir);
    writeFileSync(
      join(dir, "unbounded-many.sql"),
      "-- @terminator: many\n-- @cursor_field: rowid\nSELECT * FROM records\n"
    );

    assert.throws(
      () => loadReferenceQueries(dir),
      /must contain a LIMIT \? placeholder OR be annotated @bounded_by/
    );
  });
});

test("accepts terminator=many SQL with explicit LIMIT placeholder", () => {
  withTempQueryDir((dir) => {
    writeAllRequiredArtifacts(dir);
    writeFileSync(
      join(dir, "paged-records.sql"),
      "-- @terminator: many\n-- @cursor_field: rowid\nSELECT id, record_key FROM records ORDER BY rowid LIMIT ?\n"
    );

    const registry = loadReferenceQueries(dir);
    assert.equal(registry.pagedRecords.terminator, "many");
    assert.equal(registry.pagedRecords.cursorField, "rowid");
  });
});

test("rejects @bounded_by=small_enumeration_table without @table", () => {
  withTempQueryDir((dir) => {
    writeAllRequiredArtifacts(dir);
    writeFileSync(
      join(dir, "missing-table.sql"),
      "-- @terminator: many\n-- @bounded_by: small_enumeration_table\n-- @max_rows: 50\nSELECT 1\n"
    );

    assert.throws(() => loadReferenceQueries(dir), /requires @table/);
  });
});

test("rejects @bounded_by=small_enumeration_table without @max_rows", () => {
  withTempQueryDir((dir) => {
    writeAllRequiredArtifacts(dir);
    writeFileSync(
      join(dir, "missing-max.sql"),
      "-- @terminator: many\n-- @bounded_by: small_enumeration_table\n-- @table: foo\nSELECT 1\n"
    );

    assert.throws(() => loadReferenceQueries(dir), /requires @max_rows/);
  });
});

test("rejects terminator=iterate without @cursor_field", () => {
  withTempQueryDir((dir) => {
    writeAllRequiredArtifacts(dir);
    writeFileSync(
      join(dir, "no-cursor.sql"),
      "-- @terminator: iterate\nSELECT 1\n"
    );

    assert.throws(() => loadReferenceQueries(dir), /requires @cursor_field/);
  });
});

test("rejects terminator=exec without leading mutation keyword", () => {
  withTempQueryDir((dir) => {
    writeAllRequiredArtifacts(dir);
    writeFileSync(
      join(dir, "wrong-exec.sql"),
      "-- @terminator: exec\nSELECT 1\n"
    );

    assert.throws(
      () => loadReferenceQueries(dir),
      /SQL does not begin with INSERT\/UPDATE\/DELETE/
    );
  });
});

test("accepts terminator=exec_one with leading mutation keyword and RETURNING clause", () => {
  withTempQueryDir((dir) => {
    writeAllRequiredArtifacts(dir);
    writeFileSync(
      join(dir, "alloc-counter.sql"),
      "-- @terminator: exec_one\nINSERT INTO version_counter (connector_id, stream, max_version) VALUES (?, ?, 1) ON CONFLICT(connector_id, stream) DO UPDATE SET max_version = version_counter.max_version + 1 RETURNING max_version\n"
    );

    const registry = loadReferenceQueries(dir);
    assert.equal(registry.allocCounter.terminator, "exec_one");
  });
});

test("rejects terminator=exec_one without leading mutation keyword", () => {
  withTempQueryDir((dir) => {
    writeAllRequiredArtifacts(dir);
    writeFileSync(
      join(dir, "wrong-exec-one.sql"),
      "-- @terminator: exec_one\nSELECT 1 RETURNING value\n"
    );

    assert.throws(
      () => loadReferenceQueries(dir),
      /SQL does not begin with INSERT\/UPDATE\/DELETE/
    );
  });
});

test("rejects terminator=exec_one without RETURNING clause", () => {
  withTempQueryDir((dir) => {
    writeAllRequiredArtifacts(dir);
    writeFileSync(
      join(dir, "missing-returning.sql"),
      "-- @terminator: exec_one\nINSERT INTO records (connector_id, stream, record_key) VALUES (?, ?, ?)\n"
    );

    assert.throws(
      () => loadReferenceQueries(dir),
      /requires a RETURNING clause/
    );
  });
});

test("rejects unsupported @bounded_by values", () => {
  withTempQueryDir((dir) => {
    writeAllRequiredArtifacts(dir);
    writeFileSync(
      join(dir, "bad-bound.sql"),
      "-- @terminator: many\n-- @bounded_by: trust_me\n-- @cursor_field: id\nSELECT 1\n"
    );

    assert.throws(() => loadReferenceQueries(dir), /invalid @bounded_by "trust_me"/);
  });
});

test("rejects negative @max_rows", () => {
  withTempQueryDir((dir) => {
    writeAllRequiredArtifacts(dir);
    writeFileSync(
      join(dir, "neg-max.sql"),
      "-- @terminator: many\n-- @bounded_by: small_enumeration_table\n-- @table: foo\n-- @max_rows: -3\nSELECT 1\n"
    );

    assert.throws(() => loadReferenceQueries(dir), /@max_rows must be a positive integer/);
  });
});

test("freezes registered query handles", () => {
  withTempQueryDir((dir) => {
    writeAllRequiredArtifacts(dir);
    const registry = loadReferenceQueries(dir);
    const handle = registry.listRegisteredConnectors;
    assert.throws(() => {
      // Property assignment on a frozen object is silently ignored in
      // sloppy mode; in strict ESM it throws. Either way, attempting
      // a writable update should not succeed.
      Object.defineProperty(handle, "key", { value: "tampered" });
    });
  });
});

test("validates extracted queries against the reference schema", () => {
  initDb();
  try {
    validateReferenceQueries();
    assert.equal(referenceQueries.listRegisteredConnectors.key, "listRegisteredConnectors");
    assert.equal(referenceQueries.listRegisteredConnectors.terminator, "many");
    // The single shipped query is annotated as a small-enumeration scan.
    assert.equal(referenceQueries.listRegisteredConnectors.boundedBy, "small_enumeration_table");
    assert.equal(referenceQueries.listRegisteredConnectors.table, "connectors");
    assert.equal(typeof referenceQueries.listRegisteredConnectors.maxRows, "number");
  } finally {
    closeDb();
  }
});
