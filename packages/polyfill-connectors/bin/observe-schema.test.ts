// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end proof for `bin/observe-schema.ts` — the manifest-vs-observed-
 * records divergence reporter — driven as a REAL subprocess (spawnSync),
 * the same shape `bin/connector-dev.test.ts` uses for its CLI.
 *
 * Two cases:
 *   1. A throwaway temp manifest + temp JSONL crafted to trip every
 *      divergence class (undeclared field, unobserved field, type
 *      mismatch incl. null-where-not-nullable, enum violation), proving
 *      each is detected and labeled.
 *   2. A real connector's actual pilot-real-shape fixtures (jellyfin —
 *      verified by manual run to conform to its manifest schema) proving
 *      the no-divergence path reports cleanly end-to-end.
 *
 * Uses the `--manifest` dev/test-only override (see observe-schema.ts's
 * module docstring) so case 1 never touches the real manifests/ directory.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const CLI_PATH = join(PACKAGE_ROOT, "bin", "observe-schema.ts");

function runCli(args: readonly string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
    cwd: PACKAGE_ROOT,
    env: process.env,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("observe-schema CLI: detects every divergence class against a crafted temp manifest + JSONL", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "observe-schema-test-"));
  try {
    const manifestPath = join(tmpDir, "manifest.json");
    const recordsDir = join(tmpDir, "records");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        streams: [
          {
            name: "widgets",
            schema: {
              type: "object",
              properties: {
                id: { type: "string" },
                count: { type: "integer" },
                status: { type: "string", enum: ["active", "archived"] },
                label: { type: ["string", "null"] },
                never_seen_field: { type: "string" },
                score: { type: "number" },
              },
              required: ["id"],
            },
          },
          // Declared but has NO records/gadgets.jsonl at all — the
          // NO-SAMPLES case: a stream this tool never observed against any
          // real data, distinct from "declared but never observed" (which
          // is about a FIELD within an observed stream, not the whole
          // stream having zero samples).
          {
            name: "gadgets",
            schema: { type: "object", properties: { id: { type: "string" } } },
          },
        ],
      })
    );
    mkdirSync(recordsDir, { recursive: true });
    writeFileSync(
      join(recordsDir, "widgets.jsonl"),
      [
        // Baseline conforming record. score is an integer-valued sample
        // against a declared `number` field — JSON Schema's `integer` is a
        // subtype of `number`, so this must NOT be a type-mismatch.
        JSON.stringify({ id: "a", count: 1, status: "active", label: "ok", score: 5 }),
        // count observed as string (declared integer) -> type mismatch.
        JSON.stringify({ id: "b", count: "oops", status: "active", label: "ok", score: 5 }),
        // status observed outside declared enum -> enum violation.
        JSON.stringify({ id: "c", count: 2, status: "deleted", label: "ok", score: 5 }),
        // label observed null where schema DOES admit null -> no divergence;
        // extra_field is observed but not declared anywhere -> undeclared field.
        JSON.stringify({ id: "d", count: 3, status: "active", label: null, extra_field: true, score: 5 }),
      ].join("\n")
    );

    const result = runCli(["widgets-fixture", "--manifest", manifestPath, "--records", recordsDir]);

    assert.equal(result.code, 0, `observe-schema always exits 0; stderr=${result.stderr}`);
    assert.match(result.stdout, /observe-schema: widgets-fixture/);
    assert.match(result.stdout, new RegExp(`manifest: ${manifestPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(result.stdout, /stream: widgets/);
    assert.match(result.stdout, /samples: 4/);

    // Type mismatch: string observed where only integer is declared.
    assert.match(
      result.stdout,
      /\[TYPE-MISMATCH] count: observed type\(s\) \[string] not admitted by declared type\(s\) \[integer]/
    );
    // Enum violation: "deleted" is not in the declared enum.
    assert.match(result.stdout, /\[ENUM-VIOLATION] status: observed value outside declared enum: "deleted"/);
    // Observed-but-undeclared: extra_field never appears in the schema.
    assert.match(result.stdout, /\[OBSERVED-BUT-UNDECLARED] extra_field: observed but not declared in schema/);
    // Declared-but-never-observed: never_seen_field never appears in any sample.
    assert.match(
      result.stdout,
      /\[DECLARED-BUT-NEVER-OBSERVED] never_seen_field: declared but never observed in any sample/
    );

    // label is nullable in the schema and null is observed — must NOT be flagged.
    assert.doesNotMatch(result.stdout, /TYPE-MISMATCH] label/);
    // score: declared `number`, every observed sample is an integer-valued
    // number — must NOT be flagged (the fix 6a case).
    assert.doesNotMatch(result.stdout, /TYPE-MISMATCH] score/);

    // gadgets: declared in the manifest but no records/gadgets.jsonl exists
    // at all -> the NO-SAMPLES divergence (fix 6b).
    assert.match(result.stdout, /stream: gadgets/);
    assert.match(result.stdout, /no records found for this stream/);
    assert.match(
      result.stdout,
      /\[NO-SAMPLES] \$stream: declared stream "gadgets" has zero observed samples — schema conformance was never checked against any real data/
    );

    // Final count line reflects exactly the four widgets divergences above
    // plus the one gadgets NO-SAMPLES divergence.
    assert.match(result.stdout, /divergences: 5/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("observe-schema CLI: jellyfin's real pilot-real-shape fixtures report zero divergences", () => {
  const result = runCli(["jellyfin"]);

  assert.equal(result.code, 0, `expected exit 0; stderr=${result.stderr}`);
  assert.match(result.stdout, /observe-schema: jellyfin/);
  assert.match(result.stdout, /stream: libraries/);
  assert.match(result.stdout, /stream: items/);
  // Every per-stream DIVERGENCES block must be empty for jellyfin's
  // committed pilot fixtures, which are known to conform to the manifest.
  assert.doesNotMatch(result.stdout, /\[TYPE-MISMATCH]/);
  assert.doesNotMatch(result.stdout, /\[ENUM-VIOLATION]/);
  assert.doesNotMatch(result.stdout, /\[OBSERVED-BUT-UNDECLARED]/);
  assert.doesNotMatch(result.stdout, /\[DECLARED-BUT-NEVER-OBSERVED]/);
  assert.doesNotMatch(result.stdout, /\[NO-SAMPLES]/);
  assert.match(result.stdout, /divergences: 0/);
});
