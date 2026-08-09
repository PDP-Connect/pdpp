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
 * Also proves RI production code cannot evade the above by moving
 * connector/provider policy knowledge into a sibling JSON/YAML data file:
 * `new URL(path, import.meta.url)` sibling-resource loads are only
 * legitimate when they resolve inside a sanctioned manifest root, or land on
 * an explicit, closed allowlist of RI-owned policy registries
 * (`SANCTIONED_POLICY_RESOURCES` in the scan helper) — never a
 * connector-package path, a connector-authored manifest-adjacent path, or a
 * dynamically-constructed (connector-id-interpolated) path outside the
 * manifest roots.
 *
 * Spec: openspec/changes/enforce-ri-zero-connector-knowledge/specs/
 *       reference-implementation-architecture/spec.md
 *
 * The zero-connector-knowledge violations this guard originally found have
 * been fixed (see `fix(ri): close Cluster C + version-disposition/scheduler/
 * compaction connector-knowledge violations`); it now runs as a standing
 * regression gate that must stay green.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  formatViolationInventory,
  manifestDerivedConnectorKeys,
  scanFile,
  scanRepository,
} from "./helpers/ri-zero-connector-knowledge-scan.ts";

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
        "export function isFirstParty(connectorId: string): boolean {",
        '  return connectorId === "gmail" || connectorId === "slack";',
        "}",
        "",
      ].join("\n")
    );
    const violations = scanFile(badFile, "synthetic-violation.ts", new Set(["gmail", "slack"]));
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-connector-identity-literal"),
      "scanner failed to detect a synthetic connector-identity literal — the guard would be a green-path wrapper"
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
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
      "scanner failed to detect a synthetic provider-endpoint URL"
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
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
      "scanner failed to detect a synthetic provider-shaped env var name"
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
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
      ].join("\n")
    );
    const violations = scanFile(goodFile, "synthetic-generic.ts", new Set(["gmail", "slack"]));
    assert.deepEqual(violations, [], "generic manifest-driven code must not be flagged");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("falsifiability: a sanctioned RI-owned sibling policy resource is not flagged", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-falsifiability-"));
  try {
    const goodFile = join(dir, "synthetic-safe-policy.ts");
    writeFileSync(
      goodFile,
      [
        'import { readFileSync } from "node:fs";',
        'const POLICY_PATH = new URL("./version-disposition-policy.json", import.meta.url);',
        'const POLICY = JSON.parse(readFileSync(POLICY_PATH, "utf8"));',
        "",
      ].join("\n")
    );
    // relPath matches the real SANCTIONED_POLICY_RESOURCES entry exactly —
    // proves an allowlisted RI-owned registry load is legitimate.
    const violations = scanFile(
      goodFile,
      "reference-implementation/server/version-disposition.ts",
      new Set(["gmail", "slack"])
    );
    assert.deepEqual(violations, [], "an allowlisted sibling policy resource must not be flagged");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("falsifiability: an unsanctioned JSON file inside a connector package path is flagged", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-falsifiability-"));
  try {
    const badFile = join(dir, "synthetic-connector-package-load.ts");
    writeFileSync(
      badFile,
      [
        'import { readFileSync } from "node:fs";',
        'const POLICY_PATH = new URL("../../packages/polyfill-connectors/gmail-policy.json", import.meta.url);',
        'const POLICY = JSON.parse(readFileSync(POLICY_PATH, "utf8"));',
        "",
      ].join("\n")
    );
    const violations = scanFile(
      badFile,
      "reference-implementation/server/synthetic-connector-package-load.ts",
      new Set()
    );
    assert.ok(
      violations.some((v) => v.rule === "unsanctioned-policy-resource-path"),
      "a fixed-literal JSON load outside both the manifest roots and the RI policy allowlist must be flagged"
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("falsifiability: an unsanctioned JSON file at a connector-authored manifest-adjacent path is flagged", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-falsifiability-"));
  try {
    const badFile = join(dir, "synthetic-manifest-adjacent-load.ts");
    writeFileSync(
      badFile,
      [
        'import { readFileSync } from "node:fs";',
        // A path that looks manifest-ish but is NOT under either sanctioned
        // manifest root — e.g. a connector-authored file sitting beside a
        // manifest rather than one of the two shipped manifest directories.
        'const POLICY_PATH = new URL("./manifests-overrides/gmail.json", import.meta.url);',
        'const POLICY = JSON.parse(readFileSync(POLICY_PATH, "utf8"));',
        "",
      ].join("\n")
    );
    const violations = scanFile(
      badFile,
      "reference-implementation/server/synthetic-manifest-adjacent-load.ts",
      new Set()
    );
    assert.ok(
      violations.some((v) => v.rule === "unsanctioned-policy-resource-path"),
      "a manifest-adjacent but non-sanctioned-root JSON path must be flagged"
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("falsifiability: a dynamically-constructed connector-derived resource path outside the manifest roots is flagged", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-falsifiability-"));
  try {
    const badFile = join(dir, "synthetic-dynamic-path.ts");
    const dollar = String.fromCharCode(36);
    writeFileSync(
      badFile,
      [
        'import { readFileSync } from "node:fs";',
        "function loadPolicyFor(connectorId: string) {",
        `  const path = new URL(\`./policies/${dollar}{connectorId}.json\`, import.meta.url);`,
        '  return JSON.parse(readFileSync(path, "utf8"));',
        "}",
        "",
      ].join("\n")
    );
    const violations = scanFile(badFile, "reference-implementation/server/synthetic-dynamic-path.ts", new Set());
    assert.ok(
      violations.some((v) => v.rule === "dynamic-connector-derived-resource-path"),
      "a runtime-interpolated resource path outside the sanctioned manifest roots must be flagged"
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("falsifiability: a dynamic manifest-root selection (the legitimate 'pick a manifest by id' shape) is not flagged", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-falsifiability-"));
  try {
    const goodFile = join(dir, "synthetic-manifest-select.ts");
    const dollar = String.fromCharCode(36);
    writeFileSync(
      goodFile,
      [
        'import { readFileSync } from "node:fs";',
        "function loadManifest(entryName: string) {",
        `  const path = new URL(\`../../packages/polyfill-connectors/manifests/${dollar}{entryName}\`, import.meta.url);`,
        '  return JSON.parse(readFileSync(path, "utf8"));',
        "}",
        "",
      ].join("\n")
    );
    const violations = scanFile(goodFile, "reference-implementation/server/synthetic-manifest-select.ts", new Set());
    assert.deepEqual(
      violations,
      [],
      "selecting a manifest by connector-supplied id, resolving inside a sanctioned manifest root, must not be flagged"
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("RI production code contains zero connector/provider-specific executable knowledge", () => {
  const violations = scanRepository({ repoRoot });
  assert.deepEqual(violations, [], formatViolationInventory(violations));
});
