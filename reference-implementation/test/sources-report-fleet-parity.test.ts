// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Whole-fleet parity test: the `sources-report` CLI and the console `/sources`
 * page must agree, for EVERY row, on the dot/tone, the pill label, and the
 * fused summary line.
 *
 * Why this exists (owner ruling, 2026-08-23): a real production row (Slack)
 * was observed reading green "Healthy" in the CLI while the `/sources` page
 * read gray "Not measured" for the same connection at the same moment. Root
 * cause: `sources-report-model.ts` used to hand-port a PARTIAL, independently
 * ranked copy of the console's `deriveRenderedSourceStatus` — it never
 * learned the `setup_failed`/`setup_in_progress`/`running` branches the
 * console added later, so a `setup_failed` Venmo connection (status
 * "revoked" AND source_visibility "setup_failed") fell through to the CLI's
 * generic "revoked" branch and printed "Revoked" where the console prints
 * the more specific "Setup never completed" plus the server's exact forward
 * statement. "The measurement instrument lying is worse than any single row
 * lying" — so the CLI must consume the SAME derivation the page consumes,
 * not a hand-copied third one, and this test must fail the instant that
 * stops being true for ANY row in the fleet.
 *
 * The fixture (`fixtures/sources-report-fleet-parity-0825.json`) is a
 * captured, PII-scrubbed snapshot of a real production `/_ref/connectors`
 * response: 34 connections spanning every pill tone (green/amber/red/grey),
 * every lifecycle branch (active, revoked, paused, archived,
 * setup_failed), and both single- and multi-instance connectors. Real
 * emails/names were replaced with synthetic placeholders and connection ids
 * were rehashed; every structurally-relevant field (status, source_
 * visibility, owner_state, rendered_verdict, connection_health, last_run,
 * terminal_setup_disposition) is untouched, so this fixture reproduces the
 * exact ranking decisions the console and CLI must agree on.
 *
 * This is a FIXTURE-based test (per the task's hard rule): no live server, no
 * network call. Both "surfaces" are computed by calling real production code
 * against the same in-memory snapshot:
 *   - "page" = `@pdpp/display`'s `projectSourceVerdict`, called directly by
 *     this test. It is the function the console's `projectSourceActionability`
 *     calls for `renderedStatus`/`fusedStatus`, so this compares the CLI to the
 *     page's real producer without importing `apps/console/**` — which
 *     `ri-zero-connector-knowledge-conformance` bars, and rightly: an earlier
 *     attempt reached across that boundary and was reverted.
 *   - "CLI" = `sources-report-model.ts`'s `projectSourceRow`, which calls the
 *     SAME package function.
 *
 * That both sides now route to one producer is the point. The test still earns
 * its keep: it pins the CLI's row projection (dot/kind/label/fusedLine) to that
 * producer's output across every lifecycle branch, so re-introducing a local
 * re-derivation in the CLI — the exact defect this replaced — fails here.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { projectSourceVerdict, type SourceStatusInput } from "@pdpp/display";
import { type ConnectorSummaryLike, projectSourceRow } from "../scripts/sources-report-model.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/sources-report-fleet-parity-0825.json", import.meta.url));
const fleet: Record<string, unknown>[] = JSON.parse(readFileSync(fixturePath, "utf8"));

test("fleet fixture is non-trivial: covers every pill tone and every lifecycle branch", () => {
  // Guards the guard: a fixture that shrank to one row (or lost its
  // diversity) would make the parity test below pass vacuously.
  assert.ok(fleet.length >= 30, `expected a whole-fleet fixture, got ${fleet.length} rows`);

  const tones = new Set(
    fleet
      .map((row) => (row.rendered_verdict as Record<string, unknown> | null)?.pill)
      .map((pill) => (pill as Record<string, unknown> | undefined)?.tone)
  );
  for (const tone of ["green", "amber", "red", "grey"]) {
    assert.ok(tones.has(tone), `fixture is missing a "${tone}"-tone row`);
  }

  const statuses = new Set(fleet.map((row) => row.status));
  assert.ok(statuses.has("revoked"), "fixture is missing a revoked row");
  assert.ok(statuses.has("paused"), "fixture is missing a paused row");
  assert.ok(statuses.has("active"), "fixture is missing an active row");

  const visibilities = new Set(fleet.map((row) => row.source_visibility));
  assert.ok(visibilities.has("archived"), "fixture is missing an archived row");
  assert.ok(visibilities.has("setup_failed"), "fixture is missing a setup_failed row");
});

// The `todo` marker this test carried from 2026-08-25 is GONE, removed in the
// same commit that shipped the extraction — it had to go green by being FIXED,
// never by being retired. It now asserts, and it passes fleet-wide.
test("every row in the fleet: CLI and console agree on dot, tone, label, and fused line", () => {
  const divergences: string[] = [];

  for (const [index, summary] of fleet.entries()) {
    const rowLabel = `#${index} ${summary.connector_id ?? "?"} / ${summary.connection_id ?? "?"}`;

    // The page's producer, called directly on the raw fixture row.
    const pageProjection = projectSourceVerdict(summary as SourceStatusInput);
    const cliRow = projectSourceRow(summary as ConnectorSummaryLike);

    if (cliRow.status.dot !== pageProjection.renderedStatus.dot) {
      divergences.push(
        `${rowLabel}: dot diverged — CLI="${cliRow.status.dot}" page="${pageProjection.renderedStatus.dot}"`
      );
    }
    if (cliRow.status.kind !== pageProjection.renderedStatus.kind) {
      divergences.push(
        `${rowLabel}: kind diverged — CLI="${cliRow.status.kind}" page="${pageProjection.renderedStatus.kind}"`
      );
    }
    if (cliRow.status.label !== pageProjection.renderedStatus.label) {
      divergences.push(
        `${rowLabel}: pill label diverged — CLI="${cliRow.status.label}" page="${pageProjection.renderedStatus.label}"`
      );
    }
    // A real two-line comparison now: the CLI emits its own fused line, so the
    // absence-as-divergence placeholder this test used to record is gone.
    if (cliRow.fusedLine !== pageProjection.fusedStatus.line) {
      divergences.push(
        `${rowLabel}: fused summary line diverged — CLI="${cliRow.fusedLine}" page="${pageProjection.fusedStatus.line}"`
      );
    }
  }

  assert.deepEqual(
    divergences,
    [],
    `${divergences.length} row(s) diverged between the CLI and the page:\n${divergences.join("\n")}`
  );
});
