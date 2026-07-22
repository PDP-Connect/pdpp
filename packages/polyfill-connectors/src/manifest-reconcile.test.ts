// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for manifest-reconcile. No FS, no DB, no globbing — every
 * input is a string the test owns, so the tests run in any environment.
 *
 * The cross-connector reconciliation tests live in
 * `bin/reconcile-manifests.test.ts` (when present) — those read the
 * real manifests/schemas off disk and assert the fleet has zero drift.
 * That's the regression net. These tests prove the parsers handle the
 * shapes we expect.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseManifestStreams, parseSchemaStreams, reconcile, scanEmittedStreams } from "./manifest-reconcile.ts";

// ─── parseManifestStreams ────────────────────────────────────────────────

test("parseManifestStreams: extracts every stream.name in declaration order", () => {
  const json = JSON.stringify({
    streams: [{ name: "orders" }, { name: "order_items" }, { name: "shipments" }],
  });
  assert.deepEqual(parseManifestStreams(json).declared, ["orders", "order_items", "shipments"]);
});

test("parseManifestStreams: skips streams with missing/non-string name", () => {
  const json = JSON.stringify({
    streams: [{ name: "ok" }, { name: null }, { name: 42 }, {}],
  });
  assert.deepEqual(parseManifestStreams(json).declared, ["ok"]);
});

test("parseManifestStreams: empty manifest → empty list", () => {
  assert.deepEqual(parseManifestStreams("{}").declared, []);
  assert.deepEqual(parseManifestStreams(JSON.stringify({ streams: [] })).declared, []);
});

// ─── parseSchemaStreams ──────────────────────────────────────────────────

test("parseSchemaStreams: extracts SCHEMAS registry keys (shorthand)", () => {
  const src = `
    export const SCHEMAS = {
      orders: ordersSchema,
      order_items: orderItemsSchema,
    };
  `;
  assert.deepEqual(parseSchemaStreams(src).registered, ["orders", "order_items"]);
});

test("parseSchemaStreams: extracts SCHEMAS registry keys (quoted)", () => {
  const src = `
    export const SCHEMAS: Record<string, z.ZodTypeAny> = {
      "orders": ordersSchema,
      "order_items": orderItemsSchema,
    };
  `;
  assert.deepEqual(parseSchemaStreams(src).registered, ["orders", "order_items"]);
});

test("parseSchemaStreams: handles type annotation between identifier and =", () => {
  const src = `
    export const SCHEMAS: Record<string, z.ZodTypeAny> = {
      a: aSchema,
      b: bSchema,
    };
  `;
  assert.deepEqual(parseSchemaStreams(src).registered, ["a", "b"]);
});

test("parseSchemaStreams: source without SCHEMAS block → empty list", () => {
  assert.deepEqual(parseSchemaStreams("// no schemas here\n").registered, []);
});

// ─── scanEmittedStreams ──────────────────────────────────────────────────

test("scanEmittedStreams: extracts emitRecord('name', ...) literals", () => {
  const src = `
    await emitRecord("orders", record);
    await ctx.emitRecord("items", x);
    await deps.emitRecord('shipments', y);
  `;
  assert.deepEqual(scanEmittedStreams([src]).emitted, ["items", "orders", "shipments"]);
});

test("scanEmittedStreams: extracts emit({ type: 'RECORD', stream: 'name', ... })", () => {
  const src = `
    emit({
      type: "RECORD",
      stream: "comments",
      key: 1,
      data: {},
    });
  `;
  assert.deepEqual(scanEmittedStreams([src]).emitted, ["comments"]);
});

test("scanEmittedStreams: dedupes across files and within a file", () => {
  const a = `emitRecord("orders", a); emitRecord("orders", b);`;
  const b = `emitRecord("orders", c); emitRecord("items", d);`;
  assert.deepEqual(scanEmittedStreams([a, b]).emitted, ["items", "orders"]);
});

test("scanEmittedStreams: ignores dynamically-named emits (variable args)", () => {
  // Fine — these miss the literal-string regex. The reconciler treats
  // the emit gap as a stream that won't show up in `emitted[]`; if it's
  // declared in the manifest or schema we still see consistency.
  const src = "emitRecord(streamName, data);";
  assert.deepEqual(scanEmittedStreams([src]).emitted, []);
});

// ─── reconcile ───────────────────────────────────────────────────────────

test("reconcile: all-aligned → ok=true, no drift", () => {
  const r = reconcile({
    connector: "amazon",
    declared: ["orders", "order_items"],
    registered: ["orders", "order_items"],
    emitted: ["orders", "order_items"],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing_manifest, []);
  assert.deepEqual(r.missing_schema, []);
  assert.deepEqual(r.missing_emit, []);
});

test("reconcile: emitted but undeclared in manifest", () => {
  const r = reconcile({
    connector: "codex",
    declared: ["sessions", "messages"],
    registered: ["sessions", "messages", "function_calls"],
    emitted: ["sessions", "messages", "function_calls"],
  });
  assert.deepEqual(r.missing_manifest, ["function_calls"]);
  assert.deepEqual(r.missing_schema, []);
  assert.deepEqual(r.missing_emit, []);
  assert.equal(r.ok, false);
});

test("reconcile: emitted but no schema → missing_schema", () => {
  const r = reconcile({
    connector: "x",
    declared: ["orders"],
    registered: [],
    emitted: ["orders"],
  });
  assert.deepEqual(r.missing_schema, ["orders"]);
  assert.equal(r.ok, false);
});

test("reconcile: declared but neither emitted nor registered", () => {
  // Manifest declares a stream the connector cannot fulfill — public
  // contract says "we provide stream X" but X is dead code.
  const r = reconcile({
    connector: "x",
    declared: ["orders", "ghost_stream"],
    registered: ["orders"],
    emitted: ["orders"],
  });
  assert.deepEqual(r.missing_emit, ["ghost_stream"]);
  assert.equal(r.ok, false);
});

test("reconcile: declared and registered but not emitted (acceptable — emit-scan miss)", () => {
  // If the schema is registered, we trust that the connector can
  // populate the stream — emit-scan is heuristic and may miss
  // dynamic emits. Don't fail-flag this case.
  const r = reconcile({
    connector: "x",
    declared: ["orders"],
    registered: ["orders"],
    emitted: [],
  });
  assert.deepEqual(r.missing_emit, []);
  assert.deepEqual(r.missing_manifest, []);
  assert.deepEqual(r.missing_schema, []);
  assert.equal(r.ok, true);
});
