/**
 * Unit tests for `formatForwardDisposition` — the console's owner-facing copy
 * for the connection-level forward disposition ("what is the next run expected
 * to do?", `define-connector-progress-evidence-contract`).
 *
 * These pin three things the brief requires:
 *   1. The five reference dispositions map to honest, distinct copy and tone.
 *   2. Absence (reference predating the field) renders nothing, never an
 *      invented disposition; an unrecognized value is surfaced honestly.
 *   3. The copy stays protocol/reference-accurate and connector-agnostic — no
 *      hosted-service promise ("we'll sync"), no connector name baked in.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { formatForwardDisposition } from "./connection-evidence.ts";
import type { RefForwardDisposition } from "./ref-client.ts";

const ALL_DISPOSITIONS: RefForwardDisposition[] = [
  "complete",
  "checking",
  "resumable",
  "awaiting_owner",
  "owner_refresh_due",
  "terminal",
  "unmeasured",
];

// Regexes hoisted to module scope (lint: useTopLevelRegex).
const HOSTED_SERVICE_COPY = /\bwe['’]?ll\b|\bwe sync\b|\bour service\b|\bnightly\b|sign up/i;
const CONNECTOR_NAME_COPY = /\bgmail\b|\bchatgpt\b|\bslack\b|\breddit\b|\bchase\b|\bspotify\b/i;
const NO_OWNER_ACTION_COPY = /no owner action/i;
const CLAIMS_COMPLETE_COPY = /complete|nothing owed/i;
const AGED_NOT_MISSING_COPY = /aged data, not missing data/i;
const MENTIONS_RUN_COPY = /run/i;
const OWNER_ATTENTION_COPY = /owner attention|you act/i;
const RECORDS_STAY_VALID_COPY = /stay valid/i;
const UNRECOGNIZED_COPY = /does not recognize/i;

test("returns null when the reference supplied no disposition", () => {
  assert.equal(formatForwardDisposition(null), null);
  assert.equal(formatForwardDisposition(undefined), null);
});

test("every known disposition maps to a non-empty label, title, and value", () => {
  for (const value of ALL_DISPOSITIONS) {
    const summary = formatForwardDisposition(value);
    assert.ok(summary, `expected a summary for ${value}`);
    assert.equal(summary.value, value);
    assert.ok(summary.label.length > 0, `label for ${value}`);
    assert.ok(summary.title.length > 0, `title for ${value}`);
    assert.ok(["neutral", "success", "warning", "danger"].includes(summary.tone));
  }
});

test("complete is the only success-tone, no-action disposition", () => {
  // `complete` is the single state that says nothing is owed and no run is
  // expected to collect anything. It must be the only green, no-action value so
  // the dashboard never paints an outstanding-gap disposition as resolved.
  for (const value of ALL_DISPOSITIONS) {
    const summary = formatForwardDisposition(value);
    assert.ok(summary);
    if (value === "complete") {
      assert.equal(summary.tone, "success");
      assert.equal(summary.ownerActionNeeded, false);
    } else {
      assert.notEqual(summary.tone, "success", `${value} must not read as success`);
    }
  }
});

test("only the two owner-initiated dispositions flag owner action", () => {
  // `awaiting_owner` (a gap blocked on attention) and `owner_refresh_due` (a
  // complete-but-stale manual-refresh connection) are the only two that require
  // the owner to act; `resumable` and `terminal` do not ask for owner action.
  const needsOwner = ALL_DISPOSITIONS.filter((value) => formatForwardDisposition(value)?.ownerActionNeeded);
  assert.deepEqual(needsOwner.sort(), ["awaiting_owner", "owner_refresh_due"]);
});

test("resumable says collection resumes without owner action and never claims completeness", () => {
  const summary = formatForwardDisposition("resumable");
  assert.ok(summary);
  assert.equal(summary.ownerActionNeeded, false);
  assert.match(summary.title, NO_OWNER_ACTION_COPY);
  // Honesty: a resumable disposition exists precisely because coverage is not
  // established/complete; the copy must not imply it is.
  assert.doesNotMatch(summary.label, CLAIMS_COMPLETE_COPY);
});

test("unmeasured says evidence is absent without claiming active checking", () => {
  const summary = formatForwardDisposition("unmeasured");
  assert.ok(summary);
  assert.equal(summary.ownerActionNeeded, false);
  assert.equal(summary.tone, "neutral");
  assert.match(summary.label, /not measured/i);
  assert.match(summary.title, /not an active checking state/i);
});

test("owner_refresh_due distinguishes aged data from missing data and requires an owner-initiated run", () => {
  const summary = formatForwardDisposition("owner_refresh_due");
  assert.ok(summary);
  assert.equal(summary.ownerActionNeeded, true);
  // Coverage stays complete; this is freshness, not a coverage gap. The copy
  // must keep aged-vs-missing distinct (the manual-refresh seam).
  assert.match(summary.title, AGED_NOT_MISSING_COPY);
  assert.match(summary.title, MENTIONS_RUN_COPY);
});

test("awaiting_owner attributes the block to owner attention, not a service outage", () => {
  const summary = formatForwardDisposition("awaiting_owner");
  assert.ok(summary);
  assert.equal(summary.ownerActionNeeded, true);
  assert.match(summary.title, OWNER_ATTENTION_COPY);
});

test("terminal keeps already-collected records valid and points at the run for detail", () => {
  const summary = formatForwardDisposition("terminal");
  assert.ok(summary);
  assert.equal(summary.tone, "danger");
  assert.match(summary.title, RECORDS_STAY_VALID_COPY);
  assert.match(summary.title, MENTIONS_RUN_COPY);
});

test("an unrecognized disposition is surfaced honestly, not dropped", () => {
  const summary = formatForwardDisposition("future_value_from_a_newer_reference");
  assert.ok(summary);
  assert.equal(summary.tone, "neutral");
  assert.equal(summary.ownerActionNeeded, false);
  assert.match(summary.title, UNRECOGNIZED_COPY);
});

test("no disposition copy promises a hosted sync service or names a connector", () => {
  // Voice-and-framing guardrail: the reference describes what a run on the
  // owner's own instance does. It never offers "we'll sync" hosted-service
  // semantics, and the disposition vocabulary is connector-agnostic.
  for (const value of ALL_DISPOSITIONS) {
    const summary = formatForwardDisposition(value);
    assert.ok(summary);
    const copy = `${summary.label} ${summary.title}`;
    assert.doesNotMatch(copy, HOSTED_SERVICE_COPY, `${value} copy must not promise a hosted service`);
    assert.doesNotMatch(copy, CONNECTOR_NAME_COPY, `${value} copy must stay connector-agnostic`);
  }
});
