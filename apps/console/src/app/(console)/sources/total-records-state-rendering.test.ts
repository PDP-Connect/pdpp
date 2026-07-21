/**
 * A failed/never-observed record snapshot must never render as an
 * authoritative numeric zero or a confident exact count anywhere the
 * console formats `total_records` into owner-facing prose
 * (reconcile-active-summary-evidence design.md "Health boundary", Sol
 * third-verdict P1.3 minimum-closure item 4). Covers both rendering sites
 * this fix touches: the connector detail page's header count, and the
 * sources-list reactivate-confirmation copy.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { formatConnectorHeaderCount, reactivateRecordCopy } from "./sources-view-model.ts";

const COLLECTED_RECORDS_42_RE = /42 collected records are/;

test("formatConnectorHeaderCount: a genuine known count renders as-is (prior-nonzero)", () => {
  const label = formatConnectorHeaderCount({
    pendingOnDevices: 0,
    streamCount: 2,
    totalRecords: 42,
    totalRecordsState: "known",
  });
  assert.equal(label, "42 records · 2 streams");
});

test("formatConnectorHeaderCount: a genuine known_zero count renders '0 records', never 'unavailable' (prior-zero)", () => {
  const label = formatConnectorHeaderCount({
    pendingOnDevices: 0,
    streamCount: 1,
    totalRecords: 0,
    totalRecordsState: "known_zero",
  });
  assert.equal(label, "0 records · 1 stream");
});

test("formatConnectorHeaderCount: a stale carried-over number (prior-nonzero, now failed) renders unverified, not a confident count", () => {
  const label = formatConnectorHeaderCount({
    pendingOnDevices: 0,
    streamCount: 2,
    totalRecords: 42,
    totalRecordsState: "stale",
  });
  assert.equal(label, "42 records (unverified) · 2 streams");
  assert.ok(!label.startsWith("42 records ·"), "must not render the bare confident phrasing for a stale count");
});

test("formatConnectorHeaderCount: a stale carried-over ZERO (prior-zero, now failed) still renders unverified, never an authoritative '0 records'", () => {
  const label = formatConnectorHeaderCount({
    pendingOnDevices: 0,
    streamCount: 1,
    totalRecords: 0,
    totalRecordsState: "stale",
  });
  assert.equal(
    label,
    "0 records (unverified) · 1 stream",
    "the exact failure mode Sol's verdict reproduced: a failed snapshot's carried-over zero must never read as an authoritative known_zero"
  );
});

test("formatConnectorHeaderCount: unobserved/unknown never fabricates a numeric count at all", () => {
  assert.equal(
    formatConnectorHeaderCount({
      pendingOnDevices: 0,
      streamCount: 1,
      totalRecords: 0,
      totalRecordsState: "unobserved",
    }),
    "records unavailable · 1 stream"
  );
  assert.equal(
    formatConnectorHeaderCount({ pendingOnDevices: 0, streamCount: 1, totalRecords: 0, totalRecordsState: "unknown" }),
    "records unavailable · 1 stream"
  );
});

test("formatConnectorHeaderCount: an omitted state (reference predating this field) preserves the exact prior always-numeric rendering", () => {
  const label = formatConnectorHeaderCount({ pendingOnDevices: 0, streamCount: 2, totalRecords: 42 });
  assert.equal(label, "42 records · 2 streams");
});

test("formatConnectorHeaderCount: pending-on-devices suffix still appends after the (unverified) qualifier", () => {
  const label = formatConnectorHeaderCount({
    pendingOnDevices: 5,
    streamCount: 1,
    totalRecords: 10,
    totalRecordsState: "stale",
  });
  assert.equal(label, "10 records (unverified) · 1 stream · +5 pending on devices");
});

test("reactivateRecordCopy: a genuine known-nonzero count names the number", () => {
  const copy = reactivateRecordCopy(42, "known");
  assert.match(copy, COLLECTED_RECORDS_42_RE);
});

test("reactivateRecordCopy: a genuine known_zero count uses the generic fallback (zero is not a countable claim to name)", () => {
  const copy = reactivateRecordCopy(0, "known_zero");
  assert.equal(copy, "collected records are");
});

test("reactivateRecordCopy: a stale carried-over number falls back to generic phrasing, never names an unverified count", () => {
  const copy = reactivateRecordCopy(42, "stale");
  assert.ok(!copy.includes("42 collected"), "must not state a specific number it cannot currently back");
  assert.equal(copy, "collected records are");
});

test("reactivateRecordCopy: an unobserved/unknown state never names a number", () => {
  assert.equal(reactivateRecordCopy(0, "unobserved"), "collected records are");
  assert.equal(reactivateRecordCopy(0, "unknown"), "collected records are");
});

test("reactivateRecordCopy: an omitted state (reference predating this field) preserves the exact prior >0 numeric behavior", () => {
  const copy = reactivateRecordCopy(42, undefined);
  assert.match(copy, COLLECTED_RECORDS_42_RE);
});
