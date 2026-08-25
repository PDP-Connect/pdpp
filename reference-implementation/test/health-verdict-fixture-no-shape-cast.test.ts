// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bans `as unknown as ConnectionHealthSnapshot` / `as unknown as RenderedVerdict`
 * in the reference test tree.
 *
 * THE DRIFT THIS PREVENTS. A test that hand-builds one of these types is keeping
 * a second, unversioned copy of a producer's contract
 * (`computeConnectionHealth`, `runtime/connection-health.ts`;
 * `synthesizeRenderedVerdict`, `runtime/rendered-verdict.ts`). The compiler is
 * the only thing that keeps that copy honest, and `as unknown as` switches it
 * off — the double cast erases the shape check entirely, so a fixture can invent
 * axes that do not exist and omit the ones the renderer actually reads while
 * still compiling and still passing.
 *
 * That is not theoretical. `rendered-verdict-proof-age.test.ts` was born drifted
 * in `345e6672d`: it supplied invented `credential`/`runtime` axes and omitted
 * `attention`/`outbox`. Measured through the real renderer, its self-described
 * "green, fresh, fully-covered connection" produced `pill: {}` — no label, no
 * tone — and `channel: "attention"`. The suite passed 10/10 for the whole time,
 * because every assertion read only the freshness annotation.
 *
 * Three owner-visible defects have already shipped through this class of blind
 * spot in the status pipeline:
 *   - `8c85a2261` — the freshness sentence printed twice on 22 of 28 owner-visible rows.
 *   - `1231479d7` — archived sources rendered a green "Healthy" line.
 *   - the 2026-08-19 live defect — 299,248 retained records displayed as "Holding 0 records".
 *
 * WHAT THIS IS NOT. This is a boundary-specific ban, not a style rule about
 * casts. `as unknown as` stays legitimate everywhere else in this tree (wire
 * payloads, structural stand-ins for driver types, deliberately malformed input),
 * and this test does not touch those. It bans the cast at exactly the seam where
 * it destroys producer-drift detection.
 *
 * WHAT IT DOES NOT CATCH. Type checking proves SHAPE, not COHERENCE: a fixture
 * can still pair `state: "healthy"` with `outbox: "stalled"`, a tuple the real
 * projection never emits. Removing the cast is the floor, not the ceiling — the
 * ceiling is asserting on the projection the owner actually reads (see the
 * control test at the top of `rendered-verdict-proof-age.test.ts`).
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The producer output types whose hand-built fixtures must stay compiler-checked.
 * `as unknown as` is matched with flexible whitespace so a reformat cannot
 * smuggle one past.
 */
const BANNED_CAST_PATTERN = /as\s+unknown\s+as\s+(ConnectionHealthSnapshot|RenderedVerdict)\b/;

function listTestFiles(): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "fixtures") {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".test.ts")) {
        out.push(full);
      }
    }
  }
  walk(TEST_DIR);
  return out;
}

test("no reference test casts around ConnectionHealthSnapshot or RenderedVerdict", () => {
  const offenders: string[] = [];
  for (const file of listTestFiles()) {
    // This file names the banned pattern in order to ban it.
    if (file === fileURLToPath(import.meta.url)) {
      continue;
    }
    const lines = readFileSync(file, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      if (BANNED_CAST_PATTERN.test(line)) {
        offenders.push(`${file.slice(TEST_DIR.length + 1)}:${index + 1}: ${line.trim()}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    [
      "A hand-built health/verdict fixture must stay compiler-checked against its producer.",
      "`as unknown as` erases that check and lets the fixture invent or omit axes.",
      "Build the fixture with every field present and no cast — see",
      "`connector-verdict-input-mappers.test.ts` for the shape to mirror.",
      "",
      ...offenders,
    ].join("\n")
  );
});

/**
 * The guard is only worth its line count if the pattern it bans is the pattern
 * that actually shipped. This pins the regex against the exact text of the
 * original defect, so a future "simplification" of the regex cannot quietly
 * stop matching it.
 */
test("the ban matches the exact cast that hid the empty-pill defect", () => {
  assert.match("  } as unknown as ConnectionHealthSnapshot;", BANNED_CAST_PATTERN);
  assert.match("  } as unknown as RenderedVerdict;", BANNED_CAST_PATTERN);
  assert.match("} as  unknown  as  RenderedVerdict;", BANNED_CAST_PATTERN);
});

/**
 * ...and that it stays narrow. These are the legitimate neighbouring casts
 * already in this tree; the ban must not creep into a blanket style rule.
 */
test("the ban does not touch legitimate casts elsewhere in the tree", () => {
  for (const legitimate of [
    "  } as unknown as ComputeConnectionHealthInput;",
    "} as unknown as Parameters<typeof liveRetainedRecordsOrNull>[0];",
    "const resultRecord = result as unknown as Record<string, unknown>;",
    "approved.grant.streams as unknown as ResolvedStream[];",
    "  const snapshot: ConnectionHealthSnapshot = build();",
  ]) {
    assert.doesNotMatch(legitimate, BANNED_CAST_PATTERN);
  }
});
