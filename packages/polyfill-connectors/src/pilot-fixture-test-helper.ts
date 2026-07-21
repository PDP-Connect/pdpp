/**
 * Shared helper for connector pilot-real-shape fixture tests.
 *
 * Each schema-bearing connector ships a pilot fixture under
 * `fixtures/<connector>/scrubbed/pilot-real-shape/records/<stream>.jsonl`.
 * The fixture is committed (synthetic-but-shape-real, no PII) and
 * locks the connector's emitted-record shape against schema drift —
 * any change to `schemas.ts` that rejects a row in the fixture surfaces
 * as a test failure rather than going to production silently.
 *
 * This helper centralizes the read-and-replay loop so each connector's
 * test is just: import the helper, call it with the connector name +
 * the validator, get back a list of `node:test` cases. No FS plumbing
 * boilerplate per connector.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ValidateRecord } from "./connector-runtime.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..");
const JSONL_EXT_RE = /\.jsonl$/;

export interface PilotFixtureTestArgs {
  /** Connector directory name under `connectors/` (also matches the
   *  `fixtures/<connector>/` directory). */
  connector: string;
  /** Validator from the connector's `schemas.ts`. */
  validateRecord: ValidateRecord;
}

/**
 * Register one `node:test` case per stream in the connector's pilot
 * fixture. Each test loads `records/<stream>.jsonl`, parses every
 * non-blank line, and asserts `validateRecord(stream, row).ok === true`.
 *
 * Behavior:
 *   - Missing fixture directory → registers a single test that fails
 *     with a clear "fixture missing" message. We intentionally do NOT
 *     skip — a connector that ships a `schemas.ts` SHOULD ship a
 *     fixture, and the test should make that visible. To opt out for
 *     a specific connector (legitimately), call `expectMissing: true`.
 *   - Empty fixture file → fails the test. A pilot fixture with zero
 *     rows isn't locking anything.
 *   - Per-row schema failure → fails the test with the issue list and
 *     the offending record's id.
 */
export function registerPilotFixtureTests(args: PilotFixtureTestArgs & { expectMissing?: boolean }): void {
  const { connector, validateRecord, expectMissing = false } = args;
  const recordsDir = join(PKG_ROOT, "fixtures", connector, "scrubbed", "pilot-real-shape", "records");

  if (!existsSync(recordsDir)) {
    if (expectMissing) {
      return;
    }
    test(`pilot-real-shape/${connector}: fixture directory exists`, () => {
      assert.fail(
        `expected pilot-real-shape fixtures at ${recordsDir}; either author them or pass expectMissing:true to opt out`
      );
    });
    return;
  }

  const filenames = readdirSync(recordsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  if (filenames.length === 0) {
    test(`pilot-real-shape/${connector}: at least one stream fixture exists`, () => {
      assert.fail(`expected ≥1 .jsonl file under ${recordsDir}, found 0`);
    });
    return;
  }

  for (const filename of filenames) {
    const stream = filename.replace(JSONL_EXT_RE, "");
    const filePath = join(recordsDir, filename);
    test(`pilot-real-shape/${connector}/${stream}: every fixture record passes validateRecord`, () => {
      const lines = readFileSync(filePath, "utf8")
        .split("\n")
        .filter((l) => l.trim());
      assert.ok(lines.length > 0, `${filename} is empty — pilot fixture must have ≥1 record`);
      const failures: Array<{ id: unknown; issues: { path: string; message: string }[] }> = [];
      for (const line of lines) {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(line) as Record<string, unknown>;
        } catch (err) {
          assert.fail(`${filename}: invalid JSON line: ${(err as Error).message}\n  ${line.slice(0, 120)}`);
        }
        const result = validateRecord(stream, data);
        if (!result.ok) {
          failures.push({ id: data.id ?? null, issues: result.issues });
        }
      }
      if (failures.length > 0) {
        const detail = failures
          .slice(0, 3)
          .map(
            (f) => `  id=${JSON.stringify(f.id)} issues=${f.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`
          )
          .join("\n");
        assert.fail(`${filename}: ${failures.length}/${lines.length} records failed schema:\n${detail}`);
      }
    });
  }
}
