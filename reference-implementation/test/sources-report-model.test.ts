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
const VERDICT_TONE_STATUS_DEF_RE = /const VERDICT_TONE_STATUS\s*[:=]/;
const COVERAGE_LABELS_DEF_RE = /const COVERAGE_LABELS\s*[:=]/;
const FRESHNESS_LABELS_DEF_RE = /const FRESHNESS_LABELS\s*[:=]/;
const OUTBOX_LABELS_DEF_RE = /const OUTBOX_LABELS\s*[:=]/;
const ATTENTION_LABELS_DEF_RE = /const ATTENTION_LABELS\s*[:=]/;
const DISPLAY_IMPORT_RE = /from "@pdpp\/display"/;
const DISPLAY_HEALTH_IMPORT_RE = /from "@pdpp\/display\/health"/;

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

test("the tone→glyph table has exactly ONE definition, in @pdpp/display", () => {
  // This test used to diff the CLI's own tone table against the console's,
  // because there were two. The extraction left one, owned by
  // `packages/display/src/source/source-status.ts`, so the check that matters
  // changed shape: assert the table lives THERE and that neither surface has
  // grown a replacement copy. A restated table is the drift this whole change
  // was made to prevent.
  const packageSource = readFileSync(
    fileURLToPath(new URL("../../packages/display/src/source/source-status.ts", import.meta.url)),
    "utf8"
  );
  const table = packageSource.slice(
    packageSource.indexOf("const VERDICT_TONE_STATUS"),
    packageSource.indexOf("};", packageSource.indexOf("const VERDICT_TONE_STATUS"))
  );
  assert.ok(table.length > 0, "could not locate VERDICT_TONE_STATUS in @pdpp/display");

  for (const [tone, expected] of [
    ["amber", { dot: "◐", kind: "degraded" }],
    ["green", { dot: "●", kind: "healthy" }],
    ["grey", { dot: "○", kind: "unknown" }],
    ["red", { dot: "⊘", kind: "blocked" }],
  ] as const) {
    const line = table.split("\n").find((l) => l.trim().startsWith(`${tone}:`));
    assert.ok(line, `the shared table has no row for tone "${tone}"`);
    assert.ok(
      line.includes(`dot: "${expected.dot}"`),
      `shared table draws a different glyph for "${tone}": ${line.trim()}`
    );
    assert.ok(
      line.includes(`kind: "${expected.kind}"`),
      `shared table uses a different kind for "${tone}": ${line.trim()}`
    );

    // And the CLI actually renders through that table.
    const row = projectSourceRow(summary({ rendered_verdict: { pill: { label: "x", tone } } }));
    assert.equal(row.status.dot, expected.dot);
    assert.equal(row.status.kind, expected.kind);
  }

  // Neither surface may restate it.
  for (const relPath of [
    "../../apps/console/src/app/(console)/lib/source-actionability.ts",
    "../scripts/sources-report-model.ts",
  ]) {
    const source = readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), "utf8");
    assert.doesNotMatch(
      source,
      VERDICT_TONE_STATUS_DEF_RE,
      `${relPath} must not define a second tone→glyph table; @pdpp/display owns it`
    );
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
    COVERAGE_LABELS_DEF_RE,
    "apps/console/src/app/(console)/lib/connection-evidence.ts must not define a duplicate COVERAGE_LABELS table"
  );
  assert.doesNotMatch(
    consoleEvidenceSource,
    FRESHNESS_LABELS_DEF_RE,
    "apps/console/src/app/(console)/lib/connection-evidence.ts must not define a duplicate FRESHNESS_LABELS table"
  );
  assert.doesNotMatch(
    consoleEvidenceSource,
    OUTBOX_LABELS_DEF_RE,
    "apps/console/src/app/(console)/lib/connection-evidence.ts must not define a duplicate OUTBOX_LABELS table"
  );
  assert.doesNotMatch(
    consoleEvidenceSource,
    ATTENTION_LABELS_DEF_RE,
    "apps/console/src/app/(console)/lib/connection-evidence.ts must not define a duplicate ATTENTION_LABELS table"
  );
  assert.match(
    consoleEvidenceSource,
    DISPLAY_IMPORT_RE,
    "apps/console/src/app/(console)/lib/connection-evidence.ts must import formatters from @pdpp/display"
  );

  // 2. Structural check on CLI model source: verify CLI imports from @pdpp/display/health.
  const cliModelSource = readFileSync(
    fileURLToPath(new URL("../scripts/sources-report-model.ts", import.meta.url)),
    "utf8"
  );
  assert.match(
    cliModelSource,
    DISPLAY_HEALTH_IMPORT_RE,
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
  const consoleEvidenceModuleSpecifier = ["..", "..", "apps", "console", "src", "app", "(console)", "lib"].join("/");
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
    if (outbox === "unknown") {
      assert.equal(cliRow.axes.outbox, "not measured");
    } else {
      assert.equal(
        cliRow.axes.outbox,
        outboxChip.value,
        `CLI axes.outbox (${cliRow.axes.outbox}) diverged from console chip value (${outboxChip.value}) for axis "${outbox}"`
      );
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

/**
 * The defect this CLI's extraction closed, pinned on the CLI side.
 *
 * A setup-failed connection arrives as status `revoked` AND
 * `source_visibility: "setup_failed"`. The CLI's old hand-ported ranking had no
 * `setup_failed` branch, so those rows fell through to its generic `revoked`
 * branch and printed "Revoked" while the `/sources` page printed the more
 * specific "Setup never completed". Six real Venmo rows read that way.
 *
 * This test does NOT go through the fleet-parity test's comparison, and that is
 * deliberate. Now that both surfaces call one producer they agree by
 * construction, so a parity assertion cannot catch a regression INSIDE the
 * shared ranking — both sides would move together and still match. This pins
 * the CLI's output to the literal owner-facing words instead.
 */
test("setup-failed source: the CLI prints the specific terminal state, never the generic 'Revoked'", () => {
  const row = projectSourceRow(
    summary({
      connector_id: "venmo",
      display_name: "Venmo",
      rendered_verdict: {
        annotations: [],
        forward_statement: "Setup never completed for this connection.",
        pill: { label: "Archived", tone: "grey" },
      },
      source_visibility: "setup_failed",
      status: "revoked",
    })
  );

  assert.equal(row.status.kind, "setup_failed");
  assert.equal(row.status.label, "Setup never completed");
  assert.notEqual(row.status.label, "Revoked");
  // The card text the owner reads, which the CLI had no counterpart to at all
  // before the extraction. "Never updated" because no run ever succeeded here.
  assert.equal(row.fusedLine, "Setup never completed · Never updated");
});

/**
 * The archived branch ranks ahead of every verdict-derived tone, including a
 * stale green one. Pinned CLI-side for the same reason as the test above: this
 * is the fabricated-green defect class, and parity alone cannot see it.
 */
test("archived source: a stale green verdict never renders as healthy", () => {
  const row = projectSourceRow(
    summary({
      last_successful_run: { status: "succeeded" },
      rendered_verdict: {
        annotations: [],
        forward_statement: "Collection is complete.",
        pill: { label: "Healthy", tone: "green" },
      },
      source_visibility: "archived",
      status: "paused",
    })
  );

  assert.equal(row.status.kind, "archived");
  assert.equal(row.status.label, "Archived · not collecting");
  assert.equal(row.fusedLine, "Archived · not collecting");
});
