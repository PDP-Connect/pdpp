// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the all-stream current-projection drift scanner classifier.
 *
 * The scanner (scripts/repair/record-current-projection-scan-all.ts) is the
 * read-only, payload-free, all-stream complement to the per-scope repair tool.
 * Its DB-backed scan needs a live Postgres, but its decision logic is a pure
 * function — these tests pin every one of the seven drift classes (plus the
 * consistent cases) so the taxonomy the remediation policy depends on is
 * falsifiable without a database.
 *
 * The classifier is deliberately finer than the repair tool's classifyMismatch:
 * it splits "current outran retained history" into no-history vs newer-than,
 * and "version differs" into payload-equal (safe version correction) vs
 * payload-differs (needs source resync). Those splits are exactly what the
 * remediation plan keys off.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyScanDrift,
  emptyCounts,
  REMEDIATION_BY_KIND,
  SCAN_DRIFT_KINDS,
  type ScanDriftHistory,
  truncateId,
} from "../scripts/repair/record-current-projection-scan-all.ts";

const K = SCAN_DRIFT_KINDS;

// history shorthand
function hist({
  hasRetained = true,
  latestVersion = 3,
  latestDeleted = false,
  jsonEqual = true,
}: {
  hasRetained?: boolean;
  jsonEqual?: boolean;
  latestDeleted?: boolean;
  latestVersion?: number | null;
} = {}): ScanDriftHistory {
  return { hasRetained, jsonEqualToCurrent: jsonEqual, latestDeleted, latestVersion };
}

test("consistent: live current matches latest live history at same version + payload", () => {
  assert.equal(classifyScanDrift(hist({ jsonEqual: true, latestVersion: 3 }), { deleted: false, version: 3 }), null);
});

test("consistent: deleted latest with no live current row", () => {
  assert.equal(classifyScanDrift(hist({ latestDeleted: true }), null), null);
  assert.equal(classifyScanDrift(hist({ latestDeleted: true }), { deleted: true, version: 3 }), null);
});

test("consistent: no history and no current row is not drift", () => {
  assert.equal(classifyScanDrift(hist({ hasRetained: false, latestVersion: null }), null), null);
});

test("missing_current: non-deleted latest history but no usable current row", () => {
  assert.equal(classifyScanDrift(hist({ latestDeleted: false, latestVersion: 3 }), null), K.MISSING_CURRENT);
  assert.equal(
    classifyScanDrift(hist({ latestDeleted: false, latestVersion: 3 }), { deleted: true, version: 3 }),
    K.MISSING_CURRENT
  );
});

test("latest_deleted: deleted latest history but a live current row survives", () => {
  assert.equal(
    classifyScanDrift(hist({ latestDeleted: true, latestVersion: 5 }), { deleted: false, version: 5 }),
    K.LATEST_DELETED
  );
});

test("current_no_retained_history: live current with zero retained history", () => {
  assert.equal(
    classifyScanDrift(hist({ hasRetained: false, latestVersion: null }), { deleted: false, version: 7 }),
    K.CURRENT_NO_RETAINED_HISTORY
  );
});

test("current_version_newer_than_retained_history: current beyond the retained tail", () => {
  assert.equal(
    classifyScanDrift(hist({ jsonEqual: false, latestVersion: 2 }), { deleted: false, version: 9 }),
    K.CURRENT_VERSION_NEWER_THAN_RETAINED_HISTORY
  );
  // Precedence: "newer than retained" is decided even if latest is deleted.
  assert.equal(
    classifyScanDrift(hist({ latestDeleted: true, latestVersion: 2 }), { deleted: false, version: 9 }),
    K.CURRENT_VERSION_NEWER_THAN_RETAINED_HISTORY
  );
});

test("current_payload_matches_latest_history_but_version_differs: safe version correction", () => {
  // current behind a newer retained version, but payload is byte-equal.
  assert.equal(
    classifyScanDrift(hist({ jsonEqual: true, latestDeleted: false, latestVersion: 8 }), {
      deleted: false,
      version: 5,
    }),
    K.CURRENT_PAYLOAD_MATCHES_LATEST_HISTORY_BUT_VERSION_DIFFERS
  );
});

test("unverified_current_payload_differs_from_latest_history: needs resync", () => {
  assert.equal(
    classifyScanDrift(hist({ jsonEqual: false, latestDeleted: false, latestVersion: 8 }), {
      deleted: false,
      version: 5,
    }),
    K.UNVERIFIED_CURRENT_PAYLOAD_DIFFERS_FROM_LATEST_HISTORY
  );
});

test("stale_current: same version, payload disagrees", () => {
  assert.equal(
    classifyScanDrift(hist({ jsonEqual: false, latestDeleted: false, latestVersion: 4 }), {
      deleted: false,
      version: 4,
    }),
    K.STALE_CURRENT
  );
});

test("every drift kind has a remediation disposition", () => {
  for (const kind of Object.values(SCAN_DRIFT_KINDS)) {
    assert.ok(REMEDIATION_BY_KIND[kind], `missing remediation for ${kind}`);
  }
});

test("remediation dispositions encode the safe/unsafe split", () => {
  // The two payload-provable classes get non-resync remediations.
  assert.equal(
    REMEDIATION_BY_KIND[K.CURRENT_PAYLOAD_MATCHES_LATEST_HISTORY_BUT_VERSION_DIFFERS],
    "safe_current_version_correction"
  );
  assert.equal(REMEDIATION_BY_KIND[K.MISSING_CURRENT], "repairable_from_latest_retained_history");
  // The unprovable classes require resync / owner-gated synthetic anchors.
  assert.equal(REMEDIATION_BY_KIND[K.UNVERIFIED_CURRENT_PAYLOAD_DIFFERS_FROM_LATEST_HISTORY], "source_resync_required");
  assert.equal(
    REMEDIATION_BY_KIND[K.CURRENT_VERSION_NEWER_THAN_RETAINED_HISTORY],
    "source_resync_or_owner_gated_synthetic_anchor"
  );
  assert.equal(REMEDIATION_BY_KIND[K.CURRENT_NO_RETAINED_HISTORY], "source_resync_or_owner_gated_synthetic_anchor");
});

test("emptyCounts seeds every kind at zero", () => {
  const c = emptyCounts();
  assert.equal(Object.keys(c).length, Object.values(SCAN_DRIFT_KINDS).length);
  for (const kind of Object.values(SCAN_DRIFT_KINDS)) {
    assert.equal(c[kind], 0);
  }
});

test("truncateId elides long identifiers but preserves short ones", () => {
  assert.equal(truncateId("short"), "short");
  assert.equal(truncateId("cin_0123456789abcdef0123"), "cin_0123…0123");
});
