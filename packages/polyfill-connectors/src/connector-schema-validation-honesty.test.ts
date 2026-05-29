/**
 * Build-time guardrail: a connector whose manifest declares streams must either
 * wire emit-time record validation (`validateRecord`) or sit on the explicit
 * schemaless allowlist. Same family as `browser-manifest-honesty.test.ts` and
 * `external-tool-manifest-honesty.test.ts` — a filesystem scan asserting a
 * manifest-vs-code invariant, run inside `pnpm test` (which CI executes).
 *
 * Backs OpenSpec `polyfill-runtime`: "Connectors declaring manifest streams
 * SHALL validate emitted records or be on a justified schemaless allowlist."
 * Audit source: tmp/workstreams/ri-connector-schema-green-prep-audit-report.md (F1, F4).
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SCHEMALESS_CONNECTOR_ALLOWLIST } from "./connector-schema-allowlist.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONNECTORS_DIR = join(PACKAGE_ROOT, "connectors");
const MANIFESTS_DIR = join(PACKAGE_ROOT, "manifests");

interface ManifestShape {
  streams?: Array<{ name?: unknown }>;
}

function manifestDeclaresStreams(name: string): boolean {
  const manifestPath = join(MANIFESTS_DIR, `${name}.json`);
  if (!existsSync(manifestPath)) {
    return false;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestShape;
  return Array.isArray(manifest.streams) && manifest.streams.length > 0;
}

/**
 * Detection signal for "this connector wires emit-time validation": the
 * entrypoint references a `validateRecord` identifier, which is the token
 * passed into `runConnector({ ..., validateRecord })` (conventionally imported
 * from `./schemas.ts`). This reproduces the audit's 11-wired / 20-missing split
 * exactly on the current tree. See the change's design.md for why token
 * presence (not an AST pass) is the right altitude for a guardrail.
 */
function connectorWiresValidation(source: string): boolean {
  return /\bvalidateRecord\b/u.test(source);
}

function connectorNames(): string[] {
  return readdirSync(CONNECTORS_DIR)
    .filter((name) => existsSync(join(CONNECTORS_DIR, name, "index.ts")))
    .sort();
}

test("every stream-declaring connector validates records or is allowlisted", () => {
  const unexplainedGaps: string[] = [];
  const staleAllowlistEntries: string[] = [];

  for (const name of connectorNames()) {
    if (!manifestDeclaresStreams(name)) {
      // No streams declared → nothing to validate. Such a connector must not
      // be on the allowlist either (it has nothing to remediate).
      continue;
    }

    const source = readFileSync(join(CONNECTORS_DIR, name, "index.ts"), "utf8");
    const wires = connectorWiresValidation(source);
    const allowlisted = name in SCHEMALESS_CONNECTOR_ALLOWLIST;

    if (wires && allowlisted) {
      // Connector has adopted validation; its allowlist entry must be removed.
      staleAllowlistEntries.push(name);
    }
    if (!(wires || allowlisted)) {
      unexplainedGaps.push(name);
    }
  }

  assert.deepEqual(
    unexplainedGaps,
    [],
    "Connectors declare manifest streams but neither wire validateRecord nor " +
      `appear on the schemaless allowlist: ${unexplainedGaps.join(", ")}. ` +
      "Wire emit-time validation (see connectors/amazon/schemas.ts) or add a " +
      "justified entry to src/connector-schema-allowlist.ts."
  );

  assert.deepEqual(
    staleAllowlistEntries,
    [],
    "Connectors now wire validateRecord but remain on the schemaless " +
      `allowlist: ${staleAllowlistEntries.join(", ")}. Remove their entries ` +
      "from src/connector-schema-allowlist.ts — the allowlist may only shrink."
  );
});

test("schemaless allowlist contains only real, stream-declaring connectors", () => {
  const existing = new Set(connectorNames());
  const unknown: string[] = [];
  const noStreams: string[] = [];

  for (const name of Object.keys(SCHEMALESS_CONNECTOR_ALLOWLIST)) {
    if (!existing.has(name)) {
      unknown.push(name);
      continue;
    }
    if (!manifestDeclaresStreams(name)) {
      noStreams.push(name);
    }
  }

  assert.deepEqual(unknown, [], `Allowlist names connectors that do not exist: ${unknown.join(", ")}.`);
  assert.deepEqual(
    noStreams,
    [],
    "Allowlist names connectors whose manifest declares no streams (nothing to " +
      `remediate): ${noStreams.join(", ")}.`
  );
});

test("every allowlist entry carries a non-empty justification", () => {
  const blank = Object.entries(SCHEMALESS_CONNECTOR_ALLOWLIST)
    .filter(([, justification]) => justification.trim().length === 0)
    .map(([name]) => name);

  assert.deepEqual(blank, [], `Allowlist entries must carry an owner-readable justification: ${blank.join(", ")}.`);
});
