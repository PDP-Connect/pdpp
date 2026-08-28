// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCollectionReport,
  type CollectionReportEntry,
  type ConnectorDetailGapStoreLike,
  getUnfillableAccountedByStreamForInstanceIds,
  projectCollectionReport,
  type RuntimeCollectionFact,
  rollupCollectionReportCoverageOverride,
  rollupCollectionReportUnfillableAccounted,
} from "../server/ref-control.ts";

// server/ref-control.ts's ManifestStream/ConnectorRunSummary/etc. interfaces are
// module-local (not exported); derived here via Parameters<> so fixtures type
// against the REAL parameter shapes rather than duplicating or loosening them.
type BuildCollectionReportInput = Parameters<typeof buildCollectionReport>[0];
type ManifestStreamFixture = BuildCollectionReportInput["manifestStreams"][number];
type ProjectCollectionReportInput = Parameters<typeof projectCollectionReport>[0];
type ConnectorRunSummaryFixture = NonNullable<ProjectCollectionReportInput["lastRun"]>;
type ConnectionHealthSnapshotFixture = ProjectCollectionReportInput["connectionHealth"];
type ConnectionAxesFixture = ConnectionHealthSnapshotFixture["axes"];

/** Builds a fully-valid ConnectorRunSummary; unused fields get plausible constants (projectCollectionReport only reads collection_facts/last_at/run_id off it). */
function makeRun(
  overrides: Partial<ConnectorRunSummaryFixture> & Pick<ConnectorRunSummaryFixture, "run_id" | "status">
): ConnectorRunSummaryFixture {
  return {
    collection_facts: null,
    event_count: 0,
    failure_reason: null,
    finished_at: null,
    first_at: "2026-05-19T00:00:00.000Z",
    known_gaps: [],
    last_at: "2026-05-19T00:00:00.000Z",
    recovery_only: false,
    started_at: "2026-05-19T00:00:00.000Z",
    terminal_reason: null,
    ...overrides,
  };
}

/** Builds a fully-valid ConnectionAxes; projectCollectionReport only ever reads .freshness/.attention off it. */
function makeAxes(
  overrides: Partial<ConnectionAxesFixture> & Pick<ConnectionAxesFixture, "attention" | "freshness">
): ConnectionAxesFixture {
  return {
    coverage: "unknown",
    outbox: "idle",
    remote_surface: "none",
    ...overrides,
  };
}

/**
 * Builds a ConnectionHealthSnapshot from just axes. projectCollectionReport
 * only ever reads `.axes` and optionally-chains `.conditions`; the many
 * other owner-diagnostic fields ConnectionHealthSnapshot declares (badges,
 * collection_rate, dominant_condition_id, forward_disposition, etc.) are
 * irrelevant to the function under test, so this widens through
 * Partial<ConnectionHealthSnapshotFixture> (a same-shape, always-legal
 * assignment) rather than fabricating a dozen unused fields or reaching for
 * `as unknown as`.
 */
function makeHealth(axes: Parameters<typeof makeAxes>[0]): ConnectionHealthSnapshotFixture {
  const partial: Partial<ConnectionHealthSnapshotFixture> = {
    axes: makeAxes(axes),
    conditions: [],
  };
  return partial as ConnectionHealthSnapshotFixture;
}

// Pure unit tests for the Tranche C control-plane projection
// (`define-connector-progress-evidence-contract`, task 2.2b / 2.4 / 2.6).
//
// `buildCollectionReport` reads the runtime `collection_facts` block (objective
// per-stream facts: collected, considered-or-`unknown`, checkpoint, skip,
// pending-detail-gap count) and DERIVES, on read, each stream's coverage
// condition + forward disposition from those facts plus the connection-level
// freshness / attention / refresh evidence. The runtime stamped neither derived
// axis; this layer owns them.
//
// The single most important guarantee (2.4): a stream that collected records,
// recorded no gaps, and declared NO considered denominator reads `unknown` —
// NEVER `complete`. The exhaustive five-branch disposition logic is covered in
// `forward-disposition.test.js`; here we prove the per-stream coverage gate and
// the absence tolerances the projection must enforce before calling the helper.

/** A manual / paused / not-background-safe connection that cannot self-refresh. */
const MANUAL_REFRESH = Object.freeze({ backgroundSafe: false, recommendedMode: "manual" });
/** A schedulable, background-safe connection the scheduler refreshes on its own. */
const SCHEDULABLE_REFRESH = Object.freeze({ backgroundSafe: true, recommendedMode: "automatic" });

/** A runtime fact-block entry with honest defaults (no considered, no gaps, no skip). */
function fact(overrides: Partial<RuntimeCollectionFact> = {}): RuntimeCollectionFact {
  return {
    checkpoint: "committed",
    collected: 0,
    considered: null,
    covered: null,
    pending_detail_gaps: 0,
    skipped: null,
    stream: "transactions",
    ...overrides,
  };
}

/** Default projection inputs: fresh, no attention, schedulable. */
function report(
  facts: RuntimeCollectionFact[] | null,
  overrides: Partial<BuildCollectionReportInput> = {}
): CollectionReportEntry[] {
  return buildCollectionReport({
    attentionOpen: false,
    collectionFacts: facts === null ? null : { streams: facts },
    freshness: "fresh",
    manifestStreams: [],
    refresh: null,
    ...overrides,
  });
}

/** Find the single entry for `stream` in a report (asserts presence). */
function entryFor(entries: CollectionReportEntry[], stream: string): CollectionReportEntry {
  const entry = entries.find((e) => e.stream === stream);
  assert.ok(entry, `expected a Collection Report entry for stream "${stream}"`);
  return entry;
}

// ─── 2.4 the honesty gate (the single most important assertion) ───────────────

test("collected records, no gaps, NO considered -> unknown coverage + unmeasured (never complete)", () => {
  const entries = report([fact({ collected: 1145, considered: null, stream: "messages" })]);
  const entry = entryFor(entries, "messages");
  assert.equal(entry.considered, "unknown");
  assert.equal(entry.collected, 1145);
  // The core dishonesty the contract removes: a clean succeeded run with no
  // considered denominator MUST NOT read `complete`.
  assert.equal(entry.coverage_condition, "unknown");
  assert.equal(entry.forward_disposition, "unmeasured");
});

test("declared checkpoint-window strategy with committed checkpoint does NOT prove coverage without a denominator", () => {
  // Extends the invariant directly above: a declared strategy plus a committed
  // checkpoint is still not positive coverage evidence. The checkpoint records
  // where the cursor stopped, not what the source held — and a large
  // `collected` count is a yield, not a boundary. The stream reads honestly
  // unproven until the connector measures `considered` at its enumeration site.
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [fact({ checkpoint: "committed", collected: 1145, considered: null, stream: "messages" })],
    },
    freshness: "fresh",
    manifestStreams: [
      { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "messages" },
    ],
    refresh: null,
  });
  const entry = entryFor(entries, "messages");
  assert.equal(entry.considered, "unknown");
  assert.equal(entry.coverage_strategy, "checkpoint_window");
  assert.equal(entry.freshness_strategy, "scheduled_window");
  assert.equal(entry.coverage_condition, "unknown");
  assert.equal(entry.forward_disposition, "unmeasured");
});

test("declared checkpoint-window strategy with a measured boundary and committed checkpoint proves coverage", () => {
  // The other half: once the connector declares the boundary it enumerated, the
  // committed checkpoint closes the window and `collected` is free to be a
  // changed-record count below it.
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [fact({ checkpoint: "committed", collected: 12, considered: 1145, stream: "messages" })],
    },
    freshness: "fresh",
    manifestStreams: [
      { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "messages" },
    ],
    refresh: null,
  });
  const entry = entryFor(entries, "messages");
  assert.equal(entry.coverage_condition, "complete");
  assert.equal(entry.forward_disposition, "complete");
});

// ─── vacuous-zero coverage: a required stream that reported nothing ───────────
//
// A connector that emits NO coverage fact for a manifest-declared required
// stream must leave that stream `unknown`, never `complete`. This is the
// runtime half of the apple_contacts fix (production connection
// cin_d344ba53d6d95c7dd343393d): the connector withholds its DETAIL_COVERAGE on
// an incremental run that enumerated nothing, and the projection must carry
// that silence through as unproven rather than as "not owed".

test("required manifest stream with NO fact at all reads unknown, never complete", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    // The run reported a fact for `address_books` only. `contacts` is declared
    // and required, but the connector emitted no coverage for it.
    collectionFacts: { streams: [fact({ considered: 1, covered: 1, stream: "address_books" })] },
    freshness: "fresh",
    manifestStreams: [
      { coverage_strategy: "full_inventory", freshness_strategy: "scheduled_window", name: "address_books" },
      { coverage_strategy: "full_inventory", freshness_strategy: "scheduled_window", name: "contacts", required: true },
    ],
    refresh: null,
  });
  const contacts = entryFor(entries, "contacts");
  assert.equal(contacts.required, true);
  assert.equal(contacts.considered, "unknown");
  // The whole point: silence is unproven, not satisfied.
  assert.equal(contacts.coverage_condition, "unknown");
  // The stream that DID measure its boundary is untouched.
  assert.equal(entryFor(entries, "address_books").coverage_condition, "complete");
});

test("a measured considered:0 on a required stream still proves verified-empty coverage", () => {
  // Proof-of-emptiness must remain expressible. A connector that genuinely
  // enumerated the boundary and found nothing reports `considered: 0` and is
  // entitled to `complete` — this is the existing coherence-contract channel
  // (rule 2, `enumeration_boundary`) and the fix must not break it.
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [fact({ checkpoint: "committed", collected: 0, considered: 0, covered: 0, stream: "contacts" })],
    },
    freshness: "fresh",
    manifestStreams: [
      { coverage_strategy: "full_inventory", freshness_strategy: "scheduled_window", name: "contacts", required: true },
    ],
    refresh: null,
  });
  const entry = entryFor(entries, "contacts");
  assert.equal(entry.considered, 0);
  assert.equal(entry.coverage_condition, "complete");
});

test("a NON-required manifest stream with no fact is unchanged by the required-stream gate", () => {
  // Constraint: only required streams change behavior. An optional declared
  // stream with no fact reads `unknown` here too, but it must not roll up into
  // the connection axis — proven by the rollup test below.
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: { streams: [fact({ considered: 3, covered: 3, stream: "address_books" })] },
    freshness: "fresh",
    manifestStreams: [
      { coverage_strategy: "full_inventory", freshness_strategy: "scheduled_window", name: "address_books" },
      {
        coverage_strategy: "full_inventory",
        freshness_strategy: "scheduled_window",
        name: "canvases",
        required: false,
      },
    ],
    refresh: null,
  });
  const optional = entryFor(entries, "canvases");
  assert.equal(optional.required, false);
  assert.equal(optional.coverage_condition, "unknown");
  // The connection-level rollup only considers required streams, so an
  // optional unknown must NOT drag a complete axis to unknown.
  const optionalManifest: ManifestStreamFixture[] = [
    { coverage_strategy: "full_inventory", freshness_strategy: "scheduled_window", name: "address_books" },
    { coverage_strategy: "full_inventory", freshness_strategy: "scheduled_window", name: "canvases", required: false },
  ];
  assert.equal(rollupCollectionReportCoverageOverride("complete", entries, optionalManifest), null);
});

test("a required stream reading unknown drags the connection coverage axis off complete", () => {
  // The end-to-end consequence: this is what stops the Healthy pill. The axis
  // becomes `unknown`, which withholds healthy WITHOUT manufacturing a
  // degraded/"Can't collect" verdict.
  const manifestStreams: ManifestStreamFixture[] = [
    { coverage_strategy: "full_inventory", freshness_strategy: "scheduled_window", name: "address_books" },
    { coverage_strategy: "full_inventory", freshness_strategy: "scheduled_window", name: "contacts", required: true },
  ];
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: { streams: [fact({ considered: 1, covered: 1, stream: "address_books" })] },
    freshness: "fresh",
    manifestStreams,
    refresh: null,
  });
  const override = rollupCollectionReportCoverageOverride("complete", entries, manifestStreams);
  assert.equal(override, "unknown");
  // Explicitly NOT a degrading axis: unknown may withhold healthy, but it must
  // never manufacture a false red.
  assert.notEqual(override, "terminal_gap");
  assert.notEqual(override, "partial");
});

test("unreliable projection withholds required complete coverage but preserves optional policy outcomes", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: null,
    freshness: "fresh",
    localCoverage: {
      axis: "complete",
      evidenceAsOf: "2026-07-23T00:00:00.000Z",
      reliable: true,
      rows: [
        { status: "collected", stream: "required" },
        { status: "inventory_only", stream: "inventory" },
        { status: "deferred", stream: "deferred" },
      ],
      unaccountedStores: [],
    },
    manifestStreams: [
      { coverage_strategy: "checkpoint_window", name: "required" },
      { coverage_strategy: "snapshot_import_receipt", name: "inventory", required: false },
      { coverage_strategy: "snapshot_import_receipt", name: "deferred", required: false },
    ],
    refresh: null,
    requiredCoverageEvidenceAuthoritative: false,
  });
  const required = entryFor(entries, "required");
  assert.equal(required.considered, "unknown");
  assert.equal(required.covered, "unknown");
  assert.equal(required.checkpoint, "unknown");
  assert.equal(required.coverage_condition, "unknown");
  assert.equal(entryFor(entries, "inventory").coverage_condition, "inventory_only");
  assert.equal(entryFor(entries, "deferred").coverage_condition, "deferred");
});

test("declared coverage strategy without committed boundary does not fabricate completeness", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [fact({ checkpoint: "not_staged", collected: 1145, considered: null, stream: "messages" })],
    },
    freshness: "fresh",
    manifestStreams: [
      { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "messages" },
    ],
    refresh: null,
  });
  const entry = entryFor(entries, "messages");
  assert.equal(entry.coverage_strategy, "checkpoint_window");
  assert.equal(entry.coverage_condition, "unknown");
  assert.equal(entry.forward_disposition, "unmeasured");
});

test("owner-cancelled latest run reuses prior successful facts for stream coverage", () => {
  const cancelledRun = makeRun({
    event_count: 2,
    failure_reason: null,
    finished_at: "2026-05-19T12:10:00.000Z",
    first_at: "2026-05-19T12:09:00.000Z",
    known_gaps: [],
    last_at: "2026-05-19T12:10:00.000Z",
    run_id: "run_owner_cancelled",
    started_at: "2026-05-19T12:09:00.000Z",
    status: "cancelled",
    terminal_reason: "owner_cancelled",
  });
  const successfulRun = makeRun({
    collection_facts: {
      streams: [fact({ collected: 0, considered: 1125, covered: 1125, stream: "messages" })],
    },
    event_count: 3,
    failure_reason: null,
    finished_at: "2026-05-19T12:00:00.000Z",
    first_at: "2026-05-19T11:59:00.000Z",
    known_gaps: [],
    last_at: "2026-05-19T12:00:00.000Z",
    run_id: "run_success",
    started_at: "2026-05-19T11:59:00.000Z",
    status: "succeeded",
  });
  const entries = projectCollectionReport({
    connectionHealth: makeHealth({ attention: "none", freshness: "fresh" }),
    lastRun: cancelledRun,
    lastSuccessfulRun: successfulRun,
    manifestStreams: [
      { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "messages" },
    ],
    refreshPolicy: null,
  });
  const entry = entryFor(entries, "messages");

  assert.equal(entry.coverage_condition, "complete");
  assert.equal(entry.considered, 1125);
  assert.equal(entry.covered, 1125);
});

// Wave 10a live-evidence regression (2026-07-09): while a scheduled run is
// queued/starting/in_progress, it carries no `collection_facts` yet. Before
// `coverageClassifyingRun`'s fix, this nonterminal `lastRun` won outright
// (it is not owner-cancelled), so every previously-complete stream read
// unknown/unmeasured for the duration of the run. An active run must instead
// fall back to the prior successful run's proven coverage, exactly like the
// owner-cancel case above — active progress is a SEPARATE signal
// (`connectionHealth.badges.syncing` / `OwnerStateEvidence.progress.active`),
// not this function's concern.
test("active in-progress latest run preserves prior successful coverage (does not read unknown)", () => {
  const inProgressRun = makeRun({
    collection_facts: null,
    event_count: 0,
    failure_reason: null,
    finished_at: null,
    first_at: "2026-05-19T12:09:00.000Z",
    known_gaps: [],
    last_at: "2026-05-19T12:09:00.000Z",
    run_id: "run_in_progress",
    started_at: "2026-05-19T12:09:00.000Z",
    status: "in_progress",
    terminal_reason: null,
  });
  const successfulRun = makeRun({
    collection_facts: {
      streams: [fact({ collected: 0, considered: 1125, covered: 1125, stream: "messages" })],
    },
    event_count: 3,
    failure_reason: null,
    finished_at: "2026-05-19T12:00:00.000Z",
    first_at: "2026-05-19T11:59:00.000Z",
    known_gaps: [],
    last_at: "2026-05-19T12:00:00.000Z",
    run_id: "run_success",
    started_at: "2026-05-19T11:59:00.000Z",
    status: "succeeded",
  });
  const entries = projectCollectionReport({
    connectionHealth: makeHealth({ attention: "none", freshness: "fresh" }),
    lastRun: inProgressRun,
    lastSuccessfulRun: successfulRun,
    manifestStreams: [
      { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "messages" },
    ],
    refreshPolicy: null,
  });
  const entry = entryFor(entries, "messages");

  assert.equal(entry.coverage_condition, "complete");
  assert.equal(entry.considered, 1125);
  assert.equal(entry.covered, 1125);
});

test("active in-progress latest run with NO prior success stays unknown (never false-green)", () => {
  const inProgressRun = makeRun({
    collection_facts: null,
    event_count: 0,
    failure_reason: null,
    finished_at: null,
    first_at: "2026-05-19T12:09:00.000Z",
    known_gaps: [],
    last_at: "2026-05-19T12:09:00.000Z",
    run_id: "run_in_progress_first_ever",
    started_at: "2026-05-19T12:09:00.000Z",
    status: "in_progress",
    terminal_reason: null,
  });
  const entries = projectCollectionReport({
    connectionHealth: makeHealth({ attention: "none", freshness: "unknown" }),
    lastRun: inProgressRun,
    lastSuccessfulRun: null,
    manifestStreams: [
      { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "messages" },
    ],
    refreshPolicy: null,
  });
  const entry = entryFor(entries, "messages");

  assert.equal(entry.coverage_condition, "unknown");
  assert.equal(entry.forward_disposition, "unmeasured");
});

test("terminal failed latest run is NEVER substituted by a prior success (failure stays a failure)", () => {
  const failedRun = makeRun({
    collection_facts: null,
    event_count: 0,
    failure_reason: "credential_rejected",
    finished_at: "2026-05-19T12:10:00.000Z",
    first_at: "2026-05-19T12:09:00.000Z",
    known_gaps: [],
    last_at: "2026-05-19T12:10:00.000Z",
    run_id: "run_failed",
    started_at: "2026-05-19T12:09:00.000Z",
    status: "failed",
    terminal_reason: "credential_rejected",
  });
  const successfulRun = makeRun({
    collection_facts: {
      streams: [fact({ collected: 0, considered: 1125, covered: 1125, stream: "messages" })],
    },
    event_count: 3,
    failure_reason: null,
    finished_at: "2026-05-19T12:00:00.000Z",
    first_at: "2026-05-19T11:59:00.000Z",
    known_gaps: [],
    last_at: "2026-05-19T12:00:00.000Z",
    run_id: "run_success",
    started_at: "2026-05-19T11:59:00.000Z",
    status: "succeeded",
  });
  const entries = projectCollectionReport({
    connectionHealth: makeHealth({ attention: "none", freshness: "stale" }),
    lastRun: failedRun,
    lastSuccessfulRun: successfulRun,
    manifestStreams: [
      { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "messages" },
    ],
    refreshPolicy: null,
  });
  const entry = entryFor(entries, "messages");

  // The failed run carries no collection_facts of its own and is NOT
  // owner-cancelled, so it is NOT substituted — it reads unknown, never the
  // prior success's `complete`. Terminal failures must never appear green.
  assert.equal(entry.coverage_condition, "unknown");
  assert.notEqual(entry.coverage_condition, "complete");
});

// P1-1 cross-surface follow-up: `projectCollectionReport` must classify
// coverage off `latestSettledRun` (the newest TERMINAL run), exactly like the
// already-fixed connection-health headline (`healthClassifyingRun`) — not off
// `lastRun` alone. Without threading `latestSettledRun` through, a settled
// failure sitting strictly between the last success and an active retry is
// invisible here: `lastRun` is the active retry (no coverage evidence of its
// own), so `coverageClassifyingRun` falls back to `lastSuccessfulRun` and the
// per-stream report reads the OLD success's complete coverage even though a
// real failure happened after it and before the retry. This would let the
// Collection Report disagree with the corrected connection-health headline
// (degraded) by showing a stale "complete" stream.
test("success -> settled failure -> active retry: report reflects the settled failure, not the old success", () => {
  const successfulRun = makeRun({
    collection_facts: {
      streams: [fact({ collected: 0, considered: 1125, covered: 1125, stream: "messages" })],
    },
    event_count: 3,
    finished_at: "2026-05-19T11:00:00.000Z",
    last_at: "2026-05-19T11:00:00.000Z",
    run_id: "run_success",
    started_at: "2026-05-19T10:59:00.000Z",
    status: "succeeded",
  });
  const settledFailedRun = makeRun({
    collection_facts: null,
    event_count: 0,
    failure_reason: "credential_rejected",
    finished_at: "2026-05-19T12:10:00.000Z",
    last_at: "2026-05-19T12:10:00.000Z",
    run_id: "run_settled_failure",
    started_at: "2026-05-19T12:09:00.000Z",
    status: "failed",
    terminal_reason: "credential_rejected",
  });
  const activeRetryRun = makeRun({
    collection_facts: null,
    event_count: 0,
    finished_at: null,
    last_at: "2026-05-19T12:20:00.000Z",
    run_id: "run_active_retry",
    started_at: "2026-05-19T12:20:00.000Z",
    status: "in_progress",
  });
  const entries = projectCollectionReport({
    connectionHealth: makeHealth({ attention: "none", freshness: "stale" }),
    lastRun: activeRetryRun,
    lastSuccessfulRun: successfulRun,
    latestSettledRun: settledFailedRun,
    manifestStreams: [
      { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "messages" },
    ],
    refreshPolicy: null,
  });
  const entry = entryFor(entries, "messages");

  // The settled failure — not the active retry, and not the old success —
  // is the coverage authority: it carries no collection_facts of its own and
  // is not owner-cancelled, so it must read unknown, never the stale
  // "complete" the old success would otherwise leave behind.
  assert.equal(entry.coverage_condition, "unknown");
  assert.notEqual(entry.coverage_condition, "complete");
});

// Live defect fix (2026-07-17): a connector with a durable non-pressure
// recovery backlog (e.g. a large Gmail attachment-hydration queue) is
// dispatched `recovery_only` on every scheduled/unscoped-manual run for as
// long as that backlog persists (`resolveEffectiveRecoveryOnly`,
// `runtime/controller.ts`). A recovery-only run's own `collection_facts` is
// ALWAYS `null` by design (`buildCollectionFacts`'s `recoveryOnly` branch) —
// not because measurement failed, but because none was attempted for any
// stream, list-pass or detail-recovered. Before this fix,
// `coverageClassifyingRun` used a terminal `recovery_only` success AS-IS
// (it is neither active nor owner-cancelled), which read every
// checkpoint_window/full_inventory stream the recovery-only run did not
// touch as `unknown`/`unmeasured` — masking a genuinely-measured PRIOR
// forward pass indefinitely while the backlog persisted.
test("succeeded recovery-only latest run defers to prior successful coverage (does not starve untouched streams)", () => {
  const recoveryOnlyRun = {
    collection_facts: null,
    event_count: 4,
    failure_reason: null,
    finished_at: "2026-07-17T10:00:00.000Z",
    first_at: "2026-07-17T09:59:00.000Z",
    known_gaps: [],
    last_at: "2026-07-17T10:00:00.000Z",
    recovery_only: true,
    run_id: "run_recovery_only",
    started_at: "2026-07-17T09:59:00.000Z",
    status: "succeeded",
    terminal_reason: null,
  };
  const successfulRun = makeRun({
    collection_facts: {
      streams: [fact({ collected: 0, considered: 1125, covered: 1125, stream: "messages" })],
    },
    event_count: 3,
    failure_reason: null,
    finished_at: "2026-05-19T12:00:00.000Z",
    first_at: "2026-05-19T11:59:00.000Z",
    known_gaps: [],
    last_at: "2026-05-19T12:00:00.000Z",
    run_id: "run_success",
    started_at: "2026-05-19T11:59:00.000Z",
    status: "succeeded",
  });
  const entries = projectCollectionReport({
    connectionHealth: makeHealth({ attention: "none", freshness: "fresh" }),
    lastRun: recoveryOnlyRun,
    lastSuccessfulRun: successfulRun,
    manifestStreams: [
      { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "messages" },
    ],
    refreshPolicy: null,
  });
  const entry = entryFor(entries, "messages");

  assert.equal(entry.coverage_condition, "complete");
  assert.equal(entry.considered, 1125);
  assert.equal(entry.covered, 1125);
});

// Honesty proof (non-vacuous, negative case): a FAILED recovery-only run
// still carries a genuine failure signal for the connection and must NEVER
// be substituted by a prior success — exactly like an ordinary terminal
// failure. Only a SUCCEEDED recovery-only run gets the fallback.
test("FAILED recovery-only latest run is NEVER substituted by a prior success (failure stays a failure)", () => {
  const failedRecoveryOnlyRun = {
    collection_facts: null,
    event_count: 1,
    failure_reason: "connector_exception",
    finished_at: "2026-07-17T10:10:00.000Z",
    first_at: "2026-07-17T10:09:00.000Z",
    known_gaps: [],
    last_at: "2026-07-17T10:10:00.000Z",
    recovery_only: true,
    run_id: "run_recovery_only_failed",
    started_at: "2026-07-17T10:09:00.000Z",
    status: "failed",
    terminal_reason: "connector_exception",
  };
  const successfulRun = makeRun({
    collection_facts: {
      streams: [fact({ collected: 0, considered: 1125, covered: 1125, stream: "messages" })],
    },
    event_count: 3,
    failure_reason: null,
    finished_at: "2026-05-19T12:00:00.000Z",
    first_at: "2026-05-19T11:59:00.000Z",
    known_gaps: [],
    last_at: "2026-05-19T12:00:00.000Z",
    run_id: "run_success",
    started_at: "2026-05-19T11:59:00.000Z",
    status: "succeeded",
  });
  const entries = projectCollectionReport({
    connectionHealth: makeHealth({ attention: "none", freshness: "stale" }),
    lastRun: failedRecoveryOnlyRun,
    lastSuccessfulRun: successfulRun,
    manifestStreams: [
      { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "messages" },
    ],
    refreshPolicy: null,
  });
  const entry = entryFor(entries, "messages");

  assert.equal(entry.coverage_condition, "unknown");
  assert.notEqual(entry.coverage_condition, "complete");
});

// Honesty proof (non-vacuous, negative case): a succeeded recovery-only run
// with NO prior successful run at all (e.g. a connection whose very first
// run was recovery-gated) must still rest unknown — the fallback only
// SURFACES a prior genuine measurement, it never fabricates one.
test("succeeded recovery-only latest run with NO prior success stays unknown (never false-green)", () => {
  const recoveryOnlyRun = {
    collection_facts: null,
    event_count: 4,
    failure_reason: null,
    finished_at: "2026-07-17T10:00:00.000Z",
    first_at: "2026-07-17T09:59:00.000Z",
    known_gaps: [],
    last_at: "2026-07-17T10:00:00.000Z",
    recovery_only: true,
    run_id: "run_recovery_only_first_ever",
    started_at: "2026-07-17T09:59:00.000Z",
    status: "succeeded",
    terminal_reason: null,
  };
  const entries = projectCollectionReport({
    connectionHealth: makeHealth({ attention: "none", freshness: "unknown" }),
    lastRun: recoveryOnlyRun,
    lastSuccessfulRun: null,
    manifestStreams: [
      { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "messages" },
    ],
    refreshPolicy: null,
  });
  const entry = entryFor(entries, "messages");

  assert.equal(entry.coverage_condition, "unknown");
  assert.equal(entry.forward_disposition, "unmeasured");
});

// ─── considered known: satisfied -> complete, short -> partial ────────────────

test("considered satisfied (collected === considered), fresh -> complete / complete", () => {
  const entries = report([fact({ collected: 1145, considered: 1145 })]);
  const entry = entryFor(entries, "transactions");
  assert.equal(entry.considered, 1145);
  assert.equal(entry.coverage_condition, "complete");
  assert.equal(entry.forward_disposition, "complete");
});

test("considered exceeds collected -> partial / resumable, considered recorded", () => {
  const entries = report([fact({ collected: 900, considered: 1145 })]);
  const entry = entryFor(entries, "transactions");
  assert.equal(entry.considered, 1145);
  assert.equal(entry.coverage_condition, "partial");
  assert.equal(entry.forward_disposition, "resumable");
});

// ─── 4.4 the covered numerator: steady-state full-sync reads complete ─────────
//
// A fingerprint-suppressed full-sync stream enumerates its whole boundary and
// suppresses unchanged records, so `collected` is a churn-reduced subset. When it
// declares a `covered` count (emitted + suppressed-unchanged), the gate compares
// `considered` against `covered`, NOT `collected`. This is the steady-state fix:
// a run that emitted 0 but accounted for the whole inventory reads `complete`,
// not a false `partial`. A real drop (covered < considered) still reads `partial`.

test("4.4 steady-state: collected 0 but covered === considered -> complete (NOT a false partial)", () => {
  // The exact shape a steady-state fingerprint full-sync run produces: it
  // re-enumerated all 1145 rows, emitted none (all unchanged), and accounted for
  // every one as suppressed-unchanged.
  const entries = report([fact({ collected: 0, considered: 1145, covered: 1145 })]);
  const entry = entryFor(entries, "transactions");
  assert.equal(entry.considered, 1145);
  assert.equal(entry.covered, 1145);
  assert.equal(entry.collected, 0);
  // Without the covered numerator the gate would compare considered(1145) against
  // collected(0) and read a false `partial`. With it, the run is `complete`.
  assert.equal(entry.coverage_condition, "complete");
  assert.equal(entry.forward_disposition, "complete");
});

test("4.4 one-changed: collected 1, covered === considered -> complete", () => {
  const entries = report([fact({ collected: 1, considered: 1145, covered: 1145 })]);
  const entry = entryFor(entries, "transactions");
  assert.equal(entry.covered, 1145);
  assert.equal(entry.coverage_condition, "complete");
});

test("4.4 dropped row: covered < considered -> partial (a weighed-but-dropped item still shows the shortfall)", () => {
  // The guardrail: a covered count never masks a dropped record. Here the run
  // enumerated 1145 but accounted for only 1144 (one weighed row dropped before
  // it could be emitted or suppressed). collected(0) is irrelevant — the gate
  // reads covered(1144) < considered(1145) and refuses `complete`.
  const entries = report([fact({ collected: 0, considered: 1145, covered: 1144 })]);
  const entry = entryFor(entries, "transactions");
  assert.equal(entry.considered, 1145);
  assert.equal(entry.covered, 1144);
  assert.equal(entry.coverage_condition, "partial");
  assert.equal(entry.forward_disposition, "resumable");
});

test("4.4 covered absent -> gate falls back to collected (prior behavior byte-unchanged)", () => {
  // A declarer that emits NO covered count (every shipped 4.1/4.2 declarer) must
  // behave exactly as before: considered vs collected. covered: null means the
  // gate ignores it entirely.
  const satisfied = report([fact({ collected: 1145, considered: 1145, covered: null })]);
  assert.equal(entryFor(satisfied, "transactions").coverage_condition, "complete");
  assert.equal(entryFor(satisfied, "transactions").covered, "unknown");

  const short = report([fact({ collected: 900, considered: 1145, covered: null })]);
  assert.equal(entryFor(short, "transactions").coverage_condition, "partial");
});

test("4.4 covered satisfies considered while collected is below it -> complete (covered, not collected, is the numerator)", () => {
  // Explicitly pin that the gate prefers covered over collected when both are
  // present and they disagree: collected(500) < considered(1000) would be
  // `partial` on the old path, but covered(1000) === considered → complete.
  const entries = report([fact({ collected: 500, considered: 1000, covered: 1000 })]);
  const entry = entryFor(entries, "transactions");
  assert.equal(entry.coverage_condition, "complete");
});

// ─── skip facts: never complete ───────────────────────────────────────────────

test("skip with retry_by_runtime recovery -> retryable_gap / resumable", () => {
  const entries = report([
    fact({ collected: 0, skipped: { reason: "http_429", recovery_action: "retry_by_runtime" }, stream: "dms" }),
  ]);
  const entry = entryFor(entries, "dms");
  assert.notEqual(entry.coverage_condition, "complete");
  assert.equal(entry.coverage_condition, "retryable_gap");
  assert.equal(entry.forward_disposition, "resumable");
  assert.deepEqual(entry.skipped, { reason: "http_429", recovery_action: "retry_by_runtime" });
});

test("skip out_of_scope -> deferred / complete (owes no further data)", () => {
  const entries = report([fact({ collected: 0, skipped: { reason: "out_of_scope" }, stream: "drafts" })]);
  const entry = entryFor(entries, "drafts");
  assert.equal(entry.coverage_condition, "deferred");
  // `deferred` carries no outstanding gap -> complete disposition (fresh).
  assert.equal(entry.forward_disposition, "complete");
});

test("skip unsupported -> unsupported / terminal", () => {
  const entries = report([fact({ collected: 0, skipped: { reason: "unsupported_in_mode" }, stream: "reactions" })]);
  const entry = entryFor(entries, "reactions");
  assert.equal(entry.coverage_condition, "unsupported");
  assert.equal(entry.forward_disposition, "terminal");
});

test("skip unavailable -> unavailable / terminal", () => {
  const entries = report([fact({ collected: 0, skipped: { reason: "source_unavailable" }, stream: "archive" })]);
  const entry = entryFor(entries, "archive");
  assert.equal(entry.coverage_condition, "unavailable");
  assert.equal(entry.forward_disposition, "terminal");
});

test("skip with no recovery path -> terminal_gap / terminal", () => {
  const entries = report([fact({ collected: 0, skipped: { reason: "connector_panicked" }, stream: "weird" })]);
  const entry = entryFor(entries, "weird");
  assert.equal(entry.coverage_condition, "terminal_gap");
  assert.equal(entry.forward_disposition, "terminal");
});

test("pending detail gap overrides same-stream terminal-looking skip diagnostic", () => {
  const entries = report([
    fact({
      collected: 100,
      considered: 101,
      pending_detail_gaps: 1,
      skipped: { reason: "qfx_download_failed" },
      stream: "transactions",
    }),
  ]);
  const entry = entryFor(entries, "transactions");
  assert.equal(entry.coverage_condition, "retryable_gap");
  assert.equal(entry.forward_disposition, "resumable");
  assert.equal(entry.pending_detail_gaps, 1);
});

// ─── detail gap ────────────────────────────────────────────────────────────────

test("pending detail gap -> retryable_gap / resumable, count preserved", () => {
  const entries = report([fact({ collected: 1000, considered: 1145, pending_detail_gaps: 3 })]);
  const entry = entryFor(entries, "transactions");
  assert.equal(entry.coverage_condition, "retryable_gap");
  assert.equal(entry.pending_detail_gaps, 3);
  assert.equal(entry.forward_disposition, "resumable");
});

test("current pending detail gap without a terminal fact block is visible on its stream", () => {
  const entries = report(null, {
    freshness: "unknown",
    manifestStreams: [{ name: "accounts" }, { name: "transactions" }],
    pendingDetailGaps: [{ reason: "temporary_unavailable", status: "pending", stream: "transactions" }],
  });
  const accounts = entryFor(entries, "accounts");
  const transactions = entryFor(entries, "transactions");

  assert.equal(accounts.coverage_condition, "unknown");
  assert.equal(accounts.forward_disposition, "unmeasured");
  assert.equal(transactions.coverage_condition, "retryable_gap");
  assert.equal(transactions.pending_detail_gaps, 1);
  assert.equal(transactions.forward_disposition, "resumable");
});

test("terminal detail gap without a denominator is visible on its stream", () => {
  const entries = report(
    [fact({ checkpoint: "not_staged", collected: 272, considered: null, stream: "order_items" })],
    {
      manifestStreams: [{ name: "orders" }, { name: "order_items" }],
      terminalDetailGapsByStream: new Map([["order_items", 33]]),
    }
  );
  const orders = entryFor(entries, "orders");
  const orderItems = entryFor(entries, "order_items");

  assert.equal(orders.coverage_condition, "unknown");
  assert.equal(orderItems.collected, 272);
  assert.equal(orderItems.considered, "unknown");
  assert.equal(orderItems.coverage_condition, "terminal_gap");
  assert.equal(orderItems.forward_disposition, "terminal");
  assert.equal(orderItems.coverage_unfillable_accounted, false);
});

// ─── unfillableAccounted (§10-A) — Gmail attachments' exact production shape ──

test("terminal_gap stream fully backed by durable unfillable proof -> coverage_unfillable_accounted true", () => {
  const entries = report(
    [fact({ checkpoint: "not_staged", collected: 349_023, considered: null, stream: "attachments" })],
    {
      manifestStreams: [{ name: "attachments" }],
      terminalDetailGapsByStream: new Map([["attachments", 32]]),
      unfillableAccountedByStream: new Map([["attachments", true]]),
    }
  );
  const attachments = entryFor(entries, "attachments");
  assert.equal(attachments.coverage_condition, "terminal_gap");
  assert.equal(attachments.coverage_unfillable_accounted, true);
});

test("terminal_gap stream with the read unmeasured (store doesn't implement it) -> coverage_unfillable_accounted stays false", () => {
  const entries = report(
    [fact({ checkpoint: "not_staged", collected: 349_023, considered: null, stream: "attachments" })],
    {
      manifestStreams: [{ name: "attachments" }],
      terminalDetailGapsByStream: new Map([["attachments", 32]]),
      // unfillableAccountedByStream omitted entirely — the real "not implemented" shape.
    }
  );
  const attachments = entryFor(entries, "attachments");
  assert.equal(attachments.coverage_condition, "terminal_gap");
  assert.equal(attachments.coverage_unfillable_accounted, false);
});

test("a non-terminal_gap stream never carries coverage_unfillable_accounted even if the map says true (defense in depth)", () => {
  const entries = report([fact({ checkpoint: "committed", collected: 10, considered: 10, stream: "labels" })], {
    manifestStreams: [{ name: "labels" }],
    // Deliberately mismatched input: no terminal gap exists on this stream, but
    // the map claims accounted-for anyway. The classifier must not trust it.
    unfillableAccountedByStream: new Map([["labels", true]]),
  });
  const labels = entryFor(entries, "labels");
  assert.equal(labels.coverage_condition, "complete");
  assert.equal(labels.coverage_unfillable_accounted, false);
});

test("stale evidence scope withdraws coverage_unfillable_accounted along with the terminal_gap condition it was proven against", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [fact({ checkpoint: "not_staged", collected: 100, considered: null, stream: "attachments" })],
    },
    declaredCollectionScope: "narrowed_v2",
    evidenceCollectionScope: "unscoped",
    freshness: "fresh",
    manifestStreams: [{ name: "attachments" }],
    refresh: null,
    terminalDetailGapsByStream: new Map([["attachments", 32]]),
    unfillableAccountedByStream: new Map([["attachments", true]]),
  });
  const attachments = entryFor(entries, "attachments");
  assert.equal(attachments.coverage_condition, "unknown");
  assert.equal(attachments.coverage_unfillable_accounted, false);
});

test("current pending detail gap raises an old zero-gap fact", () => {
  const entries = report([fact({ pending_detail_gaps: 0 })], {
    pendingDetailGaps: [{ reason: "temporary_unavailable", status: "pending", stream: "transactions" }],
  });
  const entry = entryFor(entries, "transactions");

  assert.equal(entry.coverage_condition, "retryable_gap");
  assert.equal(entry.pending_detail_gaps, 1);
  assert.equal(entry.pending_detail_gaps_is_floor, false);
});

test("bounded pending detail-gap reads mark stream counts as floors when the limit is hit", () => {
  const entries = report(null, {
    freshness: "unknown",
    manifestStreams: [{ name: "transactions" }],
    pendingDetailGaps: [
      { reason: "temporary_unavailable", status: "pending", stream: "transactions" },
      { reason: "temporary_unavailable", status: "pending", stream: "transactions" },
    ],
    pendingDetailGapsReadLimit: 2,
  });
  const entry = entryFor(entries, "transactions");

  assert.equal(entry.coverage_condition, "retryable_gap");
  assert.equal(entry.pending_detail_gaps, 2);
  assert.equal(entry.pending_detail_gaps_is_floor, true);
});

test("detail gap takes precedence over a satisfied considered denominator", () => {
  // Even with collected >= considered, a pending recoverable gap means the
  // stream is not yet fully covered.
  const entries = report([fact({ collected: 1145, considered: 1145, pending_detail_gaps: 1 })]);
  const entry = entryFor(entries, "transactions");
  assert.equal(entry.coverage_condition, "retryable_gap");
});

// ─── the manual-refresh freshness seam, re-proven at stream scope ─────────────

test("complete + stale + manual-refresh -> owner_refresh_due (coverage stays complete)", () => {
  const entries = report([fact({ collected: 1145, considered: 1145 })], {
    freshness: "stale",
    refresh: MANUAL_REFRESH,
  });
  const entry = entryFor(entries, "transactions");
  // Coverage stays complete; only the disposition carries the freshness fact.
  assert.equal(entry.coverage_condition, "complete");
  assert.equal(entry.forward_disposition, "owner_refresh_due");
});

test("complete + stale + schedulable -> complete (scheduler owns it, not owner)", () => {
  const entries = report([fact({ collected: 1145, considered: 1145 })], {
    freshness: "stale",
    refresh: SCHEDULABLE_REFRESH,
  });
  const entry = entryFor(entries, "transactions");
  assert.equal(entry.coverage_condition, "complete");
  assert.notEqual(entry.forward_disposition, "owner_refresh_due");
  assert.equal(entry.forward_disposition, "complete");
});

test("retryable_gap + stale + manual-refresh -> resumable (gap not masked by staleness)", () => {
  const entries = report([fact({ collected: 1000, considered: 1145, pending_detail_gaps: 2 })], {
    freshness: "stale",
    refresh: MANUAL_REFRESH,
  });
  const entry = entryFor(entries, "transactions");
  assert.equal(entry.coverage_condition, "retryable_gap");
  assert.equal(entry.pending_detail_gaps, 2);
  // Gaps are evaluated before freshness, so the resumable path stays visible.
  assert.equal(entry.forward_disposition, "resumable");
});

// ─── attention ─────────────────────────────────────────────────────────────────

test("outstanding gap + open attention -> awaiting_owner", () => {
  const entries = report([fact({ collected: 900, considered: 1145 })], { attentionOpen: true });
  const entry = entryFor(entries, "transactions");
  assert.equal(entry.coverage_condition, "partial");
  assert.equal(entry.forward_disposition, "awaiting_owner");
});

test("open attention does NOT taint a stream with no gap (complete stays complete)", () => {
  const entries = report([fact({ collected: 1145, considered: 1145 })], { attentionOpen: true });
  const entry = entryFor(entries, "transactions");
  assert.equal(entry.forward_disposition, "complete");
});

// ─── 2.6 portable RECORD/STATE/DONE-only connector ────────────────────────────

test("portable RECORD/STATE/DONE-only stream (no considered, no gaps, no skip) -> unknown / unmeasured", () => {
  // The portability floor: a connector that emits only RECORD/STATE/DONE
  // declares no DETAIL_COVERAGE, no considered, and no SKIP_RESULT. Its entry
  // must be a VALID report with `unknown` axes — not an error, not `complete`.
  const entries = report([fact({ checkpoint: "committed", collected: 500, considered: null, stream: "posts" })]);
  const entry = entryFor(entries, "posts");
  assert.equal(entry.considered, "unknown");
  assert.equal(entry.coverage_condition, "unknown");
  assert.equal(entry.forward_disposition, "unmeasured");
  assert.equal(entry.checkpoint, "committed");
});

// ─── manifest accepted-coverage policy folds in ───────────────────────────────

test("manifest inventory_only stream with satisfied considered -> inventory_only, not complete", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: { streams: [fact({ collected: 10, considered: 10, stream: "catalog" })] },
    freshness: "fresh",
    manifestStreams: [{ coverage_policy: "inventory_only", name: "catalog", required: false }],
    refresh: null,
  });
  const entry = entryFor(entries, "catalog");
  assert.equal(entry.coverage_condition, "inventory_only");
  // inventory_only owes no further data -> complete disposition.
  assert.equal(entry.forward_disposition, "complete");
});

test("contradictory manifest (required + unsupported) -> unsupported / terminal, never green", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: { streams: [fact({ collected: 5, considered: 5, stream: "messages" })] },
    freshness: "fresh",
    manifestStreams: [{ coverage_policy: "unsupported", name: "messages", required: true }],
    refresh: null,
  });
  const entry = entryFor(entries, "messages");
  // A required stream that also declares accepted-absent must never paint green
  // even when collected satisfies a considered denominator.
  assert.equal(entry.coverage_condition, "unsupported");
  assert.equal(entry.forward_disposition, "terminal");
});

// ─── absence tolerances (§3.2) ────────────────────────────────────────────────

test("no fact block -> one unknown entry per manifest stream (never dropped, never complete)", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: null,
    freshness: "fresh",
    manifestStreams: [{ name: "a" }, { name: "b" }],
    refresh: null,
  });
  assert.equal(entries.length, 2);
  for (const name of ["a", "b"]) {
    const entry = entryFor(entries, name);
    assert.equal(entry.considered, "unknown");
    assert.equal(entry.coverage_condition, "unknown");
    assert.equal(entry.collected, 0);
    assert.equal(entry.checkpoint, "unknown");
    assert.notEqual(entry.coverage_condition, "complete");
  }
});

test("manifest stream missing from fact block -> honest zero entry, in-scope universe is union", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: { streams: [fact({ collected: 7, considered: 7, stream: "reported" })] },
    freshness: "fresh",
    manifestStreams: [{ name: "reported" }, { name: "unreported" }],
    refresh: null,
  });
  assert.equal(entries.length, 2);
  const reported = entryFor(entries, "reported");
  assert.equal(reported.coverage_condition, "complete");
  const unreported = entryFor(entries, "unreported");
  assert.equal(unreported.collected, 0);
  assert.equal(unreported.considered, "unknown");
  assert.equal(unreported.coverage_condition, "unknown");
});

test("fact-only stream not in manifest is still reported (union, not manifest-only)", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: { streams: [fact({ collected: 3, considered: null, stream: "extra" })] },
    freshness: "fresh",
    manifestStreams: [],
    refresh: null,
  });
  assert.equal(entries.length, 1);
  assert.equal(entryFor(entries, "extra").coverage_condition, "unknown");
});

test("malformed considered (handled upstream as null) reads unknown, never fabricates complete", () => {
  // The reader normalizes a malformed `considered` to null before this layer; a
  // null considered must read `unknown` regardless of collected count.
  const entries = report([fact({ collected: 99, considered: null, stream: "x" })]);
  const entry = entryFor(entries, "x");
  assert.equal(entry.considered, "unknown");
  assert.equal(entry.coverage_condition, "unknown");
});

test("empty in-scope universe -> empty report (no invented entries)", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: null,
    freshness: "fresh",
    manifestStreams: [],
    refresh: null,
  });
  assert.deepEqual(entries, []);
});

// ─── succeeded-run coverage: staged checkpoint proves full_inventory /
//     singleton_presence streams (YNAB category_groups) ───────────────────────
//
// These pin the fix for the live coverage omission: a succeeded run that emits
// records for a `full_inventory` or `singleton_presence` stream but leaves its
// checkpoint `not_staged` projects `unmeasured`; once the connector stages the
// checkpoint (committed), the declared strategy proves coverage without a
// numeric denominator and the stream reads `complete`. The strategy alone is not
// enough — the committed boundary is the load-bearing evidence.

test("YNAB category_groups (full_inventory): not_staged checkpoint -> unknown / unmeasured (the pre-fix bug)", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [fact({ checkpoint: "not_staged", collected: 12, considered: null, stream: "category_groups" })],
    },
    freshness: "fresh",
    manifestStreams: [
      { coverage_strategy: "full_inventory", freshness_strategy: "scheduled_window", name: "category_groups" },
    ],
    refresh: null,
  });
  const entry = entryFor(entries, "category_groups");
  assert.equal(entry.coverage_strategy, "full_inventory");
  assert.equal(entry.coverage_condition, "unknown");
  assert.equal(entry.forward_disposition, "unmeasured");
});

test("YNAB category_groups (full_inventory): committed checkpoint -> complete after a succeeded run", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [fact({ checkpoint: "committed", collected: 12, considered: 40, stream: "category_groups" })],
    },
    freshness: "fresh",
    manifestStreams: [
      { coverage_strategy: "full_inventory", freshness_strategy: "scheduled_window", name: "category_groups" },
    ],
    refresh: null,
  });
  const entry = entryFor(entries, "category_groups");
  assert.equal(entry.considered, 40);
  assert.equal(entry.coverage_strategy, "full_inventory");
  assert.equal(entry.coverage_condition, "complete");
  assert.equal(entry.forward_disposition, "complete");
});

// ─── Chase balances (parent_detail_accounting) ─────────────────────────────
//
// `balances` was originally a bare `singleton_presence` stream whose only
// proof was a self-staged STATE checkpoint gated on "at least one balance
// record emitted this run". That left the stream permanently unmeasured on
// any run where every considered account was source-limited `no_activity`
// (Chase's no-activity confirmation page never serves a QFX response, so
// there is no LEDGERBAL/AVAILBAL block to read) — a real, common case, not a
// connector bug (live run_1783705924457: accounts/transactions/statements all
// committed while balances rested `not_staged` with considered/covered null).
// `balances` now adopts the same `parent_detail_accounting` evidence as
// `transactions`: a per-run DETAIL_COVERAGE over the `accounts` denominator,
// where a `no_activity` account is honest hydrated coverage of the balances
// pass (reached, nothing to report), never a gap. These pin the projection
// consequence of that fix.

test("Chase balances (parent_detail_accounting): zero balance records but considered==covered (all no_activity) -> complete, not unmeasured (the live regression)", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [fact({ checkpoint: "committed", collected: 0, considered: 2, covered: 2, stream: "balances" })],
    },
    freshness: "fresh",
    manifestStreams: [
      { coverage_strategy: "parent_detail_accounting", freshness_strategy: "manual_as_of", name: "balances" },
    ],
    refresh: null,
  });
  const entry = entryFor(entries, "balances");
  assert.equal(entry.collected, 0, "no balance records were emitted this run");
  assert.equal(entry.considered, 2);
  assert.equal(entry.coverage_strategy, "parent_detail_accounting");
  assert.equal(entry.coverage_condition, "complete");
  assert.equal(entry.forward_disposition, "complete");
});

test("Chase balances (parent_detail_accounting): zero eligible accounts after a completed enumeration (considered 0 / covered 0) -> complete, not unmeasured", () => {
  // A real resource-filtered scoped run whose account enumeration succeeded
  // but matched zero eligible accounts still owes an explicit 0/0 report
  // (emitBalancesDetailCoverage no longer suppresses on outcomes.length ===
  // 0). This must resolve complete exactly like the USAA/Chase-statements
  // zero-candidate steady-state case, not rest unknown for lack of a
  // numeric denominator > 0.
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [fact({ checkpoint: "committed", collected: 0, considered: 0, covered: 0, stream: "balances" })],
    },
    freshness: "fresh",
    manifestStreams: [
      { coverage_strategy: "parent_detail_accounting", freshness_strategy: "manual_as_of", name: "balances" },
    ],
    refresh: null,
  });
  const entry = entryFor(entries, "balances");
  assert.equal(entry.considered, 0);
  assert.equal(entry.coverage_condition, "complete");
  assert.equal(entry.forward_disposition, "complete");
});

test("Chase balances (parent_detail_accounting): no DETAIL_COVERAGE emitted (no considered denominator) -> unknown / unmeasured", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [fact({ checkpoint: "not_staged", collected: 0, considered: null, covered: null, stream: "balances" })],
    },
    freshness: "fresh",
    manifestStreams: [
      { coverage_strategy: "parent_detail_accounting", freshness_strategy: "manual_as_of", name: "balances" },
    ],
    refresh: null,
  });
  const entry = entryFor(entries, "balances");
  assert.equal(entry.coverage_strategy, "parent_detail_accounting");
  assert.equal(entry.coverage_condition, "unknown");
  assert.equal(entry.forward_disposition, "unmeasured");
});

test("Chase balances (parent_detail_accounting): a QFX gap on one account -> partial, not complete", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [fact({ checkpoint: "committed", collected: 1, considered: 2, covered: 1, stream: "balances" })],
    },
    freshness: "fresh",
    manifestStreams: [
      { coverage_strategy: "parent_detail_accounting", freshness_strategy: "manual_as_of", name: "balances" },
    ],
    refresh: null,
  });
  const entry = entryFor(entries, "balances");
  assert.equal(entry.coverage_condition, "partial");
});

test("Chase balances (parent_detail_accounting): all accounts hydrated with a balance -> complete", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [fact({ checkpoint: "committed", collected: 2, considered: 2, covered: 2, stream: "balances" })],
    },
    freshness: "fresh",
    manifestStreams: [
      { coverage_strategy: "parent_detail_accounting", freshness_strategy: "manual_as_of", name: "balances" },
    ],
    refresh: null,
  });
  const entry = entryFor(entries, "balances");
  assert.equal(entry.coverage_condition, "complete");
  assert.equal(entry.forward_disposition, "complete");
});

// ─── entries are deterministically ordered ────────────────────────────────────

test("entries are sorted by stream name (stable owner-facing order)", () => {
  const entries = report([
    fact({ collected: 1, considered: 1, stream: "zeta" }),
    fact({ collected: 1, considered: 1, stream: "alpha" }),
    fact({ collected: 1, considered: 1, stream: "mu" }),
  ]);
  assert.deepEqual(
    entries.map((e) => e.stream),
    ["alpha", "mu", "zeta"]
  );
});

// ─── `required` flag on the report entry ──────────────────────────────────────

test("required flag: manifest-declared stream defaults required=true; a fact-only undeclared stream is required=false", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [
        fact({ collected: 5, considered: 5, stream: "transactions" }),
        fact({ collected: 1, considered: null, stream: "extra" }),
      ],
    },
    freshness: "fresh",
    manifestStreams: [{ name: "transactions" }],
    refresh: null,
  });
  assert.equal(entryFor(entries, "transactions").required, true);
  assert.equal(entryFor(entries, "extra").required, false, "undeclared fact-only stream must not be load-bearing");
});

test("required flag: an explicit required:false manifest stream is not required", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: { streams: [fact({ collected: 0, considered: null, stream: "reactions" })] },
    freshness: "fresh",
    manifestStreams: [{ name: "reactions", required: false }],
    refresh: null,
  });
  assert.equal(entryFor(entries, "reactions").required, false);
});

// ─── Durable latest-attempt evidence (design.md "Per-Stream Evidence
//     Carry-Forward" / requirement "Per-stream coverage SHALL derive from
//     durable latest-attempt evidence") ──────────────────────────────────────
//
// `buildCollectionReport`'s `collectionFacts` is the CLASSIFYING run's own
// fact block; `latestStreamFacts` is the durable per-stream latest-attempt
// map from the connector-summary read model (raw fact + proof time + run id,
// connection-scoped). A run that did not attempt a stream must not erase
// that stream's prior evidence, and must not fabricate evidence for it
// either; the classifying run's own facts always overlay the store.

/** A manifest declaring `messages` as a checkpoint_window-proven stream. */
const CHECKPOINT_MESSAGES_MANIFEST: ManifestStreamFixture[] = [
  { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "messages" },
];

type LatestStreamFactMap = NonNullable<BuildCollectionReportInput["latestStreamFacts"]>;

/** Stored latest-attempt facts: `buildCollectionReport`'s `latestStreamFacts` shape. */
function storedFacts(
  streams: RuntimeCollectionFact[],
  { asOf = "2026-05-01T00:00:00.000Z", runId = "run_old" } = {}
): LatestStreamFactMap {
  return new Map(streams.map((f) => [f.stream, { evidenceAsOf: asOf, fact: f, runId }]));
}

test("carry-forward: scoped run preserves prior proof for an omitted required stream", () => {
  // Classifying run's scope did not attempt `messages` at all (no fact for it).
  // An older terminal block proved it complete via a committed checkpoint.
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: { streams: [] },
    collectionFactsAsOf: "2026-06-01T00:00:00.000Z",
    freshness: "fresh",
    latestStreamFacts: storedFacts(
      [fact({ checkpoint: "committed", collected: 500, considered: 500, stream: "messages" })],
      { asOf: "2026-05-01T00:00:00.000Z" }
    ),
    manifestStreams: CHECKPOINT_MESSAGES_MANIFEST,
    refresh: null,
  });
  const entry = entryFor(entries, "messages");
  assert.equal(entry.coverage_condition, "complete", "carried resolved evidence proves the stream complete");
  assert.equal(entry.required, true);
  assert.equal(entry.evidence_as_of, "2026-05-01T00:00:00.000Z", "proof age is the SOURCE block's own timestamp");
  assert.equal(rollupCollectionReportCoverageOverride("complete", entries), null);
});

test("carry-forward: never-measured omitted required stream still blocks Healthy", () => {
  // No carry block has ANY resolved evidence for `messages` — it stays unknown.
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: { streams: [] },
    collectionFactsAsOf: "2026-06-01T00:00:00.000Z",
    freshness: "fresh",
    latestStreamFacts: storedFacts([fact({ collected: 1, considered: 1, stream: "other" })]),
    manifestStreams: CHECKPOINT_MESSAGES_MANIFEST,
    refresh: null,
  });
  const entry = entryFor(entries, "messages");
  assert.equal(entry.coverage_condition, "unknown");
  assert.equal(entry.required, true);
  assert.equal(entry.evidence_as_of, null, "no resolved evidence anywhere -> no proof age either");
  assert.equal(
    rollupCollectionReportCoverageOverride("complete", entries),
    "unknown",
    "a required stream resting unknown refuses the clean-success promotion"
  );
});

test("an unknown run-classified axis is promoted to complete when every required stream's collection report is already complete", () => {
  // Connector-agnostic: this reproduces the shape ANY connector reaches when
  // buildCoverageEvidence's run-classification stage lands on "unknown" for
  // whatever reason (no run yet resolved, an owner-cancelled/controller-
  // abandoned/scheduler-skipped classifying run with nothing to fall back to,
  // a local_device connection with no scheduler-managed run, etc.) while the
  // independently-built collection_report already proves every required
  // stream complete from its own durable evidence. See
  // bz-e052-report-health.md for the live receipt this reproduces
  // (claude-code, codex, and chatgpt all hit it under different stage-1
  // causes).
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [fact({ checkpoint: "committed", collected: 500, considered: 500, stream: "messages" })],
    },
    collectionFactsAsOf: "2026-06-01T00:00:00.000Z",
    freshness: "fresh",
    latestStreamFacts: null,
    manifestStreams: CHECKPOINT_MESSAGES_MANIFEST,
    refresh: null,
  });
  assert.equal(entryFor(entries, "messages").coverage_condition, "complete");

  assert.equal(
    rollupCollectionReportCoverageOverride("unknown", entries),
    "complete",
    "an entirely complete required-stream report must promote an unknown connection axis"
  );
});

test("counterexample: an unknown axis is NOT promoted when only some required streams are complete (partial evidence)", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: { streams: [] },
    collectionFactsAsOf: "2026-06-01T00:00:00.000Z",
    freshness: "fresh",
    latestStreamFacts: storedFacts([
      fact({ checkpoint: "committed", collected: 500, considered: 500, stream: "messages" }),
    ]),
    manifestStreams: CHECKPOINT_MESSAGES_MANIFEST,
    refresh: null,
  });
  assert.equal(entryFor(entries, "messages").coverage_condition, "complete");
  const partialEntries = [
    ...entries,
    { ...entryFor(entries, "messages"), coverage_condition: "unknown" as const, stream: "other_required" },
  ];
  assert.equal(
    rollupCollectionReportCoverageOverride("unknown", partialEntries),
    null,
    "one required stream still unknown must refuse the promotion — every required stream must be complete, not just some"
  );
});

test("counterexample: an unknown axis is NOT promoted when the required-stream set is empty", () => {
  assert.equal(
    rollupCollectionReportCoverageOverride("unknown", []),
    null,
    "an empty required-report set has nothing to prove complete — must not fabricate a promotion from nothing"
  );
});

test("counterexample: an already-degrading axis is NEVER promoted to complete, even if the (mismatched) required report reads all-complete", () => {
  // Mismatched-input guard, mirroring the existing terminal_gap accounted-rollup
  // guard: a resolved degrading axis is authoritative on its own and must never
  // be overridden toward "complete" by a stale/mismatched collection report.
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [fact({ checkpoint: "committed", collected: 500, considered: 500, stream: "messages" })],
    },
    collectionFactsAsOf: "2026-06-01T00:00:00.000Z",
    freshness: "fresh",
    latestStreamFacts: null,
    manifestStreams: CHECKPOINT_MESSAGES_MANIFEST,
    refresh: null,
  });
  assert.equal(entryFor(entries, "messages").coverage_condition, "complete");
  for (const currentAxis of ["terminal_gap", "retryable_gap", "gaps", "partial"] as const) {
    assert.equal(
      rollupCollectionReportCoverageOverride(currentAxis, entries),
      null,
      `a degrading axis (${currentAxis}) must never be promoted to complete regardless of the required report`
    );
  }
});

test("carry-forward: an attempted-but-unresolved classifying fact cannot shadow durable stored proof (monotonic floor)", () => {
  // The classifying block DID attempt `messages` but left it unresolved
  // (not_staged, no skip, no denominator). An older block proved it complete
  // via a committed checkpoint. The classifying run's own attempt does not
  // itself prove durable coverage, so it must not erase the stored proof —
  // the same monotonic durable-proof floor `mergeEventStreamFacts` enforces
  // at the store layer (`ref-control.ts:2612-2622`'s live failed-preprogress
  // ChatGPT shape: `not_staged` classifying vs. `committed` stored).
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [fact({ checkpoint: "not_staged", collected: 10, considered: null, stream: "messages" })],
    },
    collectionFactsAsOf: "2026-06-01T00:00:00.000Z",
    freshness: "fresh",
    latestStreamFacts: storedFacts([
      fact({ checkpoint: "committed", collected: 500, considered: 500, stream: "messages" }),
    ]),
    manifestStreams: CHECKPOINT_MESSAGES_MANIFEST,
    refresh: null,
  });
  const entry = entryFor(entries, "messages");
  assert.equal(entry.coverage_condition, "complete", "the durably-proven stored fact is kept, not shadowed");
  assert.equal(entry.checkpoint, "committed");
  assert.equal(
    entry.evidence_as_of,
    "2026-05-01T00:00:00.000Z",
    "proof age is the STORED fact's own timestamp, restored with it"
  );
});

test("carry-forward: a classifying fact with a committed checkpoint but NO measured boundary cannot shadow a stored fact that measured one (B7)", () => {
  // Production shape (owner ledger 2026-08-22, cin_d344ba53d6d95c7dd343393d):
  // an OLDER run measured `contacts` (considered: 1, covered: 1, checkpoint:
  // committed) via full_inventory. A LATER run re-attempted `contacts`,
  // committed the same checkpoint, but emitted no DETAIL_COVERAGE at all —
  // its fact carries checkpoint: committed with considered: null. The
  // checkpoint-floor alone treats both facts as equally "durable", so the
  // newer, weaker attempt won and shadowed the durable store's still-valid
  // proof, rendering "coverage unknown" for a stream the account had already
  // proven complete. The measured-boundary floor must independently protect
  // the `considered` denominator the checkpoint floor cannot see.
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [fact({ checkpoint: "committed", collected: 0, considered: null, stream: "contacts" })],
    },
    collectionFactsAsOf: "2026-08-22T01:55:46.181Z",
    freshness: "fresh",
    latestStreamFacts: storedFacts(
      [fact({ checkpoint: "committed", collected: 0, considered: 1, covered: 1, stream: "contacts" })],
      { asOf: "2026-08-21T22:49:57.455Z", runId: "run_1787352596202" }
    ),
    manifestStreams: [
      { coverage_strategy: "full_inventory", freshness_strategy: "scheduled_window", name: "contacts", required: true },
    ],
    refresh: null,
  });
  const entry = entryFor(entries, "contacts");
  assert.equal(entry.coverage_condition, "complete", "the durably-measured stored fact is kept, not shadowed");
  assert.equal(entry.considered, 1);
  assert.equal(entry.covered, 1);
  assert.equal(entry.evidence_as_of, "2026-08-21T22:49:57.455Z", "proof age is the STORED fact's own timestamp");
});

test("carry-forward: manifest-deferred stream stays accepted policy regardless of carry evidence", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: { streams: [] },
    freshness: "fresh",
    manifestStreams: [{ coverage_policy: "deferred", name: "drafts", required: false }],
    refresh: null,
  });
  const entry = entryFor(entries, "drafts");
  assert.equal(entry.coverage_condition, "deferred");
  assert.equal(entry.required, false);
  assert.equal(rollupCollectionReportCoverageOverride("complete", entries), null);
});

test("stored evidence: a stored state_stream child inherits from its own run's stored parent, not the classifying block", () => {
  // `messages` (parent, checkpoint_window) is committed in an OLDER block; the
  // child `message_reactions` in that SAME older block is not_staged with no
  // skip/gap — the read-side state_stream inheritance should pick up the
  // parent's committed checkpoint from THAT block. The classifying block has
  // neither stream (both carried).
  const CHILD_MANIFEST: ManifestStreamFixture[] = [
    { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "messages" },
    {
      coverage_strategy: "checkpoint_window",
      freshness_strategy: "scheduled_window",
      name: "message_reactions",
      state_stream: "messages",
    },
  ];
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: { streams: [] },
    freshness: "fresh",
    latestStreamFacts: storedFacts([
      fact({ checkpoint: "committed", collected: 500, considered: 500, stream: "messages" }),
      fact({ checkpoint: "not_staged", collected: 0, considered: 2, stream: "message_reactions" }),
    ]),
    manifestStreams: CHILD_MANIFEST,
    refresh: null,
  });
  const child = entryFor(entries, "message_reactions");
  assert.equal(child.coverage_condition, "complete", "child inherits the parent checkpoint from its OWN carried block");
  assert.equal(child.checkpoint, "committed");
});

// ─── state_stream coverage-condition inheritance (owner ledger 2026-08-22) ───
//
// A projected child stream (manifest `state_stream: <parent>`, e.g. Slack's
// `message_attachments`/`reactions` off `messages`) is FORBIDDEN by the
// runtime's own manifest-honesty validator from emitting its own
// DETAIL_COVERAGE — its `considered` denominator is always blank by design.
// Before this fix, that blank denominator read as the per-stream `unknown`
// coverage_condition, and because the child is `required` by manifest default,
// `rollupCollectionReportCoverageOverride` treated the whole connection as
// unmeasured — voiding a source where every OTHER stream (messages, channels,
// files, ...) was fully proven. The fix inherits the child's condition from its
// parent's OWN entry, but only when that parent is genuinely proven.
const SLACK_SHAPED_MANIFEST: ManifestStreamFixture[] = [
  { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "messages" },
  {
    coverage_strategy: "checkpoint_window",
    freshness_strategy: "scheduled_window",
    name: "message_attachments",
    state_stream: "messages",
  },
];

test("state_stream inheritance: a projected child with a PROVEN parent inherits complete and no longer voids the source", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [
        fact({ checkpoint: "committed", collected: 1_055_994, considered: 1_055_994, stream: "messages" }),
        // The child emits NO DETAIL_COVERAGE at all — considered/covered stay
        // null, exactly as `validateDetailCoverageAgainstManifest` requires.
        fact({
          checkpoint: "not_staged",
          collected: 0,
          considered: null,
          covered: null,
          stream: "message_attachments",
        }),
      ],
    },
    freshness: "fresh",
    manifestStreams: SLACK_SHAPED_MANIFEST,
    refresh: null,
  });
  const parent = entryFor(entries, "messages");
  const child = entryFor(entries, "message_attachments");
  assert.equal(parent.coverage_condition, "complete");
  assert.equal(child.required, true, "no required:false in the manifest -> defaults to required");
  assert.equal(
    child.coverage_condition,
    "complete",
    "the child inherits its PROVEN parent's verdict instead of reading its own blank denominator as unknown"
  );
  assert.equal(
    rollupCollectionReportCoverageOverride("complete", entries),
    null,
    "mutation proof (a): a projected child with a proven parent no longer voids the source"
  );
});

test("state_stream inheritance: a projected child with an UNPROVEN parent stays unknown and still voids the source (fail closed)", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [
        // Parent itself has no proof this run (no considered denominator).
        fact({ checkpoint: "not_staged", collected: 0, considered: null, stream: "messages" }),
        fact({
          checkpoint: "not_staged",
          collected: 0,
          considered: null,
          covered: null,
          stream: "message_attachments",
        }),
      ],
    },
    freshness: "fresh",
    manifestStreams: SLACK_SHAPED_MANIFEST,
    refresh: null,
  });
  const parent = entryFor(entries, "messages");
  const child = entryFor(entries, "message_attachments");
  assert.equal(parent.coverage_condition, "unknown", "the parent itself carries no proof");
  assert.equal(
    child.coverage_condition,
    "unknown",
    "mutation proof (b) — the safety property: an unproven parent must NEVER be inherited; the child stays unknown"
  );
  assert.equal(
    rollupCollectionReportCoverageOverride("complete", entries),
    "unknown",
    "an unproven required child still voids the connection axis exactly as before the fix"
  );
});

test("state_stream inheritance: a genuinely unmeasured NON-projected stream still gates the verdict", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [
        fact({ checkpoint: "committed", collected: 1_055_994, considered: 1_055_994, stream: "messages" }),
        // `channels` is an ordinary sibling stream with NO state_stream
        // declaration — it never emitted its own coverage this run either,
        // but it has no parent to inherit from and must stay unknown.
        fact({ checkpoint: "not_staged", collected: 0, considered: null, stream: "channels" }),
      ],
    },
    freshness: "fresh",
    manifestStreams: [
      ...SLACK_SHAPED_MANIFEST,
      { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "channels" },
    ],
    refresh: null,
  });
  const channels = entryFor(entries, "channels");
  assert.equal(channels.required, true);
  assert.equal(
    channels.coverage_condition,
    "unknown",
    "mutation proof (c): a genuinely unmeasured stream with no declared state_stream parent is never inherited into anything"
  );
  assert.equal(
    rollupCollectionReportCoverageOverride("complete", entries),
    "unknown",
    "the genuinely-unmeasured non-projected stream still gates the verdict"
  );
});

test("state_stream inheritance: a child's own real skip/gap is never masked by an inherited parent verdict", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [
        fact({ checkpoint: "committed", collected: 1_055_994, considered: 1_055_994, stream: "messages" }),
        fact({
          checkpoint: "not_staged",
          collected: 0,
          considered: null,
          skipped: { reason: "connector_panicked" },
          stream: "message_attachments",
        }),
      ],
    },
    freshness: "fresh",
    manifestStreams: SLACK_SHAPED_MANIFEST,
    refresh: null,
  });
  const child = entryFor(entries, "message_attachments");
  assert.equal(
    child.coverage_condition,
    "terminal_gap",
    "a real per-stream skip is its own honest verdict — never overwritten by a proven parent"
  );
});

test("carry-forward: a carried fact zeroes its stale run-local pending_detail_gaps; only the durable store count is authoritative", () => {
  // The older block's fact reports pending_detail_gaps: 3 — a stale run-local
  // number from that old run. The durable gap store (pendingDetailGaps input)
  // reports zero pending rows for this stream today. The carried entry must
  // read the DURABLE zero, not the stale 3 (which would fabricate a
  // retryable_gap that no longer exists).
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: { streams: [] },
    freshness: "fresh",
    latestStreamFacts: storedFacts([
      fact({
        checkpoint: "committed",
        collected: 500,
        considered: 500,
        pending_detail_gaps: 3,
        stream: "messages",
      }),
    ]),
    manifestStreams: CHECKPOINT_MESSAGES_MANIFEST,
    pendingDetailGaps: [],
    refresh: null,
  });
  const entry = entryFor(entries, "messages");
  assert.equal(entry.pending_detail_gaps, 0, "stale carried pending_detail_gaps must be zeroed");
  assert.equal(entry.coverage_condition, "complete", "no retryable_gap fabricated from stale carried count");
});

test("carry-forward: worst-wins is preserved — a terminal_gap entry alongside a required-unknown entry keeps terminal_gap", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [fact({ collected: 0, skipped: { reason: "connector_panicked" }, stream: "lost" })],
    },
    freshness: "fresh",
    manifestStreams: [{ name: "lost" }, { coverage_strategy: "checkpoint_window", name: "messages" }],
    refresh: null,
  });
  assert.equal(entryFor(entries, "lost").coverage_condition, "terminal_gap");
  assert.equal(entryFor(entries, "messages").coverage_condition, "unknown");
  assert.equal(entryFor(entries, "messages").required, true);
  assert.equal(
    rollupCollectionReportCoverageOverride("complete", entries),
    "terminal_gap",
    "the degrading terminal_gap axis wins over the required-unknown refusal — never upgraded"
  );
});

// A required-unknown entry must NEVER upgrade an axis pass 1 already ranks as
// a real degrading condition — `unknown` is not "worse" than
// terminal_gap/retryable_gap/gaps/partial on any ranking, so replacing one of
// those with `unknown` would be a false upgrade, not a worst-wins refusal.
// Parameterized over every degrading axis so this cannot regress silently.
type CoverageAxisFixture = Parameters<typeof rollupCollectionReportCoverageOverride>[0];

for (const currentAxis of [
  "terminal_gap",
  "retryable_gap",
  "gaps",
  "partial",
] as const satisfies readonly CoverageAxisFixture[]) {
  test(`carry-forward: required-unknown entry must NOT upgrade a degrading currentAxis (${currentAxis})`, () => {
    const entries: CollectionReportEntry[] = [
      {
        checkpoint: "unknown",
        collected: 0,
        considered: "unknown",
        coverage_condition: "unknown",
        coverage_strategy: null,
        covered: "unknown",
        evidence_as_of: null,
        forward_disposition: "unmeasured",
        freshness_strategy: null,
        pending_detail_gaps: 0,
        pending_detail_gaps_is_floor: false,
        required: true,
        skipped: null,
        stream: "other",
      },
    ];
    assert.equal(
      rollupCollectionReportCoverageOverride(currentAxis, entries),
      null,
      `a required-unknown entry must leave a degrading currentAxis (${currentAxis}) untouched, never upgrade it to unknown`
    );
  });
}

test("carry-forward: an undeclared fact-only stream resting unknown does NOT trigger the required-unknown override", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: { streams: [fact({ collected: 3, considered: null, stream: "extra" })] },
    freshness: "fresh",
    manifestStreams: [],
    refresh: null,
  });
  const entry = entryFor(entries, "extra");
  assert.equal(entry.coverage_condition, "unknown");
  assert.equal(entry.required, false, "no manifest entry -> not required -> cannot block Healthy");
  assert.equal(
    rollupCollectionReportCoverageOverride("complete", entries),
    null,
    "an undeclared unknown stream must not override a clean connection axis"
  );
});

test("optional terminal stream remains advisory while required terminal stream remains blocking", () => {
  const optional: CollectionReportEntry = {
    checkpoint: "not_staged",
    collected: 0,
    considered: "unknown",
    coverage_condition: "terminal_gap",
    coverage_strategy: null,
    covered: "unknown",
    evidence_as_of: null,
    forward_disposition: "terminal",
    freshness_strategy: null,
    pending_detail_gaps: 0,
    pending_detail_gaps_is_floor: false,
    required: false,
    skipped: { reason: "optional_resource_unavailable" },
    stream: "optional_stream",
  };
  const required = { ...optional, required: true, stream: "required_stream" };

  assert.equal(
    rollupCollectionReportCoverageOverride("complete", [optional], [{ name: "optional_stream", required: false }]),
    null
  );
  assert.equal(
    rollupCollectionReportCoverageOverride("complete", [required], [{ name: "required_stream" }]),
    "terminal_gap"
  );
});

// ─── rollupCollectionReportUnfillableAccounted (§10-A) ────────────────────────
//
// The connection-level sibling rollup: `true` only when the resolved axis is
// `terminal_gap` AND every required stream at `terminal_gap` is itself
// `coverage_unfillable_accounted`. Mirrors production Gmail exactly: the
// `attachments` stream carries 32 proven `too_large` rows mixed with 5
// unproven `temporary_unavailable` rows in the SAME stream, so the per-stream
// classifier already resolves that mix to `false` (see
// collection-report-projection.test.ts's own per-stream tests above) — these
// tests instead cover the connection-level fold across MULTIPLE streams.

function unfillableEntry(
  overrides: Partial<CollectionReportEntry> & Pick<CollectionReportEntry, "stream">
): CollectionReportEntry {
  return {
    checkpoint: "not_staged",
    collected: 0,
    considered: "unknown",
    coverage_condition: "terminal_gap",
    coverage_strategy: null,
    coverage_unfillable_accounted: false,
    covered: "unknown",
    evidence_as_of: null,
    forward_disposition: "terminal",
    freshness_strategy: null,
    pending_detail_gaps: 0,
    pending_detail_gaps_is_floor: false,
    required: true,
    skipped: null,
    ...overrides,
  };
}

test("resolved axis terminal_gap, single required stream fully accounted -> connection accounted true", () => {
  const attachments = unfillableEntry({ coverage_unfillable_accounted: true, stream: "attachments" });
  assert.equal(
    rollupCollectionReportUnfillableAccounted("terminal_gap", [attachments], [{ name: "attachments" }]),
    true
  );
});

test("resolved axis terminal_gap, one of two required terminal_gap streams unaccounted -> connection accounted false", () => {
  const attachments = unfillableEntry({ coverage_unfillable_accounted: true, stream: "attachments" });
  const messages = unfillableEntry({ coverage_unfillable_accounted: false, stream: "messages" });
  assert.equal(
    rollupCollectionReportUnfillableAccounted(
      "terminal_gap",
      [attachments, messages],
      [{ name: "attachments" }, { name: "messages" }]
    ),
    false
  );
});

test("resolved axis is NOT terminal_gap -> always false, even if a stream entry claims accounted (stale/mismatched input)", () => {
  const attachments = unfillableEntry({ coverage_unfillable_accounted: true, stream: "attachments" });
  assert.equal(
    rollupCollectionReportUnfillableAccounted("retryable_gap", [attachments], [{ name: "attachments" }]),
    false
  );
  assert.equal(rollupCollectionReportUnfillableAccounted("complete", [attachments], [{ name: "attachments" }]), false);
});

test("an optional (non-required) terminal_gap stream's proof does not count toward the required-only rollup", () => {
  const optionalStream = unfillableEntry({
    coverage_unfillable_accounted: true,
    required: false,
    stream: "optional_stream",
  });
  // No required stream is terminal_gap at all -> nothing to account for.
  assert.equal(
    rollupCollectionReportUnfillableAccounted(
      "terminal_gap",
      [optionalStream],
      [{ name: "optional_stream", required: false }]
    ),
    false
  );
});

test("no terminal_gap entries in the report at all, despite a terminal_gap resolved axis -> false (mismatched-input guard, never a claim from nothing)", () => {
  assert.equal(rollupCollectionReportUnfillableAccounted("terminal_gap", [], []), false);
});

test("a proven terminal_gap stream alongside a genuinely-unmeasured (unknown) required stream is NOT accounted — cross-stream leakage guard", () => {
  // Reproduces the google-maps/whatsapp shape alongside a Gmail-shaped proven
  // stream on the SAME connection: terminal_gap outranks unknown in worst-wins
  // precedence, so the resolved axis is terminal_gap even though `messages`
  // never carries a terminal_gap entry at all — it would be invisible to a
  // filter that only ever looks at terminal_gap rows.
  const attachments = unfillableEntry({ coverage_unfillable_accounted: true, stream: "attachments" });
  const neverMeasured = unfillableEntry({
    coverage_condition: "unknown",
    forward_disposition: "unmeasured",
    stream: "messages",
  });
  assert.equal(
    rollupCollectionReportUnfillableAccounted(
      "terminal_gap",
      [attachments, neverMeasured],
      [{ name: "attachments" }, { name: "messages" }]
    ),
    false
  );
});

test("a proven terminal_gap stream alongside a retryable_gap required stream is NOT accounted", () => {
  const attachments = unfillableEntry({ coverage_unfillable_accounted: true, stream: "attachments" });
  const retryable = unfillableEntry({
    coverage_condition: "retryable_gap",
    forward_disposition: "resumable",
    stream: "threads",
  });
  assert.equal(
    rollupCollectionReportUnfillableAccounted(
      "terminal_gap",
      [attachments, retryable],
      [{ name: "attachments" }, { name: "threads" }]
    ),
    false
  );
});

test("a proven terminal_gap stream alongside an accepted-coverage (unsupported) required stream IS still accounted", () => {
  // Accepted-coverage axes are settled, non-degrading claims — they must not
  // block the rollup the way unknown/retryable_gap/gaps/partial do.
  const attachments = unfillableEntry({ coverage_unfillable_accounted: true, stream: "attachments" });
  const accepted = unfillableEntry({
    coverage_condition: "unsupported",
    forward_disposition: "complete",
    stream: "labels",
  });
  assert.equal(
    rollupCollectionReportUnfillableAccounted(
      "terminal_gap",
      [attachments, accepted],
      [{ name: "attachments" }, { name: "labels" }]
    ),
    true
  );
});

// openspec/changes/fix-recovery-run-lifecycle: a recovery-only run performs
// no forward/list inventory pass by definition, so `buildCollectionFacts`
// (connector-gap-bounding.ts) returns null for it unconditionally — a
// recovery-only classifying run's `collection_facts` is therefore always
// null/absent here, not a thin fact to overlay. `resolveEffectiveStreamFacts`
// needs no recovery-only-specific code: with collectionFacts empty, every
// stream falls through to the stored fact, with that fact's own provenance
// (evidence_as_of/run_id) completely untouched. Current gap-drain state is a
// SEPARATE channel: `pendingDetailGaps`/`terminalDetailGapsByStream` are live
// reads from the durable gap store, folded independently of collectionFacts.

test("recovery-only classifying run (collection_facts null) falls through to stored inventory evidence with its ORIGINAL provenance", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: null,
    collectionFactsAsOf: "2026-07-15T22:45:32.686Z",
    collectionFactsRunId: "run_1784155457650",
    freshness: "fresh",
    latestStreamFacts: storedFacts(
      [fact({ checkpoint: "committed", collected: 212, considered: 212, stream: "order_items" })],
      { asOf: "2026-07-10T00:00:00.000Z", runId: "run_old" }
    ),
    manifestStreams: [
      { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "order_items" },
    ],
    refresh: null,
  });
  const entry = entryFor(entries, "order_items");
  assert.equal(entry.coverage_condition, "complete", "stored inventory evidence is untouched by the recovery-only run");
  assert.equal(entry.considered, 212);
  assert.equal(
    entry.evidence_as_of,
    "2026-07-10T00:00:00.000Z",
    "proof age is the STORED fact's own timestamp, never the recovery-only run's"
  );
});

test("current gap-drain progress reads live from pendingDetailGaps, independent of the (null) collection_facts", () => {
  // A recovery-only run recovered the one pending gap for order_items down
  // to zero. Its own collection_facts is null (no inventory pass), but the
  // live gap-store input still reflects the drain — the two channels stay
  // separate: inventory evidence/provenance untouched, current gap count live.
  const entriesBeforeDrain = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: null,
    freshness: "fresh",
    latestStreamFacts: storedFacts([
      fact({ checkpoint: "committed", collected: 212, considered: 212, stream: "order_items" }),
    ]),
    manifestStreams: [
      { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "order_items" },
    ],
    pendingDetailGaps: [{ reason: "temporary_unavailable", status: "pending", stream: "order_items" }],
    refresh: null,
  });
  const beforeEntry = entryFor(entriesBeforeDrain, "order_items");
  assert.equal(beforeEntry.pending_detail_gaps, 1);

  const entriesAfterDrain = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: null,
    freshness: "fresh",
    latestStreamFacts: storedFacts([
      fact({ checkpoint: "committed", collected: 212, considered: 212, stream: "order_items" }),
    ]),
    manifestStreams: [
      { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "order_items" },
    ],
    pendingDetailGaps: [],
    refresh: null,
  });
  const afterEntry = entryFor(entriesAfterDrain, "order_items");
  assert.equal(afterEntry.pending_detail_gaps, 0, "current gap count reflects the drain");
  assert.equal(afterEntry.coverage_condition, "complete", "inventory evidence itself is unaffected by the drain");
  assert.equal(
    afterEntry.considered,
    212,
    "considered denominator is unchanged — it never came from the recovery-only run"
  );
});

test("a non-recovery-only classifying run cannot shadow durable stored proof it does not itself match (monotonic floor)", () => {
  // A genuinely failed/unresolved full-scope attempt (checkpoint not_staged,
  // no considered denominator) must not erase durably-committed stored
  // proof — the read-side mirror of `mergeEventStreamFacts`'s store-layer
  // monotonicity guard. The stored fact and its own provenance are restored.
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [fact({ checkpoint: "not_staged", collected: 0, considered: null, stream: "order_items" })],
    },
    collectionFactsAsOf: "2026-07-15T22:45:32.686Z",
    collectionFactsRunId: "run_full_scope_failed",
    freshness: "fresh",
    latestStreamFacts: storedFacts(
      [fact({ checkpoint: "committed", collected: 212, considered: 212, stream: "order_items" })],
      { asOf: "2026-07-10T00:00:00.000Z", runId: "run_old" }
    ),
    manifestStreams: [
      { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "order_items" },
    ],
    refresh: null,
  });
  const entry = entryFor(entries, "order_items");
  assert.equal(entry.coverage_condition, "complete", "the durably-proven stored fact is kept, not shadowed");
  assert.equal(entry.checkpoint, "committed");
  assert.equal(
    entry.evidence_as_of,
    "2026-07-10T00:00:00.000Z",
    "provenance is the STORED fact's own, restored with it"
  );
  assert.equal(entry.considered, 212);
});

test("forward progress: a newer classifying fact that itself proves durable coverage still replaces an older stored proof", () => {
  // The floor is a floor, not a freeze: a classifying run whose OWN fact
  // also proves durable coverage (a genuine committed re-measurement) still
  // wins normally, advancing evidence_as_of/considered to the newer values.
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [fact({ checkpoint: "committed", collected: 300, considered: 300, stream: "order_items" })],
    },
    collectionFactsAsOf: "2026-07-20T00:00:00.000Z",
    collectionFactsRunId: "run_full_scope_succeeded",
    freshness: "fresh",
    latestStreamFacts: storedFacts(
      [fact({ checkpoint: "committed", collected: 212, considered: 212, stream: "order_items" })],
      { asOf: "2026-07-10T00:00:00.000Z", runId: "run_old" }
    ),
    manifestStreams: [
      { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "order_items" },
    ],
    refresh: null,
  });
  const entry = entryFor(entries, "order_items");
  assert.equal(entry.coverage_condition, "complete");
  assert.equal(entry.considered, 300, "the newer classifying fact wins — forward progress is not blocked by the floor");
  assert.equal(
    entry.evidence_as_of,
    "2026-07-20T00:00:00.000Z",
    "provenance advances to the newer classifying run's own timestamp"
  );
});

test("never-proven stream: an unresolved classifying attempt still replaces an unresolved stored fact (no floor without prior proof)", () => {
  // The floor only protects a stored fact that ITSELF proves durable
  // coverage. A stream with no durably-proven stored fact is unaffected:
  // the classifying run's newest attempt — resolved or not — still wins, so
  // an honestly-never-proven stream keeps surfacing its newest attempt
  // rather than freezing on the first (also-unresolved) thing ever stored.
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [fact({ checkpoint: "not_staged", collected: 5, considered: null, stream: "order_items" })],
    },
    collectionFactsAsOf: "2026-07-20T00:00:00.000Z",
    collectionFactsRunId: "run_full_scope_failed_again",
    freshness: "fresh",
    latestStreamFacts: storedFacts(
      [fact({ checkpoint: "not_staged", collected: 0, considered: null, stream: "order_items" })],
      { asOf: "2026-07-10T00:00:00.000Z", runId: "run_old" }
    ),
    manifestStreams: [
      { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "order_items" },
    ],
    refresh: null,
  });
  const entry = entryFor(entries, "order_items");
  assert.equal(
    entry.coverage_condition,
    "unknown",
    "never-proven stream stays honestly unknown — the floor is not a green-wash"
  );
  assert.equal(
    entry.evidence_as_of,
    "2026-07-20T00:00:00.000Z",
    "the classifying run's newest attempt still wins provenance"
  );
});

// Amazon-shaped acceptance test reproducing run_1784155457650: a recovery-only
// run recovers 15 pending detail gaps and drains the backlog to zero. Its
// collection_facts is null, so BOTH orders and order_items keep their prior
// evidence and provenance completely untouched; only the live pending-gap
// count (read separately) reflects the drain.
test("acceptance: Amazon-shaped recovery-only run (15 gaps recovered, pending drained to zero) leaves both streams evidence+provenance untouched", () => {
  const priorEvidenceAsOf = "2026-07-10T00:00:00.000Z";
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: null,
    collectionFactsAsOf: "2026-07-15T22:45:32.686Z",
    collectionFactsRunId: "run_1784155457650",
    freshness: "fresh",
    latestStreamFacts: storedFacts(
      [
        fact({ checkpoint: "committed", collected: 40, considered: 40, stream: "orders" }),
        fact({ checkpoint: "committed", collected: 212, considered: 212, stream: "order_items" }),
      ],
      { asOf: priorEvidenceAsOf, runId: "run_1784100000000" }
    ),
    manifestStreams: [
      { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "orders" },
      { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "order_items" },
    ],
    pendingDetailGaps: [], // drained to zero by the recovery-only run
    refresh: null,
  });
  const orders = entryFor(entries, "orders");
  const orderItems = entryFor(entries, "order_items");
  assert.equal(orders.coverage_condition, "complete", "orders keeps prior evidence");
  assert.equal(orders.considered, 40);
  assert.equal(
    orders.evidence_as_of,
    priorEvidenceAsOf,
    "orders provenance is the prior run's, not the recovery run's"
  );
  assert.equal(orderItems.coverage_condition, "complete", "order_items (touched/recovered) also keeps prior evidence");
  assert.equal(orderItems.considered, 212);
  assert.equal(orderItems.evidence_as_of, priorEvidenceAsOf, "order_items provenance is also not restamped");
  assert.equal(orderItems.pending_detail_gaps, 0, "the drain to zero is still reflected via the live gap-store input");
});

// Proof-predicate parity: `resolveEffectiveStreamFacts`'s monotonic
// durable-proof floor uses the SAME `checkpoint === 'committed' ||
// checkpoint === 'disabled'` boundary as the store-layer fold's
// `mergeEventStreamFacts` guard (`connector-summary-read-model.ts`) and the
// coverage derivation's `checkpointProvesCoverage`
// (`connector-coverage-policy.ts`). All three are mirrored, not imported
// (each module stays dependency-free of the others), so this black-box test
// pins that `disabled` proves durable coverage exactly like `committed` at
// this third site — `test/connector-summary-stream-facts.test.js`'s
// "monotonic guard: a legitimate skipped/accepted-absence fact with a
// proving checkpoint still counts as durable proof (not blocked)" pins the
// same `disabled`-proves-coverage boundary at the store layer.
test("proof-predicate parity: a stored `disabled` checkpoint proves durable coverage exactly like `committed`, shadowing an unresolved classifying attempt", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [fact({ checkpoint: "not_staged", collected: 0, considered: null, stream: "order_items" })],
    },
    collectionFactsAsOf: "2026-07-15T22:45:32.686Z",
    collectionFactsRunId: "run_full_scope_failed",
    freshness: "fresh",
    latestStreamFacts: storedFacts(
      [fact({ checkpoint: "disabled", collected: 0, considered: 4, covered: 4, stream: "order_items" })],
      { asOf: "2026-07-10T00:00:00.000Z", runId: "run_old" }
    ),
    manifestStreams: [
      { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "order_items" },
    ],
    refresh: null,
  });
  const entry = entryFor(entries, "order_items");
  assert.equal(
    entry.coverage_condition,
    "complete",
    "a `disabled` stored checkpoint proves durable coverage, same as `committed`"
  );
  assert.equal(entry.checkpoint, "disabled");
  assert.equal(entry.evidence_as_of, "2026-07-10T00:00:00.000Z");
});

// ─── getUnfillableAccountedByStreamForInstanceIds (batch list-page reader) ────
//
// The list page's per-stream unfillable verdict comes from a batched
// terminal-gap ROW read. These pin the reader's refusals directly, against a
// fake store, because the real store's per-instance cap is not reachable from
// the projection call site: the honest-`null` and truncation contracts are the
// whole safety argument for reading a bounded page at all.

type TerminalGapPageReadFixture = Awaited<
  ReturnType<NonNullable<ConnectorDetailGapStoreLike["listTerminalGapsByConnectorInstanceIds"]>>
>;

/** A store exposing ONLY the batch terminal-gap read, returning a caller-supplied page. */
function batchGapStore(
  read: TerminalGapPageReadFixture | (() => TerminalGapPageReadFixture)
): ConnectorDetailGapStoreLike {
  return {
    listPendingGaps: () => [],
    listTerminalGapsByConnectorInstanceIds: () => (typeof read === "function" ? read() : read),
  };
}

const PROVEN_GAP = { last_error: { message: "attachment exceeds max size: 29209135 > 26214400 bytes" } };
// Production's retry-exhausted shape: terminalized with no recorded error.
const UNPROVEN_GAP = { last_error: null };

test("batch unfillable read proves a stream whose terminal gaps all carry size-vs-cap evidence", async () => {
  const verdicts = await getUnfillableAccountedByStreamForInstanceIds(
    batchGapStore({
      gapsByConnectorInstanceId: new Map([
        [
          "cin_a",
          [
            { ...PROVEN_GAP, stream: "attachments" },
            { ...PROVEN_GAP, stream: "attachments" },
          ],
        ],
      ]),
      truncatedConnectorInstanceIds: new Set(),
    }),
    ["cin_a"]
  );
  assert.equal(verdicts?.get("cin_a")?.get("attachments"), true);
});

test("batch unfillable read refuses a stream holding even one unproven terminal gap", async () => {
  const verdicts = await getUnfillableAccountedByStreamForInstanceIds(
    batchGapStore({
      gapsByConnectorInstanceId: new Map([
        [
          "cin_a",
          [
            { ...PROVEN_GAP, stream: "attachments" },
            { ...UNPROVEN_GAP, stream: "attachments" },
            { ...PROVEN_GAP, stream: "labels" },
          ],
        ],
      ]),
      truncatedConnectorInstanceIds: new Set(),
    }),
    ["cin_a"]
  );
  assert.equal(
    verdicts?.get("cin_a")?.get("attachments"),
    false,
    "partial proof is not proof — one unproven gap sinks the stream"
  );
  assert.equal(verdicts?.get("cin_a")?.get("labels"), true, "a sibling stream is judged on its own gaps");
});

test("batch unfillable read leaves a truncated instance unmeasured even when every returned row is proven", async () => {
  const verdicts = await getUnfillableAccountedByStreamForInstanceIds(
    batchGapStore({
      // The store withholds a truncated instance's rows; assert the reader
      // refuses even if a future store regression hands them over anyway.
      gapsByConnectorInstanceId: new Map([
        ["cin_truncated", [{ ...PROVEN_GAP, stream: "attachments" }]],
        ["cin_complete", [{ ...PROVEN_GAP, stream: "attachments" }]],
      ]),
      truncatedConnectorInstanceIds: new Set(["cin_truncated"]),
    }),
    ["cin_truncated", "cin_complete"]
  );
  assert.equal(
    verdicts?.get("cin_truncated"),
    undefined,
    "a truncated read is unmeasured, never a `true` fabricated from the rows that happened to fit"
  );
  assert.equal(verdicts?.get("cin_complete")?.get("attachments"), true, "the complete sibling is still decided");
});

test("batch unfillable read is null (unmeasured) when the store does not implement it or the read throws", async () => {
  assert.equal(
    await getUnfillableAccountedByStreamForInstanceIds({ listPendingGaps: () => [] }, ["cin_a"]),
    null,
    "a store without the batch read yields unmeasured, never a verdict derived from counts"
  );
  assert.equal(
    await getUnfillableAccountedByStreamForInstanceIds(
      batchGapStore(() => {
        throw new Error("detail gap store unavailable");
      }),
      ["cin_a"]
    ),
    null,
    "a throwing read yields unmeasured, matching every other optional field on this projection"
  );
});

// ─── B9: a collector-runner failure is not a data stream ─────────────────────
//
// The detail-gap store is keyed by stream, but a local-collector gap is not
// stream-scoped: `connector_child_failure` means the collector's child process
// died and `policy_budget` means it hit a scan budget. To fit the stream-shaped
// key, `parseGapBodyBase` (routes/ref-device-exporters.ts) mints a synthetic
// name like `local-collector/connector_child_failure` and stores it in the
// `stream` column, alongside a structured
// `detail_locator: { kind: "local_collector_gap", reason }`.
//
// Unfiltered, that pseudo-stream entered the collection report's in-scope
// stream universe and the console rendered a PROCESS FAILURE as one of the
// owner's DATA STREAMS (owner: "there's a stream called 'local collector slash
// connector child failure' which is an odd stream").
//
// These tests pin that the report excludes runner conditions while still
// surfacing every real stream gap. The failure itself keeps reaching the owner
// through `local_collector_gaps` diagnostics, which is a separate aggregation
// path (`accumulateGapRow`) that these tests deliberately do not touch.

test("B9: a local-collector runner gap never becomes a stream in the collection report", () => {
  const entries = report(null, {
    freshness: "unknown",
    manifestStreams: [{ name: "messages" }],
    pendingDetailGaps: [
      {
        detail_locator: { kind: "local_collector_gap", reason: "connector_child_failure" },
        reason: "connector_child_failure",
        status: "pending",
        stream: "local-collector/connector_child_failure",
      },
    ],
  });
  assert.deepEqual(
    entries.map((e) => e.stream),
    ["messages"],
    "a crashed collector child is a run condition, never one of the owner's data streams"
  );
});

test("B9: the runner-gap filter keys on detail_locator.kind, not on the stream-name separator", () => {
  // Two emitters have used different separators (`local-collector/` and
  // `local_collector/`). The structured locator is the authored field and is
  // immune to that drift, so it alone must be enough to exclude the row.
  for (const stream of ["local-collector/connector_child_failure", "local_collector/connector_child_failure"]) {
    const entries = report(null, {
      freshness: "unknown",
      manifestStreams: [{ name: "messages" }],
      pendingDetailGaps: [
        {
          detail_locator: { kind: "local_collector_gap", reason: "connector_child_failure" },
          reason: "connector_child_failure",
          status: "pending",
          stream,
        },
      ],
    });
    assert.deepEqual(entries.map((e) => e.stream), ["messages"], `separator variant "${stream}" must be excluded`);
  }
});

test("B9: the structured locator alone excludes a runner gap, with no help from the name prefix", () => {
  // Mutation-hardening: every other B9 case carries the `local-collector/`
  // prefix, so the fallback guard could mask a broken locator check. Here the
  // stream name is deliberately prefix-free — only `detail_locator.kind` can
  // classify it. If the locator branch stops working, this is the test that
  // notices.
  const entries = report(null, {
    freshness: "unknown",
    manifestStreams: [{ name: "messages" }],
    pendingDetailGaps: [
      {
        detail_locator: { kind: "local_collector_gap", reason: "connector_child_failure" },
        reason: "connector_child_failure",
        status: "pending",
        stream: "connector_child_failure",
      },
    ],
  });
  assert.deepEqual(
    entries.map((e) => e.stream),
    ["messages"],
    "the structured locator must classify a runner gap even when the stream name carries no namespace prefix"
  );
});

test("B9: a runner gap with no structured locator still falls back to the name-prefix guard", () => {
  // Rows written before the locator was populated must not resurrect the
  // phantom stream.
  const entries = report(null, {
    freshness: "unknown",
    manifestStreams: [{ name: "messages" }],
    pendingDetailGaps: [
      { reason: "policy_budget", status: "pending", stream: "local-collector/policy_budget" },
      { reason: "policy_budget", status: "pending", stream: "local_collector/policy_budget/messages" },
    ],
  });
  assert.deepEqual(entries.map((e) => e.stream), ["messages"]);
});

test("B9: excluding runner gaps does NOT suppress real stream gaps on the same connection", () => {
  // The load-bearing negative control: the filter must be narrow. A genuine
  // per-stream gap sitting next to a runner condition still degrades its stream.
  const entries = report(null, {
    freshness: "unknown",
    manifestStreams: [{ name: "messages" }],
    pendingDetailGaps: [
      {
        detail_locator: { kind: "local_collector_gap", reason: "connector_child_failure" },
        reason: "connector_child_failure",
        status: "pending",
        stream: "local-collector/connector_child_failure",
      },
      { reason: "temporary_unavailable", status: "pending", stream: "messages" },
    ],
  });
  assert.deepEqual(entries.map((e) => e.stream), ["messages"]);
  const messages = entryFor(entries, "messages");
  assert.equal(messages.pending_detail_gaps, 1, "the real gap is counted, and the runner condition is not counted into it");
  assert.equal(messages.coverage_condition, "retryable_gap");
});
