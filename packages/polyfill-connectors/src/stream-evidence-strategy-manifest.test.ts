/**
 * Build-time guardrail: every top-level connector manifest stream declares how
 * coverage and freshness evidence are established. These fields are strategy
 * declarations, not owner-facing state. The runtime/projection still needs
 * observed facts before it can classify a stream complete/current.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));
const MANIFEST_DIRS = [
  { label: "polyfill", path: join(PACKAGE_ROOT, "manifests") },
  { label: "reference", path: join(REPO_ROOT, "reference-implementation", "manifests") },
];

const VALID_COVERAGE_STRATEGIES = new Set([
  "checkpoint_window",
  "full_inventory",
  "parent_detail_accounting",
  "snapshot_import_receipt",
  "singleton_presence",
]);

const VALID_FRESHNESS_STRATEGIES = new Set([
  "device_heartbeat",
  "manual_as_of",
  "not_trackable",
  "scheduled_window",
  "source_reported_as_of",
]);

interface ManifestStream {
  coverage_strategy?: unknown;
  freshness_strategy?: unknown;
  name?: unknown;
  [key: string]: unknown;
}

interface ConnectorManifest {
  streams?: ManifestStream[];
  [key: string]: unknown;
}

function readManifests(): Array<{ connectorKey: string; manifest: ConnectorManifest }> {
  const manifests: Array<{ connectorKey: string; manifest: ConnectorManifest }> = [];
  for (const dir of MANIFEST_DIRS) {
    if (!existsSync(dir.path)) {
      continue;
    }
    for (const filename of readdirSync(dir.path).sort()) {
      if (!filename.endsWith(".json")) {
        continue;
      }
      const manifestPath = join(dir.path, filename);
      manifests.push({
        connectorKey: `${dir.label}/${filename.replace(/\.json$/, "")}`,
        manifest: JSON.parse(readFileSync(manifestPath, "utf8")) as ConnectorManifest,
      });
    }
  }
  return manifests;
}

test("connector manifest streams declare valid coverage and freshness evidence strategies", () => {
  const violations: string[] = [];
  for (const { connectorKey, manifest } of readManifests()) {
    for (const stream of manifest.streams ?? []) {
      const streamName = String(stream.name ?? "<missing>");
      if (!VALID_COVERAGE_STRATEGIES.has(stream.coverage_strategy as string)) {
        violations.push(
          `${connectorKey}.${streamName}: coverage_strategy must be one of ${[...VALID_COVERAGE_STRATEGIES].join(" | ")}`
        );
      }
      if (!VALID_FRESHNESS_STRATEGIES.has(stream.freshness_strategy as string)) {
        violations.push(
          `${connectorKey}.${streamName}: freshness_strategy must be one of ${[...VALID_FRESHNESS_STRATEGIES].join(" | ")}`
        );
      }
    }
  }

  assert.deepEqual(violations, [], "Every top-level manifest stream must declare coverage/freshness strategy");
});
