// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zero-connector-knowledge conformance guard.
 *
 * Proves RI production code (`cli/`, `lib/`, `operations/`, `runtime/`,
 * `scripts/`, `server/` under `reference-implementation/`, excluding
 * `connectors/` and test files) carries no hardcoded connector/provider
 * identity, endpoint, OAuth scope, or credential-env-var knowledge. Behavior
 * SHALL be constructed only from normative protocol concepts, the manifest
 * schema, and connector-authored facts — never from RI code that already
 * knows which connectors exist.
 *
 * `packages/polyfill-connectors/src/connector-conformance.test.ts` and its
 * siblings prove connectors are honest about what they declare. This test
 * proves the opposite direction: that RI code stays ignorant of which
 * connectors exist, reading everything it needs from the manifest instead.
 *
 * Spec: openspec/changes/enforce-ri-zero-connector-knowledge/specs/
 *       reference-implementation-architecture/spec.md
 *
 * This guard is EXPECTED TO FAIL against the current base — see the failure
 * inventory captured in that change's tasks.md / the workstream report. The
 * fix is separate follow-up work; this guard's job is only to make the
 * violations visible and prevent new ones from landing silently.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { formatViolationInventory, manifestDerivedConnectorKeys, scanFile, scanRepository } from "./helpers/ri-zero-connector-knowledge-scan.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(__dirname));

test("manifest-derived connector identity set is non-trivial (sanity check on the derivation itself)", () => {
  const keys = manifestDerivedConnectorKeys({ repoRoot });
  // A hardcoded lower-bound count would itself be exactly the kind of
  // hand-typed connector fact this guard forbids; assert shape instead.
  assert.ok(keys.size > 10, `expected manifests to yield a real connector-key vocabulary, got ${keys.size}`);
  assert.ok(keys.has("gmail"), "expected the well-known gmail connector to be derivable from shipped manifests");
});

test("falsifiability: the scanner detects a synthetic hardcoded-identity violation", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-falsifiability-"));
  try {
    const badFile = join(dir, "synthetic-violation.ts");
    writeFileSync(
      badFile,
      [
        'export function isFirstParty(connectorId: string): boolean {',
        '  return connectorId === "gmail" || connectorId === "slack";',
        "}",
        "",
      ].join("\n"),
    );
    const violations = scanFile(badFile, "synthetic-violation.ts", new Set(["gmail", "slack"]));
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-connector-identity-literal"),
      "scanner failed to detect a synthetic connector-identity literal — the guard would be a green-path wrapper",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("falsifiability: the scanner detects a synthetic provider-endpoint violation", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-falsifiability-"));
  try {
    const badFile = join(dir, "synthetic-endpoint.ts");
    writeFileSync(badFile, ['export const TOKEN_URL = "https://oauth2.example-provider.com/token";', ""].join("\n"));
    const violations = scanFile(badFile, "synthetic-endpoint.ts", new Set());
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-provider-endpoint-url"),
      "scanner failed to detect a synthetic provider-endpoint URL",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("falsifiability: the scanner detects a synthetic provider-credential env key", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-falsifiability-"));
  try {
    const badFile = join(dir, "synthetic-env.ts");
    writeFileSync(badFile, ['const key = "ACME_CLIENT_SECRET";', ""].join("\n"));
    const violations = scanFile(badFile, "synthetic-env.ts", new Set());
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-provider-credential-env-key"),
      "scanner failed to detect a synthetic provider-shaped env var name",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("falsifiability: the scanner does not flag manifest-generic code", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-falsifiability-"));
  try {
    const goodFile = join(dir, "synthetic-generic.ts");
    writeFileSync(
      goodFile,
      [
        "export function canonicalKey(manifest: { connector_key?: string }): string | null {",
        "  return manifest.connector_key ?? null;",
        "}",
        'export const REGISTRY_URL = "https://registry.pdpp.org/connectors/";',
        "",
      ].join("\n"),
    );
    const violations = scanFile(goodFile, "synthetic-generic.ts", new Set(["gmail", "slack"]));
    assert.deepEqual(violations, [], "generic manifest-driven code must not be flagged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RI production code contains zero connector/provider-specific executable knowledge", () => {
  const violations = scanRepository({ repoRoot });
  assert.deepEqual(violations, [], formatViolationInventory(violations));
});
