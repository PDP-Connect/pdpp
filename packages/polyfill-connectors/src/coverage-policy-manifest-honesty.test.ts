/**
 * Build-time guardrail: any connector manifest stream that declares
 * `coverage_policy` must use a recognized enum value, and a stream
 * declaring an accepted-coverage policy (anything other than `collect`)
 * must NOT also declare `required: true` — a required+accepted-absent
 * stream is a contradictory manifest that degrades health rather than
 * projecting accepted-coverage-green.
 *
 * Backs OpenSpec `add-universal-connector-coverage-evidence`: "The manifest
 * stream schema SHALL declare and validate coverage_policy."
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFESTS_DIR = join(PACKAGE_ROOT, "manifests");

const VALID_COVERAGE_POLICIES = new Set([
  "collect",
  "deferred",
  "inventory_only",
  "unavailable",
  "unsupported",
]);

// Accepted-coverage policies: declaring one of these on a required stream is
// contradictory (the stream is simultaneously load-bearing and accepted-absent).
const ACCEPTED_COVERAGE_POLICIES = new Set([
  "deferred",
  "inventory_only",
  "unavailable",
  "unsupported",
]);

interface ManifestStream {
  name?: unknown;
  coverage_policy?: unknown;
  required?: unknown;
  [key: string]: unknown;
}

interface ConnectorManifest {
  streams?: ManifestStream[];
  [key: string]: unknown;
}

test("connector manifest streams: coverage_policy uses only valid enum values", () => {
  const violations: string[] = [];

  for (const filename of readdirSync(MANIFESTS_DIR).sort()) {
    if (!filename.endsWith(".json")) {
      continue;
    }
    const manifestPath = join(MANIFESTS_DIR, filename);
    if (!existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ConnectorManifest;
    const connectorKey = filename.replace(/\.json$/, "");

    for (const stream of manifest.streams ?? []) {
      if (!("coverage_policy" in stream)) {
        continue;
      }
      const policy = stream.coverage_policy;
      if (!VALID_COVERAGE_POLICIES.has(policy as string)) {
        violations.push(
          `${connectorKey}.${String(stream.name)}: coverage_policy "${String(policy)}" is not in the recognized enum ` +
            `(${[...VALID_COVERAGE_POLICIES].join(" | ")})`
        );
      }
    }
  }

  assert.deepEqual(violations, [], "All declared coverage_policy values must be in the recognized enum");
});

test("connector manifest streams: accepted-coverage policy must not combine with required: true", () => {
  const violations: string[] = [];

  for (const filename of readdirSync(MANIFESTS_DIR).sort()) {
    if (!filename.endsWith(".json")) {
      continue;
    }
    const manifestPath = join(MANIFESTS_DIR, filename);
    if (!existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ConnectorManifest;
    const connectorKey = filename.replace(/\.json$/, "");

    for (const stream of manifest.streams ?? []) {
      const policy = stream.coverage_policy as string | undefined;
      if (!policy || !ACCEPTED_COVERAGE_POLICIES.has(policy)) {
        continue;
      }
      // `required` defaults to true when absent — so absent is the same as required: true.
      const required = stream.required;
      if (required !== false) {
        violations.push(
          `${connectorKey}.${String(stream.name)}: coverage_policy="${policy}" with required=${String(required ?? "absent (defaults true)")} ` +
            `is contradictory — a stream cannot be both load-bearing and accepted-absent. ` +
            `Add "required": false or change coverage_policy to "collect".`
        );
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    "Accepted-coverage policy (deferred/inventory_only/unavailable/unsupported) requires required: false"
  );
});
