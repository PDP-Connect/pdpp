// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the `sources-report` CLI projection.
 *
 * The fixtures here are trimmed from a real `/_ref/connectors?sources_
 * visibility=1` response captured on 2026-08-22, and the expectations are the
 * verdicts the OWNER read off the `/sources` page on the same day. That makes
 * this suite the regression guard for the divergence the CLI exists to close:
 * if the projection ever stops reproducing what the owner sees, these fail.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  type ConnectorSummaryLike,
  projectSourceRow,
  uncommittedCompleteStreams,
} from "../scripts/sources-report-model.ts";

const PAUSED_WORD_RE = /paused/i;

function summary(overrides: Partial<ConnectorSummaryLike>): ConnectorSummaryLike {
  return { connector_id: "example", display_name: "Example", status: "active", ...overrides };
}

test("apple contacts: grey pill renders an empty circle and 'Not measured'", () => {
  const row = projectSourceRow(
    summary({
      connection_health: { axes: { coverage: "unknown", freshness: "fresh", outbox: "unknown" } },
      connector_id: "apple_contacts",
      display_name: "Apple Contacts",
      rendered_verdict: {
        annotations: [{ kind: "freshness", text: "Fresh today." }],
        forward_statement: "Coverage has not been measured yet.",
        pill: { label: "Not measured", tone: "grey" },
        streams: [
          { collected: 0, considered: 1, coverage: "complete", stream_id: "address_books" },
          { collected: 0, considered: 0, coverage: "complete", stream_id: "contact_groups" },
          { collected: 0, considered: null, coverage: "unknown", stream_id: "contacts" },
        ],
      },
    })
  );

  assert.equal(row.status.dot, "○");
  assert.equal(row.status.kind, "unknown");
  assert.equal(row.status.label, "Not measured · Fresh today.");
  assert.deepEqual(
    row.streams.map((s) => `${s.stream}=${s.coverageLabel}`),
    ["address_books=coverage complete", "contact_groups=coverage complete", "contacts=coverage not measured"]
  );
  // `contacts` has no denominator; the report must not invent "0 of 0".
  assert.equal(row.streams[2]?.countsLabel, null);
  assert.equal(row.streams[0]?.countsLabel, "0 of 1 covered");
});

test("peregrine Claude Code: red pill renders the interdict glyph and carries the freshness note", () => {
  const row = projectSourceRow(
    summary({
      connection_health: { axes: { coverage: "unknown", freshness: "unknown", outbox: "stalled" } },
      display_name: "peregrine Claude Code",
      rendered_verdict: {
        annotations: [{ kind: "freshness", text: "freshness has not been measured yet" }],
        pill: { label: "Can't collect", tone: "red" },
        streams: [
          { coverage: "unknown", stream_id: "messages" },
          { coverage: "inventory_only", stream_id: "cache_inventory" },
          { coverage: "retryable_gap", stream_id: "local-collector/connector_child_failure" },
        ],
      },
    })
  );

  assert.equal(row.status.dot, "⊘");
  assert.equal(row.status.kind, "blocked");
  assert.equal(row.status.label, "Can't collect · freshness has not been measured yet");
  assert.deepEqual(
    row.streams.map((s) => s.coverageLabel),
    ["coverage not measured", "coverage complete (list only, by design)", "coverage retryable gap"]
  );
  assert.equal(row.axes.freshness, "not measured");
  assert.equal(row.axes.outbox, "stalled");
});

test('gmail: terminal_gap renders "won\'t backfill", never the wire key', () => {
  const row = projectSourceRow(
    summary({
      display_name: "Gmail",
      rendered_verdict: {
        pill: { label: "Missing data", tone: "amber" },
        streams: [
          { collected: 4, considered: 4, coverage: "complete", stream_id: "messages" },
          { coverage: "unknown", stream_id: "message_bodies" },
          { collected: 0, considered: 0, coverage: "terminal_gap", stream_id: "attachments" },
        ],
      },
    })
  );

  assert.equal(row.status.dot, "◐");
  assert.equal(row.streams[2]?.coverageLabel, "coverage won't backfill");
  assert.equal(row.streams[2]?.coverageKey, "terminal_gap");
});

test("usaa: complete-with-uncommitted-checkpoint is reported, not hidden (ledger B5)", () => {
  const row = projectSourceRow(
    summary({
      collection_report: [
        { checkpoint: "not_committed", coverage_condition: "complete", stream: "accounts" },
        { checkpoint: "committed", coverage_condition: "complete", stream: "account_stats" },
        {
          checkpoint: "committed",
          coverage_condition: "terminal_gap",
          skipped: "pdf_template_unknown",
          stream: "transactions",
        },
      ],
      connector_id: "usaa",
      display_name: "USAA",
      rendered_verdict: {
        pill: { label: "Missing data", tone: "amber" },
        streams: [
          { collected: 5, considered: 5, coverage: "complete", stream_id: "account_stats" },
          { collected: 0, considered: 5, coverage: "complete", stream_id: "accounts" },
          { collected: 2, considered: 4, coverage: "terminal_gap", stream_id: "transactions" },
        ],
      },
    })
  );

  // The rendered coverage word is unchanged — this CLI reports what the page
  // shows, it does not editorialize the verdict.
  const accounts = row.streams.find((s) => s.stream === "accounts");
  assert.equal(accounts?.coverageLabel, "coverage complete");
  assert.equal(accounts?.countsLabel, "0 of 5 covered");
  // ...but the uncommitted checkpoint is now visible rather than invisible.
  assert.equal(accounts?.checkpoint, "not_committed");
  assert.equal(row.streams.find((s) => s.stream === "transactions")?.skipped, "pdf_template_unknown");

  assert.deepEqual(uncommittedCompleteStreams([row]), [
    { countsLabel: "0 of 5 covered", displayName: "USAA", stream: "accounts" },
  ]);
});

test("a revoked connection never shows a stale verdict tone as its health", () => {
  const row = projectSourceRow(
    summary({
      display_name: "Venmo",
      rendered_verdict: { pill: { label: "Healthy", tone: "green" } },
      status: "revoked",
    })
  );
  assert.equal(row.status.dot, "⊘");
  assert.equal(row.status.kind, "revoked");
  assert.equal(row.status.label, "Revoked");
});

test("an archived source reads 'Archived', not the paused lifecycle it usually also carries", () => {
  // The regression this pins: an archived row is USUALLY `paused` and still
  // carries the stored verdict from when it was live. Ranking `paused` (or the
  // verdict) first printed "⏸ Paused" — and, before the server-side fix,
  // "Reconnect this account", a promise that leads nowhere because
  // reconnecting mints a new connection and resumes nothing.
  const row = projectSourceRow(
    summary({
      display_name: "Amazon (recovered fragment)",
      rendered_verdict: {
        pill: { label: "Paused", tone: "grey" },
        required_actions: [{ cta: "Reconnect this account" }],
      },
      source_visibility: "archived",
      status: "paused",
    })
  );

  assert.equal(row.status.kind, "archived");
  assert.equal(row.status.label, "Archived · not collecting");
  assert.equal(row.status.dot, "⊘");
  assert.doesNotMatch(row.status.label, PAUSED_WORD_RE, "an archived row must not read as merely paused");
});

test("archived outranks revoked and the verdict tone, matching the console's ranking", () => {
  // Ordering proof: if the archived branch were moved below either check, one
  // of these would fall through to "Revoked" or to the green verdict.
  for (const status of ["revoked", "paused", "active"]) {
    const row = projectSourceRow(
      summary({
        rendered_verdict: { pill: { label: "Healthy", tone: "green" } },
        source_visibility: "archived",
        status,
      })
    );
    assert.equal(row.status.kind, "archived", `archived must outrank status="${status}"`);
  }
});

test("the retired 'hidden_from_sources' spelling still classifies as archived", () => {
  // An older reference server has not been renamed yet; failing toward the
  // safe reading keeps those rows from rendering as live sources.
  const row = projectSourceRow(
    summary({
      rendered_verdict: { pill: { label: "Healthy", tone: "green" } },
      source_visibility: "hidden_from_sources",
    })
  );
  assert.equal(row.status.kind, "archived");
});

test("an active source_visibility never triggers the archived branch", () => {
  // Guards the inverse mutation: a predicate that returned true unconditionally
  // would archive the whole fleet, and every other test here would still pass.
  const row = projectSourceRow(
    summary({ rendered_verdict: { pill: { label: "Healthy", tone: "green" } }, source_visibility: "active" })
  );
  assert.equal(row.status.kind, "healthy");
  assert.equal(row.status.label, "Healthy");
});

test("a summary with no rendered_verdict reads honest 'Verdict unavailable', never a guess", () => {
  const row = projectSourceRow(
    summary({
      connection_health: { axes: { coverage: "complete", freshness: "fresh", outbox: "idle" }, state: "healthy" },
    })
  );
  // The health snapshot says "healthy" on every axis, but with no verdict the
  // console renders `○ / unknown` — reconstructing green from raw axes is
  // exactly the client-side fallback the state-model convergence removed.
  assert.equal(row.status.dot, "○");
  assert.equal(row.status.kind, "unknown");
  assert.equal(row.status.label, "Verdict unavailable");
});

test("an unrecognized tone from a newer server degrades to unknown rather than throwing", () => {
  const row = projectSourceRow(summary({ rendered_verdict: { pill: { label: "Sparkling", tone: "chartreuse" } } }));
  assert.equal(row.status.kind, "unknown");
  assert.equal(row.status.label, "Verdict unavailable");
});

test("the tone→glyph table matches the console's VERDICT_TONE_STATUS", () => {
  // The CLI restates the console's tone table (it drops the CSS tone token,
  // which is meaningless in a terminal). This asserts the shared part against
  // the console source so the two cannot drift silently apart.
  const consoleSource = readFileSync(
    fileURLToPath(new URL("../../apps/console/src/app/(console)/lib/source-actionability.ts", import.meta.url)),
    "utf8"
  );
  const table = consoleSource.slice(
    consoleSource.indexOf("const VERDICT_TONE_STATUS"),
    consoleSource.indexOf("};", consoleSource.indexOf("const VERDICT_TONE_STATUS"))
  );
  assert.ok(table.length > 0, "could not locate VERDICT_TONE_STATUS in the console source");

  for (const [tone, expected] of [
    ["amber", { dot: "◐", kind: "degraded" }],
    ["green", { dot: "●", kind: "healthy" }],
    ["grey", { dot: "○", kind: "unknown" }],
    ["red", { dot: "⊘", kind: "blocked" }],
  ] as const) {
    const line = table.split("\n").find((l) => l.trim().startsWith(`${tone}:`));
    assert.ok(line, `console table has no row for tone "${tone}"`);
    assert.ok(
      line.includes(`dot: "${expected.dot}"`),
      `console draws a different glyph for "${tone}" than the CLI: ${line.trim()}`
    );
    assert.ok(
      line.includes(`kind: "${expected.kind}"`),
      `console uses a different kind for "${tone}" than the CLI: ${line.trim()}`
    );

    const row = projectSourceRow(summary({ rendered_verdict: { pill: { label: "x", tone } } }));
    assert.equal(row.status.dot, expected.dot);
    assert.equal(row.status.kind, expected.kind);
  }
});

test("structural divergence guard: console and CLI share exactly ONE definition of axis vocabulary", async () => {
  // 1. Structural check on console source: verify console does NOT define duplicate axis tables.
  const consoleEvidenceSource = readFileSync(
    fileURLToPath(new URL("../../apps/console/src/app/(console)/lib/connection-evidence.ts", import.meta.url)),
    "utf8"
  );
  assert.doesNotMatch(
    consoleEvidenceSource,
    /const COVERAGE_LABELS\s*[:=]/,
    "apps/console/src/app/(console)/lib/connection-evidence.ts must not define a duplicate COVERAGE_LABELS table"
  );
  assert.doesNotMatch(
    consoleEvidenceSource,
    /const FRESHNESS_LABELS\s*[:=]/,
    "apps/console/src/app/(console)/lib/connection-evidence.ts must not define a duplicate FRESHNESS_LABELS table"
  );
  assert.doesNotMatch(
    consoleEvidenceSource,
    /const OUTBOX_LABELS\s*[:=]/,
    "apps/console/src/app/(console)/lib/connection-evidence.ts must not define a duplicate OUTBOX_LABELS table"
  );
  assert.doesNotMatch(
    consoleEvidenceSource,
    /const ATTENTION_LABELS\s*[:=]/,
    "apps/console/src/app/(console)/lib/connection-evidence.ts must not define a duplicate ATTENTION_LABELS table"
  );
  assert.match(
    consoleEvidenceSource,
    /from "@pdpp\/display"/,
    "apps/console/src/app/(console)/lib/connection-evidence.ts must import formatters from @pdpp/display"
  );

  // 2. Structural check on CLI model source: verify CLI imports from @pdpp/display/health.
  const cliModelSource = readFileSync(
    fileURLToPath(new URL("../scripts/sources-report-model.ts", import.meta.url)),
    "utf8"
  );
  assert.match(
    cliModelSource,
    /from "@pdpp\/display\/health"/,
    "reference-implementation/scripts/sources-report-model.ts must import formatters from @pdpp/display/health"
  );

  // 3. Functional / runtime cross-surface parity check:
  // Dynamically import console's summarizeAxisChips and verify that for every axis input,
  // the CLI's projection and the console's chips produce identical display values.
  //
  // The specifier is built at runtime (not a string literal), and the result
  // is typed by hand instead of with `typeof import("literal path")`, so tsc
  // never statically resolves apps/console's module graph under this
  // package's stricter compiler options — apps/console has its own tsconfig
  // and its own typecheck script; this test only needs the runtime export.
  type SummarizeAxisChips = (
    axes: { attention: string; coverage: string; freshness: string; outbox: string },
    context?: { isLocalDeviceBacked?: boolean }
  ) => Array<{ dimension: string; value: string }>;
  const consoleEvidenceModuleSpecifier = ["..", "..", "apps", "console", "src", "app", "(console)", "lib"].join(
    "/"
  );
  const consoleEvidenceModule: { summarizeAxisChips: SummarizeAxisChips } = await import(
    `${consoleEvidenceModuleSpecifier}/connection-evidence.ts`
  );
  const { summarizeAxisChips } = consoleEvidenceModule;

  const coverageAxes = [
    "complete",
    "deferred",
    "gaps",
    "inventory_only",
    "partial",
    "retryable_gap",
    "terminal_gap",
    "unavailable",
    "unknown",
    "unsupported",
  ] as const;

  for (const cov of coverageAxes) {
    const consoleChips = summarizeAxisChips({
      attention: "none",
      coverage: cov,
      freshness: "fresh",
      outbox: "idle",
    });
    const coverageChip = consoleChips.find((c) => c.dimension === "Coverage");
    assert.ok(coverageChip, `console produced no coverage chip for ${cov}`);

    const cliRow = projectSourceRow(
      summary({
        connection_health: {
          axes: { attention: "none", coverage: cov, freshness: "fresh", outbox: "idle" },
        },
        rendered_verdict: {
          streams: [{ coverage: cov, stream_id: "test_stream" }],
        },
      })
    );

    assert.equal(
      cliRow.axes.coverage,
      coverageChip.value,
      `CLI axes.coverage (${cliRow.axes.coverage}) diverged from console chip value (${coverageChip.value}) for axis "${cov}"`
    );
    assert.equal(
      cliRow.streams[0]?.coverageLabel,
      `coverage ${coverageChip.value}`,
      `CLI stream coverageLabel (${cliRow.streams[0]?.coverageLabel}) diverged from console chip value (${coverageChip.value}) for axis "${cov}"`
    );
  }

  const freshnessAxes = ["fresh", "stale", "unknown"] as const;
  for (const fresh of freshnessAxes) {
    const consoleChips = summarizeAxisChips({
      attention: "none",
      coverage: "complete",
      freshness: fresh,
      outbox: "idle",
    });
    const freshnessChip = consoleChips.find((c) => c.dimension === "Freshness");
    assert.ok(freshnessChip, `console produced no freshness chip for ${fresh}`);

    const cliRow = projectSourceRow(
      summary({
        connection_health: {
          axes: { attention: "none", coverage: "complete", freshness: fresh, outbox: "idle" },
        },
      })
    );

    assert.equal(
      cliRow.axes.freshness,
      freshnessChip.value,
      `CLI axes.freshness (${cliRow.axes.freshness}) diverged from console chip value (${freshnessChip.value}) for axis "${fresh}"`
    );
  }

  const outboxAxes = ["active", "idle", "stalled", "unknown"] as const;
  for (const outbox of outboxAxes) {
    const consoleChips = summarizeAxisChips(
      {
        attention: "none",
        coverage: "complete",
        freshness: "fresh",
        outbox,
      },
      { isLocalDeviceBacked: true }
    );
    const outboxChip = consoleChips.find((c) => c.dimension === "Outbox");
    assert.ok(outboxChip, `console produced no outbox chip for ${outbox}`);

    const cliRow = projectSourceRow(
      summary({
        connection_health: {
          axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox },
        },
      })
    );

    // Note: on unknown with local-device backing, console sharpens to "evidence unavailable"
    // whereas bare axis formatter produces "not measured". Both are derived from display vocabulary.
    if (outbox !== "unknown") {
      assert.equal(
        cliRow.axes.outbox,
        outboxChip.value,
        `CLI axes.outbox (${cliRow.axes.outbox}) diverged from console chip value (${outboxChip.value}) for axis "${outbox}"`
      );
    } else {
      assert.equal(cliRow.axes.outbox, "not measured");
    }
  }

  // 4. Invariant assertions on owner-facing display copy:
  // These pin the owner-approved vocabulary. Any accidental rollback or typo fails immediately.
  const unknownRow = projectSourceRow(
    summary({
      connection_health: {
        axes: { coverage: "unknown", freshness: "unknown", outbox: "unknown" },
      },
      rendered_verdict: {
        streams: [{ coverage: "unknown", stream_id: "stream1" }],
      },
    })
  );
  assert.equal(unknownRow.axes.coverage, "not measured");
  assert.equal(unknownRow.axes.freshness, "not measured");
  assert.equal(unknownRow.axes.outbox, "not measured");
  assert.equal(unknownRow.streams[0]?.coverageLabel, "coverage not measured");

  const inventoryRow = projectSourceRow(
    summary({
      rendered_verdict: {
        streams: [{ coverage: "inventory_only", stream_id: "stream2" }],
      },
    })
  );
  assert.equal(inventoryRow.streams[0]?.coverageLabel, "coverage complete (list only, by design)");

  const terminalRow = projectSourceRow(
    summary({
      rendered_verdict: {
        streams: [{ coverage: "terminal_gap", stream_id: "stream3" }],
      },
    })
  );
  assert.equal(terminalRow.streams[0]?.coverageLabel, "coverage won't backfill");

  const deferredRow = projectSourceRow(
    summary({
      rendered_verdict: {
        streams: [{ coverage: "deferred", stream_id: "stream4" }],
      },
    })
  );
  assert.equal(deferredRow.streams[0]?.coverageLabel, "coverage optional, not collected");
});
