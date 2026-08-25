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
 * This is a FIXTURE-based test (per the task's hard rule): no live server,
 * no network call. Both "surfaces" are computed by calling real production
 * code against the same in-memory snapshot:
 *   - "page" = the console's own `projectSourceActionability` (source-
 *     actionability.ts), called directly by this test — NOT through the CLI
 *     module, so this is a genuine cross-surface comparison rather than the
 *     CLI being compared to itself.
 *   - "CLI" = `sources-report-model.ts`'s `projectSourceRow`, which (after
 *     this change) also calls `projectSourceActionability` internally, via a
 *     dynamic import of the same console module.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { type ConnectorSummaryLike, projectSourceRow } from "../scripts/sources-report-model.ts";

interface ConsoleRenderedStatus {
  dot: string;
  kind: string;
  label: string;
  tone: string;
}

interface ConsoleActionabilityProjection {
  fusedStatus: { line: string; tone: string };
  renderedStatus: ConsoleRenderedStatus;
}

interface ConsoleSourceActionabilityModule {
  projectSourceActionability: (connector: unknown) => ConsoleActionabilityProjection;
}

async function loadConsoleModule(): Promise<ConsoleSourceActionabilityModule> {
  const specifier = ["..", "..", "apps", "console", "src", "app", "(console)", "lib", "source-actionability.ts"].join(
    "/"
  );
  return (await import(specifier)) as ConsoleSourceActionabilityModule;
}

/**
 * Mirrors `normalizeForConsoleActionability`/`normalizeVerdictForConsoleActionability`
 * in `sources-report-model.ts` — filling the same `RefConnectorSummary`
 * always-present fields this fixture's rows already carry (a real
 * `/_ref/connectors` payload), so the "page" side of this test calls the
 * console function with the same shape the CLI internally normalizes to.
 * This is intentionally duplicated rather than imported: importing the
 * CLI's own normalizer would make this test partly check the CLI against
 * itself instead of an independent re-derivation.
 */
function normalizeForConsole(summary: Record<string, unknown>): unknown {
  const verdict = summary.rendered_verdict as Record<string, unknown> | null | undefined;
  return {
    ...summary,
    connection_health: summary.connection_health ?? { axes: {}, state: "unknown" },
    connection_id: summary.connection_id ?? "",
    connector_id: summary.connector_id ?? "",
    display_name: summary.display_name ?? "",
    freshness: {},
    last_run: summary.last_run ?? null,
    last_successful_run: summary.last_successful_run ?? null,
    manifest_version: null,
    next_action: null,
    rendered_verdict: verdict
      ? {
          ...verdict,
          annotations: verdict.annotations ?? [],
          channel: "calm",
          forward_statement: verdict.forward_statement ?? "",
          pill: verdict.pill ?? { label: "Verdict unavailable", tone: "grey" },
          required_actions: verdict.required_actions ?? [],
          streams: verdict.streams ?? [],
        }
      : null,
    schedule: null,
  };
}

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

test("every row in the fleet: CLI and console agree on dot, tone, label, and fused line", async () => {
  const { projectSourceActionability } = await loadConsoleModule();
  const divergences: string[] = [];

  for (const [index, summary] of fleet.entries()) {
    const rowLabel = `#${index} ${summary.connector_id ?? "?"} / ${summary.connection_id ?? "?"}`;

    const pageProjection = projectSourceActionability(normalizeForConsole(summary));
    // biome-ignore lint/performance/noAwaitInLoops: whole-fleet fixture assertion, not a hot path; sequential awaits keep failures attributable to a specific row.
    const cliRow = await projectSourceRow(summary as ConnectorSummaryLike);

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
