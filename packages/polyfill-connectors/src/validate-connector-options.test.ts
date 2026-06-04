/**
 * Unit tests for validateConnectorOptions.
 *
 * Covers the polyfill-runtime scenarios from:
 * openspec/changes/promote-connector-config-schema/specs/polyfill-runtime/spec.md
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type ManifestWithConfigSchemas, validateConnectorOptions } from "./validate-connector-options.ts";

const SLACK_OPTIONS_SCHEMA: ManifestWithConfigSchemas["options_schema"] = {
  type: "object",
  properties: {
    LOOKBACK_DAYS: { type: "integer", default: 7 },
    CHANNEL_ALLOWLIST: { type: "array", items: { type: "string" }, default: [] },
    CHANNEL_TYPES: { type: "array", items: { type: "string" }, default: ["public", "private", "im", "mpim"] },
    MEMBER_ONLY: { type: "boolean", default: true },
    SKIP_FILES: { type: "boolean", default: true },
  },
};

test("returns ok when no options_schema is declared (backward compat — no schema, always pass)", () => {
  const result = validateConnectorOptions({}, { LOOKBACK_DAYS: 99 });
  assert.deepEqual(result, { ok: true });
});

test("returns ok when options_schema is declared and options are null/undefined", () => {
  const manifest: ManifestWithConfigSchemas = { options_schema: SLACK_OPTIONS_SCHEMA };
  assert.deepEqual(validateConnectorOptions(manifest, null), { ok: true });
  assert.deepEqual(validateConnectorOptions(manifest, undefined), { ok: true });
});

test("returns ok when options conform to schema", () => {
  const manifest: ManifestWithConfigSchemas = { options_schema: SLACK_OPTIONS_SCHEMA };
  const result = validateConnectorOptions(manifest, {
    LOOKBACK_DAYS: 30,
    CHANNEL_ALLOWLIST: ["C01", "C02"],
    CHANNEL_TYPES: ["public"],
    MEMBER_ONLY: false,
    SKIP_FILES: true,
  });
  assert.deepEqual(result, { ok: true });
});

test("returns ok for empty options object against a schema (all defaults apply at connector read time)", () => {
  const manifest: ManifestWithConfigSchemas = { options_schema: SLACK_OPTIONS_SCHEMA };
  assert.deepEqual(validateConnectorOptions(manifest, {}), { ok: true });
});

test("returns ok when options contain only a subset of declared fields", () => {
  const manifest: ManifestWithConfigSchemas = { options_schema: SLACK_OPTIONS_SCHEMA };
  assert.deepEqual(validateConnectorOptions(manifest, { LOOKBACK_DAYS: 14 }), { ok: true });
});

test("returns ok for unknown/extra fields (schema is informational, not a whitelist)", () => {
  const manifest: ManifestWithConfigSchemas = { options_schema: SLACK_OPTIONS_SCHEMA };
  const result = validateConnectorOptions(manifest, { LOOKBACK_DAYS: 7, UNKNOWN_FUTURE_OPTION: "x" });
  assert.deepEqual(result, { ok: true });
});

test("fails when integer field receives a string", () => {
  const manifest: ManifestWithConfigSchemas = { options_schema: SLACK_OPTIONS_SCHEMA };
  const result = validateConnectorOptions(manifest, { LOOKBACK_DAYS: "seven" });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.issues.some((i) => i.field === "LOOKBACK_DAYS"));
});

test("fails when boolean field receives a number", () => {
  const manifest: ManifestWithConfigSchemas = { options_schema: SLACK_OPTIONS_SCHEMA };
  const result = validateConnectorOptions(manifest, { SKIP_FILES: 1 });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.issues.some((i) => i.field === "SKIP_FILES"));
});

test("fails when array field receives a plain string (not an array)", () => {
  const manifest: ManifestWithConfigSchemas = { options_schema: SLACK_OPTIONS_SCHEMA };
  const result = validateConnectorOptions(manifest, { CHANNEL_ALLOWLIST: "C01,C02" });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.issues.some((i) => i.field === "CHANNEL_ALLOWLIST"));
});

test("fails when array items have the wrong type", () => {
  const manifest: ManifestWithConfigSchemas = { options_schema: SLACK_OPTIONS_SCHEMA };
  const result = validateConnectorOptions(manifest, { CHANNEL_ALLOWLIST: [1, 2, 3] });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.issues.some((i) => i.field === "CHANNEL_ALLOWLIST"));
});

test("error includes the offending field name", () => {
  const manifest: ManifestWithConfigSchemas = { options_schema: SLACK_OPTIONS_SCHEMA };
  const result = validateConnectorOptions(manifest, { LOOKBACK_DAYS: "not-a-number" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    const issue = result.issues.find((i) => i.field === "LOOKBACK_DAYS");
    assert.ok(issue, "expected issue for LOOKBACK_DAYS");
    assert.ok(issue.reason.length > 0, "expected non-empty reason");
  }
});

test("multiple violations are all reported in a single result", () => {
  const manifest: ManifestWithConfigSchemas = { options_schema: SLACK_OPTIONS_SCHEMA };
  const result = validateConnectorOptions(manifest, {
    LOOKBACK_DAYS: "bad",
    SKIP_FILES: "also-bad",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.length >= 2, "expected at least 2 issues");
  }
});

test("type union with null: accepts null value for nullable field", () => {
  const manifest: ManifestWithConfigSchemas = {
    options_schema: {
      type: "object",
      properties: {
        NULLABLE_FIELD: { type: ["string", "null"] },
      },
    },
  };
  assert.deepEqual(validateConnectorOptions(manifest, { NULLABLE_FIELD: null }), { ok: true });
  assert.deepEqual(validateConnectorOptions(manifest, { NULLABLE_FIELD: "hello" }), { ok: true });
});
