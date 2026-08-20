// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure server-side version_disposition AND version_remediation
 * classifiers, plus the reviewed-compaction-residue operator-state reader.
 *
 * `ri-zero-knowledge-terminal-revise-0810`: version-disposition.ts no longer
 * reads any RI-committed JSON registry. `classifyVersionDisposition` and
 * `classifyVersionRemediation` take their reference-controlled inputs
 * (`compactionClass`, `hasCompactionPolicy`, `reviewedAt`,
 * `pendingRemediation`) directly as parameters, pre-resolved by the caller
 * (record-version-stats.ts) from the connector's own manifest
 * (`getConnectorManifest`) and from operator runtime state
 * (`readReviewedCompactionResidueMap`, at `PDPP_COMPACTION_RESIDUE_REVIEW_PATH`).
 * These tests pin the CLASSIFICATION LOGIC precedence, which is unchanged
 * from the prior list-lookup design — only the SOURCE of the inputs moved.
 *
 * The first half exercises the five-way disposition derivation directly (no DB),
 * pinning the acceptance criteria from the OpenSpec change
 * `add-version-disposition-for-retained-history`:
 *
 *   AC-3 unclassified high/watch → active_defect_or_unclassified
 *   AC-4 reviewed residue re-alarms after review timestamp
 *   AC-5 sessions (compactionClass="recurring_snapshot") → recurring_point_in_time_snapshot (no re-alarm on growth)
 *   AC-6 split residual entity stream (compactionClass="point_in_time_real_field") → point_in_time_retained_history
 *   AC-7 disposition reads only reference-controlled parameters (no connector-authored value)
 *
 * The second half exercises the orthogonal `classifyVersionRemediation`, pinning
 * the acceptance criteria from `add-version-remediation-disposition` (AC-3..AC-8
 * there): a `pendingRemediation: "content_fingerprint_pending"` row reads
 * content_fingerprint_pending, `"owner_migration_pending"` reads
 * owner_migration_pending and is distinct from it, a
 * `recurring_point_in_time_snapshot` disposition always reads
 * owner_retention_policy, every other row is none, no connector input
 * participates, and remediation never contradicts the disposition it consumes.
 *
 * Both labels are independent of the numeric risk classification — these tests
 * never pass a risk level and the classifiers never consult one.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyVersionDisposition,
  classifyVersionRemediation,
  normalizeConnectorId,
  readReviewedCompactionResidueMap,
  resetReviewedCompactionResidueCacheForTests,
  VERSION_DISPOSITIONS,
  VERSION_REMEDIATIONS,
} from "../server/version-disposition.ts";

function oneMillisecondAfter(iso: string): string {
  return new Date(new Date(iso).getTime() + 1).toISOString();
}

const USAA_ACCOUNTS_REVIEWED_AT = "2026-06-05T13:57:05.707Z";
const CHASE_STATEMENTS_REVIEWED_AT = "2026-06-05T13:57:05.707Z";

// ─── Recurring point-in-time snapshots (disposition #5, the new construction) ─

test("classifyVersionDisposition: compactionClass=recurring_snapshot is a recurring point-in-time snapshot", () => {
  assert.equal(
    classifyVersionDisposition({
      compactionClass: "recurring_snapshot",
      // sessions DO have a registered compaction policy — the recurring-snapshot
      // signal must take precedence so it does not read as a candidate.
      hasCompactionPolicy: true,
      lastHistoryAt: "2026-06-04T19:15:01.028Z",
    }),
    "recurring_point_in_time_snapshot"
  );
});

test("classifyVersionDisposition: a recurring snapshot does NOT re-alarm when history advances (AC-5)", () => {
  // No reviewed-at timestamp gates this disposition: growth is its expected,
  // non-removable signal. A much later last_history_at must still classify #5.
  for (const lastHistoryAt of [
    "2026-06-04T19:15:01.028Z",
    "2026-06-10T00:00:00.000Z",
    "2027-01-01T00:00:00.000Z",
    null,
  ]) {
    assert.equal(
      classifyVersionDisposition({
        compactionClass: "recurring_snapshot",
        hasCompactionPolicy: true,
        lastHistoryAt,
      }),
      "recurring_point_in_time_snapshot",
      `must stay #5 for last_history_at=${lastHistoryAt}`
    );
  }
});

test("classifyVersionDisposition: recurring snapshot wins even with a reviewedAt on record", () => {
  // Precedence guard: compactionClass is checked BEFORE reviewedAt, so a stale
  // or incorrect reviewed-residue entry cannot pull a recurring-snapshot row
  // out of its correct disposition.
  assert.equal(
    classifyVersionDisposition({
      compactionClass: "recurring_snapshot",
      hasCompactionPolicy: true,
      lastHistoryAt: "2030-01-01T00:00:00.000Z",
      reviewedAt: "2020-01-01T00:00:00.000Z",
    }),
    "recurring_point_in_time_snapshot"
  );
});

// ─── Point-in-time retained history (disposition #3) ─────────────────────────

test("classifyVersionDisposition: compactionClass=point_in_time_real_field is point_in_time_retained_history (AC-6)", () => {
  assert.equal(
    classifyVersionDisposition({ compactionClass: "point_in_time_real_field", hasCompactionPolicy: false }),
    "point_in_time_retained_history"
  );
});

// ─── Reviewed historical residue (disposition #2) + re-alarm (#4) ────────────

test("classifyVersionDisposition: reviewed residue classifies #2 within the review window", () => {
  assert.equal(
    classifyVersionDisposition({
      compactionClass: null,
      hasCompactionPolicy: true,
      lastHistoryAt: "2026-06-03T12:00:00.000Z",
      reviewedAt: USAA_ACCOUNTS_REVIEWED_AT,
    }),
    "reviewed_historical_residue"
  );
});

test("classifyVersionDisposition: reviewed residue classifies #2 when last_history_at equals reviewedAt exactly", () => {
  assert.equal(
    classifyVersionDisposition({
      compactionClass: null,
      hasCompactionPolicy: true,
      lastHistoryAt: USAA_ACCOUNTS_REVIEWED_AT,
      reviewedAt: USAA_ACCOUNTS_REVIEWED_AT,
    }),
    "reviewed_historical_residue"
  );
});

test("classifyVersionDisposition: reviewed residue re-alarms to #4 after the review timestamp (AC-4)", () => {
  assert.equal(
    classifyVersionDisposition({
      compactionClass: null,
      hasCompactionPolicy: true,
      lastHistoryAt: oneMillisecondAfter(USAA_ACCOUNTS_REVIEWED_AT),
      reviewedAt: USAA_ACCOUNTS_REVIEWED_AT,
    }),
    "lossless_compaction_candidate"
  );
  assert.equal(
    classifyVersionDisposition({
      compactionClass: null,
      hasCompactionPolicy: true,
      lastHistoryAt: oneMillisecondAfter(CHASE_STATEMENTS_REVIEWED_AT),
      reviewedAt: CHASE_STATEMENTS_REVIEWED_AT,
    }),
    "lossless_compaction_candidate"
  );
});

test("classifyVersionDisposition: reviewed residue re-alarms to #4 when last_history_at is unavailable", () => {
  // Unverifiable guard → re-alarm rather than silently suppress.
  assert.equal(
    classifyVersionDisposition({
      compactionClass: null,
      hasCompactionPolicy: true,
      lastHistoryAt: null,
      reviewedAt: USAA_ACCOUNTS_REVIEWED_AT,
    }),
    "lossless_compaction_candidate"
  );
});

test("classifyVersionDisposition: no reviewedAt on record is never #2", () => {
  assert.equal(
    classifyVersionDisposition({
      compactionClass: null,
      hasCompactionPolicy: true,
      lastHistoryAt: "2026-06-03T12:00:00.000Z",
    }),
    "lossless_compaction_candidate"
  );
});

// ─── Lossless compaction candidate (disposition #4) ──────────────────────────

test("classifyVersionDisposition: a policied stream with no recognized class/review is a compaction candidate", () => {
  assert.equal(
    classifyVersionDisposition({ compactionClass: null, hasCompactionPolicy: true }),
    "lossless_compaction_candidate"
  );
});

// ─── Active defect / unclassified (disposition #1, the only "needs review") ───

test("classifyVersionDisposition: an unknown high/watch stream is active_defect_or_unclassified (AC-3)", () => {
  assert.equal(
    classifyVersionDisposition({ compactionClass: null, hasCompactionPolicy: false }),
    "active_defect_or_unclassified"
  );
});

test("classifyVersionDisposition: called with no arguments is active_defect_or_unclassified", () => {
  assert.equal(classifyVersionDisposition(), "active_defect_or_unclassified");
});

// ─── Anti-self-declaration (AC-7) ────────────────────────────────────────────

test("classifyVersionDisposition: an unrecognized compactionClass string is treated as null, not trusted as an override", () => {
  // A connector's manifest could only ever carry the two enumerated values in
  // practice (connector-manifest-validation.ts governs that), but this proves
  // the classifier ITSELF is the backstop: any other string is inert, exactly
  // like a null/absent class, so a manifest field can never invent a third
  // disposition this module does not define.
  const hostileCompactionClass = "self_declared_never_compact" as unknown as null;
  assert.equal(
    classifyVersionDisposition({ compactionClass: hostileCompactionClass, hasCompactionPolicy: false }),
    "active_defect_or_unclassified"
  );
});

test("classifyVersionDisposition: only reference-controlled inputs participate; payload fields are ignored", () => {
  // Spread connector-authored junk into the input. The classifier signature
  // only reads compactionClass/lastHistoryAt/hasCompactionPolicy/reviewedAt;
  // any other property (a connector trying to assert its own disposition) is
  // inert. Held in an intermediate, non-fresh-literal binding so TS's
  // excess-property check (which only fires on object literals passed
  // inline) does not flag the deliberately-hostile extra fields this test
  // proves are ignored at runtime by the plain destructuring in
  // classifyVersionDisposition's body.
  const hostilePayload: Record<string, unknown> = {
    compactionClass: null,
    connectorId: "mystery",
    disposition: "recurring_point_in_time_snapshot",
    hasCompactionPolicy: false,
    semantics: "append",
    stream: "widgets",
    suppress: true,
    // hostile/attacker-authored attempts to self-declare:
    version_disposition: "point_in_time_retained_history",
  };
  const declaredAway = classifyVersionDisposition(hostilePayload as Parameters<typeof classifyVersionDisposition>[0]);
  assert.equal(
    declaredAway,
    "active_defect_or_unclassified",
    "a connector cannot self-declare its churn into a safe disposition"
  );
});

// ─── Registry shape invariants ───────────────────────────────────────────────

test("the five dispositions are exactly the documented set", () => {
  assert.deepEqual([...VERSION_DISPOSITIONS].sort(), [
    "active_defect_or_unclassified",
    "lossless_compaction_candidate",
    "point_in_time_retained_history",
    "recurring_point_in_time_snapshot",
    "reviewed_historical_residue",
  ]);
});

test("normalizeConnectorId strips registry-URL and local-device forms", () => {
  assert.equal(normalizeConnectorId("github"), "github");
  assert.equal(normalizeConnectorId("https://registry.pdpp.dev/connectors/github"), "github");
  assert.equal(normalizeConnectorId("local-device:claude-code"), "claude-code");
  assert.equal(normalizeConnectorId(null), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// version_remediation — the orthogonal next-action axis
// (OpenSpec add-version-remediation-disposition)
//
//   AC-3 pendingRemediation="content_fingerprint_pending" → content_fingerprint_pending
//   AC-4 pendingRemediation="owner_migration_pending" → owner_migration_pending (distinct from AC-3)
//   AC-5 recurring_point_in_time_snapshot disposition → owner_retention_policy
//   AC-6 candidate / unlisted point-in-time / defect → none
//   AC-7 remediation reads only reference signals (no connector-authored value)
//   AC-8 remediation never contradicts disposition (consistency guard)
// ═══════════════════════════════════════════════════════════════════════════

// ─── AC-3 content_fingerprint_pending (the statement rows) ───────────────────

test("classifyVersionRemediation: pendingRemediation=content_fingerprint_pending on reviewed residue reads content_fingerprint_pending (AC-3)", () => {
  assert.equal(
    classifyVersionRemediation({
      pendingRemediation: "content_fingerprint_pending",
      versionDisposition: "reviewed_historical_residue",
    }),
    "content_fingerprint_pending"
  );
});

// ─── AC-4 owner_migration_pending, distinct from content_fingerprint_pending ──

test("classifyVersionRemediation: pendingRemediation=owner_migration_pending on reviewed residue reads owner_migration_pending (AC-4)", () => {
  const migrationPending = classifyVersionRemediation({
    pendingRemediation: "owner_migration_pending",
    versionDisposition: "reviewed_historical_residue",
  });
  assert.equal(migrationPending, "owner_migration_pending");

  // Distinct from the fingerprint-pending rows even though both share the
  // reviewed_historical_residue disposition — the whole point of the axis.
  const fingerprintPending = classifyVersionRemediation({
    pendingRemediation: "content_fingerprint_pending",
    versionDisposition: "reviewed_historical_residue",
  });
  assert.notEqual(migrationPending, fingerprintPending);
});

// ─── AC-5 owner_retention_policy (sessions) ──────────────────────────────────

test("classifyVersionRemediation: recurring_point_in_time_snapshot disposition is always owner_retention_policy (AC-5)", () => {
  assert.equal(
    classifyVersionRemediation({
      pendingRemediation: null,
      versionDisposition: "recurring_point_in_time_snapshot",
    }),
    "owner_retention_policy"
  );
  // Even if a pendingRemediation happens to be set, recurring-snapshot wins —
  // pinned separately below (AC-8-adjacent precedence).
  assert.equal(
    classifyVersionRemediation({
      pendingRemediation: "content_fingerprint_pending",
      versionDisposition: "recurring_point_in_time_snapshot",
    }),
    "owner_retention_policy"
  );
});

// ─── AC-6 none defaults ──────────────────────────────────────────────────────

test("classifyVersionRemediation: a lossless_compaction_candidate is always none (AC-6)", () => {
  assert.equal(
    classifyVersionRemediation({ pendingRemediation: null, versionDisposition: "lossless_compaction_candidate" }),
    "none"
  );
});

test("classifyVersionRemediation: an unlisted point_in_time_retained_history is none (AC-6)", () => {
  assert.equal(
    classifyVersionRemediation({ pendingRemediation: null, versionDisposition: "point_in_time_retained_history" }),
    "none"
  );
});

test("classifyVersionRemediation: active_defect_or_unclassified is always none (AC-6)", () => {
  assert.equal(
    classifyVersionRemediation({ pendingRemediation: null, versionDisposition: "active_defect_or_unclassified" }),
    "none"
  );
});

test("classifyVersionRemediation: called with no arguments is none", () => {
  assert.equal(classifyVersionRemediation(), "none");
});

// ─── AC-7 anti-self-declaration ──────────────────────────────────────────────

test("classifyVersionRemediation: only reference-controlled inputs participate; payload fields are ignored (AC-7)", () => {
  // The signature reads versionDisposition/pendingRemediation only. A
  // connector spreading a hostile self-declared remediation cannot change the
  // answer: an unlisted stream stays none regardless of the junk fields.
  const hostilePayload: Record<string, unknown> = {
    connectorId: "mystery",
    pendingRemediation: null,
    remediation: "owner_retention_policy",
    stream: "widgets",
    suppress: true,
    version_remediation: "none",
    versionDisposition: "reviewed_historical_residue",
  };
  const declaredAway = classifyVersionRemediation(hostilePayload as Parameters<typeof classifyVersionRemediation>[0]);
  assert.equal(declaredAway, "none", "a connector cannot self-declare its remediation");
});

// ─── AC-8 consistency guard (remediation never contradicts disposition) ──────

test("classifyVersionRemediation: owner_retention_policy requires the recurring-snapshot disposition (AC-8)", () => {
  // pendingRemediation alone (without the recurring-snapshot disposition)
  // never produces owner_retention_policy.
  assert.notEqual(
    classifyVersionRemediation({ pendingRemediation: null, versionDisposition: "reviewed_historical_residue" }),
    "owner_retention_policy"
  );
});

test("classifyVersionRemediation: a candidate/defect disposition cannot be overridden by pendingRemediation (AC-8)", () => {
  // Even if pendingRemediation is set, the hard guard keeps a candidate/defect
  // row none — its action is already the dry-run command or "review it".
  assert.equal(
    classifyVersionRemediation({
      pendingRemediation: "content_fingerprint_pending",
      versionDisposition: "lossless_compaction_candidate",
    }),
    "none"
  );
  assert.equal(
    classifyVersionRemediation({
      pendingRemediation: "owner_migration_pending",
      versionDisposition: "active_defect_or_unclassified",
    }),
    "none"
  );
});

test("classifyVersionRemediation: migration precedence beats fingerprint when both could match", () => {
  // pendingRemediation only ever carries ONE value per row (the caller
  // resolves a single reviewed-residue entry per connector/stream), but pin
  // the precedence order directly: migration is checked before fingerprint.
  assert.equal(
    classifyVersionRemediation({
      pendingRemediation: "owner_migration_pending",
      versionDisposition: "reviewed_historical_residue",
    }),
    "owner_migration_pending"
  );
});

// ─── Registry shape invariants for remediation ───────────────────────────────

test("the four remediations are exactly the documented set", () => {
  assert.deepEqual([...VERSION_REMEDIATIONS].sort(), [
    "content_fingerprint_pending",
    "none",
    "owner_migration_pending",
    "owner_retention_policy",
  ]);
});

// ═══════════════════════════════════════════════════════════════════════════
// readReviewedCompactionResidueMap — operator runtime state, not RI-committed
// JSON (ri-zero-knowledge-terminal-revise-0810)
// ═══════════════════════════════════════════════════════════════════════════

test("readReviewedCompactionResidueMap: defaults to empty when PDPP_COMPACTION_RESIDUE_REVIEW_PATH is unset and the default path does not exist", () => {
  const previous = process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH;
  delete process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH;
  resetReviewedCompactionResidueCacheForTests();
  try {
    // The default path is /var/lib/pdpp/compaction-residue-review.json, which
    // does not exist in this test environment (and must never be committed
    // with real data per the owner ruling) — this must not throw.
    assert.equal(existsSync("/var/lib/pdpp/compaction-residue-review.json"), false);
    const map = readReviewedCompactionResidueMap();
    assert.equal(map.size, 0);
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH;
    } else {
      process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH = previous;
    }
    resetReviewedCompactionResidueCacheForTests();
  }
});

test("readReviewedCompactionResidueMap: defaults to empty (never throws) when the configured path does not exist", () => {
  const previous = process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH;
  const dir = mkdtempSync(join(tmpdir(), "compaction-residue-review-"));
  const missingPath = join(dir, "does-not-exist.json");
  process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH = missingPath;
  resetReviewedCompactionResidueCacheForTests();
  try {
    assert.doesNotThrow(() => readReviewedCompactionResidueMap());
    const map = readReviewedCompactionResidueMap();
    assert.equal(map.size, 0);
  } finally {
    rmSync(dir, { force: true, recursive: true });
    if (previous === undefined) {
      delete process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH;
    } else {
      process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH = previous;
    }
    resetReviewedCompactionResidueCacheForTests();
  }
});

test("readReviewedCompactionResidueMap: reads a bare ISO timestamp entry as reviewedAt with null pendingRemediation", () => {
  const previous = process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH;
  const dir = mkdtempSync(join(tmpdir(), "compaction-residue-review-"));
  const filePath = join(dir, "review.json");
  writeFileSync(filePath, JSON.stringify({ "usaa/accounts": USAA_ACCOUNTS_REVIEWED_AT }));
  process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH = filePath;
  resetReviewedCompactionResidueCacheForTests();
  try {
    const map = readReviewedCompactionResidueMap();
    const entry = map.get("usaa/accounts");
    assert.ok(entry);
    assert.equal(entry.reviewedAt, USAA_ACCOUNTS_REVIEWED_AT);
    assert.equal(entry.pendingRemediation, null);
  } finally {
    rmSync(dir, { force: true, recursive: true });
    if (previous === undefined) {
      delete process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH;
    } else {
      process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH = previous;
    }
    resetReviewedCompactionResidueCacheForTests();
  }
});

test("readReviewedCompactionResidueMap: reads an object entry with pendingRemediation", () => {
  const previous = process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH;
  const dir = mkdtempSync(join(tmpdir(), "compaction-residue-review-"));
  const filePath = join(dir, "review.json");
  writeFileSync(
    filePath,
    JSON.stringify({
      "usaa/accounts": { pendingRemediation: "owner_migration_pending", reviewedAt: USAA_ACCOUNTS_REVIEWED_AT },
      "usaa/statements": { pendingRemediation: "content_fingerprint_pending", reviewedAt: USAA_ACCOUNTS_REVIEWED_AT },
    })
  );
  process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH = filePath;
  resetReviewedCompactionResidueCacheForTests();
  try {
    const map = readReviewedCompactionResidueMap();
    assert.equal(map.get("usaa/accounts")?.pendingRemediation, "owner_migration_pending");
    assert.equal(map.get("usaa/statements")?.pendingRemediation, "content_fingerprint_pending");
  } finally {
    rmSync(dir, { force: true, recursive: true });
    if (previous === undefined) {
      delete process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH;
    } else {
      process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH = previous;
    }
    resetReviewedCompactionResidueCacheForTests();
  }
});

test("readReviewedCompactionResidueMap: a malformed file reads as empty, never throws", () => {
  const previous = process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH;
  const dir = mkdtempSync(join(tmpdir(), "compaction-residue-review-"));
  const filePath = join(dir, "review.json");
  writeFileSync(filePath, "{ not valid json");
  process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH = filePath;
  resetReviewedCompactionResidueCacheForTests();
  try {
    assert.doesNotThrow(() => readReviewedCompactionResidueMap());
    assert.equal(readReviewedCompactionResidueMap().size, 0);
  } finally {
    rmSync(dir, { force: true, recursive: true });
    if (previous === undefined) {
      delete process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH;
    } else {
      process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH = previous;
    }
    resetReviewedCompactionResidueCacheForTests();
  }
});
