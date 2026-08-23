// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves D10 ("qualification is proven, never self-declared" --
 * scripts/canary/otp-posture.ts) holds for connector configuration: a
 * connector process must have NO channel to write its own config, and
 * therefore cannot widen its own collection scope or grant itself
 * eligibility for a scope-shaping option.
 *
 * The enforcement mechanism is structural, not a runtime permission check:
 * connector source files import neither the database driver nor the server
 * module tree that exposes connector_instance_config writes. Only
 * server-side orchestrator/console/migration code can reach
 * createSqliteConnectorInstanceConfigStore / createPostgresConnectorInstanceConfigStore.
 * A connector's only channel into config is READING the resolved value via
 * `readOptions(startMsg, spec)`, which the orchestrator populates from the
 * store -- the connector never calls the store directly and cannot,
 * because doing so would require the database driver, which is not shipped
 * or importable in the connector's dependency graph.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CONNECTORS_DIR = join(REPO_ROOT, "packages", "polyfill-connectors", "connectors");

const FORBIDDEN_IMPORT_PATTERNS = [
  /from\s+["']better-sqlite3["']/,
  /from\s+["']pg["']/,
  /from\s+["'](\.\.\/)+reference-implementation\/server\/db(\.ts)?["']/,
  /from\s+["'](\.\.\/)+reference-implementation\/server\/postgres-storage(\.ts)?["']/,
  /from\s+["'](\.\.\/)+reference-implementation\/server\/stores\/connector-instance-config-store(\.ts)?["']/,
];

function listConnectorSourceFiles(): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.includes("fixtures")) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".test.js")
      ) {
        // Test harnesses legitimately import server/db.ts to seed fixtures;
        // the constraint under test is on the connector's own RUNTIME
        // source, which is what a shipped connector process actually runs.
        out.push(full);
      }
    }
  }
  walk(CONNECTORS_DIR);
  return out;
}

test("no connector source file imports a database driver or the config-store module", () => {
  const offenders: string[] = [];
  for (const file of listConnectorSourceFiles()) {
    const contents = readFileSync(file, "utf8");
    for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
      if (pattern.test(contents)) {
        offenders.push(`${file} matches ${pattern}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `a connector must have no channel to write connector_instance_config directly -- it can only ` +
      `read the orchestrator-resolved value via readOptions(). Offenders: ${offenders.join("; ")}`
  );
});

test(
  "sanity: the forbidden-import check actually fires on a hostile pattern (proves the test is not vacuously passing)",
  () => {
    const hostileSample = `import Database from 'better-sqlite3';\nconst db = new Database('/var/lib/pdpp/pdpp.sqlite');\ndb.prepare("UPDATE connector_instance_config SET origin='owner'").run();`;
    const matched = FORBIDDEN_IMPORT_PATTERNS.some((pattern) => pattern.test(hostileSample));
    assert.equal(matched, true, "the pattern list must catch a connector attempting to open the DB directly");
  }
);
