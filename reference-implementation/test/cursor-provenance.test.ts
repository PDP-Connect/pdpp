// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cursor-provenance oracle (inherited / un-earned watermark detection).
 *
 * The anchor case is the REAL live-instance ChatGPT state: connection
 * `cin_484604984db7c091bd08b259` (created 2026-08-17) carries a
 * `conversations` cursor of 2026-06-19T20:30:04.127Z that is byte-identical,
 * to the millisecond, to the paused connection `cin_e4ab231c7d49b8f59e4c80ed`'s
 * cursor. Everything older than that timestamp is permanently unreachable for
 * the newer connection while coverage still reads complete.
 *
 * The most important tests here are the NEGATIVE ones. A provenance check that
 * cries wolf on a legitimately idle or fully-caught-up source is worse than no
 * check, so the suite pins that:
 *   - an idle connection with a months-old, unmoving cursor stays silent;
 *   - a cursor far older than its own connection stays silent on its own —
 *     the real live reddit/notion values that disproved an earlier, unsound
 *     `predates_connection` rule;
 *   - the connection that legitimately EARNED a value later copied by someone
 *     else is not blamed for the copy;
 *   - timestamps 1ms apart are not treated as duplicates;
 *   - identical cursors on the SAME connection across streams are not
 *     "siblings" and stay silent.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type CursorProvenanceFinding,
  type CursorProvenanceInput,
  describeCursorProvenanceFinding,
  evaluateCursorProvenance,
  findWatermarkSpec,
  WATERMARK_SPECS,
} from "../runtime/cursor-provenance.ts";

const BYTE_IDENTICAL_RE = /byte-identical/;
const RESEED_RE = /Re-seed/;

/** The three live ChatGPT connections, exactly as stored. */
const LIVE_CHATGPT: readonly CursorProvenanceInput[] = [
  {
    connectionCreatedAt: "2026-04-19T07:14:36.568Z",
    connectorId: "chatgpt",
    connectorInstanceId: "cin_11deac1e728b244aaeb56765",
    cursor: { last_update_time: "2026-08-19T02:48:52.275Z" },
    stream: "conversations",
  },
  {
    connectionCreatedAt: "2026-06-19T20:07:45.392Z",
    connectorId: "chatgpt",
    connectorInstanceId: "cin_e4ab231c7d49b8f59e4c80ed",
    cursor: { last_update_time: "2026-06-19T20:30:04.127Z" },
    stream: "conversations",
  },
  {
    connectionCreatedAt: "2026-08-17T20:24:58.558Z",
    connectorId: "chatgpt",
    connectorInstanceId: "cin_484604984db7c091bd08b259",
    cursor: { last_update_time: "2026-06-19T20:30:04.127Z" },
    stream: "conversations",
  },
];

function findingFor(findings: readonly CursorProvenanceFinding[], id: string): CursorProvenanceFinding {
  const found = findings.find((finding) => finding.connectorInstanceId === id);
  assert.ok(found, `expected a finding for ${id}`);
  return found;
}

test("fires on the real live-instance ChatGPT inherited cursor", () => {
  const findings = evaluateCursorProvenance(LIVE_CHATGPT);

  const inherited = findingFor(findings, "cin_484604984db7c091bd08b259");
  assert.equal(inherited.suspected, true, "an inherited high-water mark must be flagged");
  assert.equal(inherited.reason, "duplicate_of_sibling");
  assert.equal(inherited.value, "2026-06-19T20:30:04.127Z");
  assert.equal(
    inherited.duplicateOf,
    "cin_e4ab231c7d49b8f59e4c80ed",
    "the finding must name the connection the value was copied from"
  );

  const described = describeCursorProvenanceFinding(inherited);
  assert.match(described, BYTE_IDENTICAL_RE);
  assert.match(described, RESEED_RE, "the operator must be told the remedy");
});

test("the two legitimately-seeded ChatGPT connections are not flagged", () => {
  const findings = evaluateCursorProvenance(LIVE_CHATGPT);

  // The active connection earned its own recent watermark.
  const active = findingFor(findings, "cin_11deac1e728b244aaeb56765");
  assert.equal(active.suspected, false);
  assert.equal(active.reason, "self_earned");

  // The paused archive connection's cursor is ~22 minutes AFTER its own
  // creation — the normal shape of a first run — even though a different
  // connection later copied that value. The source of a copy is not the
  // victim of one.
  const archive = findingFor(findings, "cin_e4ab231c7d49b8f59e4c80ed");
  assert.equal(archive.suspected, false, "the connection that legitimately earned the value must not be blamed");
  assert.equal(archive.reason, "self_earned");
});

test("an idle source with a long-frozen cursor is NOT flagged", () => {
  // The single most important false-positive case: a real account nobody has
  // touched in eight months. Its watermark is ancient and has not moved for
  // many runs — and that is entirely correct behavior. Staleness is
  // deliberately not a signal anywhere in this module.
  const findings = evaluateCursorProvenance([
    {
      connectionCreatedAt: "2025-01-05T00:00:00.000Z",
      connectorId: "notion",
      connectorInstanceId: "cin_idle",
      cursor: { last_edited_time: "2025-01-06T12:00:00.000Z" },
      stream: "pages",
    },
  ]);

  const idle = findingFor(findings, "cin_idle");
  assert.equal(idle.suspected, false, "an idle source must never be reported as an inherited cursor");
  assert.equal(idle.reason, "self_earned");
});

test("a lone cursor predating its own connection is NOT a finding", () => {
  // The rejected rule, pinned as a regression guard. These are the REAL live
  // values that disproved it: a reddit connection created 2026-04-25 whose
  // `submitted` watermark is 1712055174 (2024-04-02), and a notion connection
  // created 2026-08-12 whose `databases` watermark is 2026-07-01.
  //
  // Both are correct. These watermarks hold the newest CONTENT ITEM's
  // timestamp, not an observation time, so a fully-walked dormant account
  // legitimately stores a watermark far older than the connection itself.
  // Flagging them would fire on connections that did everything right.
  const findings = evaluateCursorProvenance([
    {
      connectionCreatedAt: "2026-04-25T01:17:54.916Z",
      connectorId: "reddit",
      connectorInstanceId: "cin_0a20c407b399742b08575c64",
      cursor: { last_created_utc: 1_712_055_174 },
      stream: "submitted",
    },
    {
      connectionCreatedAt: "2026-08-12T13:38:20.420Z",
      connectorId: "notion",
      connectorInstanceId: "cin_9897ca6d35687352f1e6fa4c",
      cursor: { last_edited_time: "2026-07-01T01:54:00.000Z" },
      stream: "databases",
    },
  ]);

  for (const finding of findings) {
    assert.equal(
      finding.suspected,
      false,
      `${finding.connectorId}.${finding.stream}: an old content watermark alone is not evidence of inheritance`
    );
    assert.equal(finding.reason, "self_earned");
  }
});

test("a duplicate sibling cursor is caught even when it postdates creation", () => {
  // The inheritance fingerprint without the predates-creation signal: two
  // different connections, both created before the shared timestamp, holding a
  // byte-identical millisecond-resolution watermark. An independent walk of two
  // different accounts does not land on the same millisecond.
  const findings = evaluateCursorProvenance([
    {
      connectionCreatedAt: "2026-01-01T00:00:00.000Z",
      connectorId: "chatgpt",
      connectorInstanceId: "cin_origin",
      cursor: { last_update_time: "2026-07-01T09:15:22.481Z" },
      stream: "messages",
    },
    {
      connectionCreatedAt: "2026-02-01T00:00:00.000Z",
      connectorId: "chatgpt",
      connectorInstanceId: "cin_copy",
      cursor: { last_update_time: "2026-07-01T09:15:22.481Z" },
      stream: "messages",
    },
  ]);

  // Both are reported: from the stored evidence alone we cannot tell which
  // connection earned the value and which copied it, and guessing would blame
  // the wrong one.
  const copy = findingFor(findings, "cin_copy");
  assert.equal(copy.reason, "duplicate_of_sibling");
  assert.equal(copy.suspected, true);
  assert.equal(copy.duplicateOf, "cin_origin", "the finding must name the sibling it duplicates");

  assert.match(describeCursorProvenanceFinding(copy), BYTE_IDENTICAL_RE);
});

test("near-miss timestamps are not treated as duplicates", () => {
  // Two connections one millisecond apart are two independent walks, not a
  // copy. The rule requires exact equality precisely so proximity never
  // manufactures a finding.
  const findings = evaluateCursorProvenance([
    {
      connectionCreatedAt: "2026-01-01T00:00:00.000Z",
      connectorId: "chatgpt",
      connectorInstanceId: "cin_a",
      cursor: { last_update_time: "2026-07-01T09:15:22.481Z" },
      stream: "messages",
    },
    {
      connectionCreatedAt: "2026-01-01T00:00:00.000Z",
      connectorId: "chatgpt",
      connectorInstanceId: "cin_b",
      cursor: { last_update_time: "2026-07-01T09:15:22.482Z" },
      stream: "messages",
    },
  ]);

  for (const id of ["cin_a", "cin_b"]) {
    assert.equal(findingFor(findings, id).suspected, false, `${id} must not be flagged on a 1ms difference`);
  }
});

test("cursors are only compared within the same connector and stream", () => {
  // The same connection holding the same watermark on two streams is normal
  // (ChatGPT's `conversations` and `messages` share one walk), and two
  // different connectors coinciding is meaningless. Neither is a sibling copy.
  const findings = evaluateCursorProvenance([
    {
      connectionCreatedAt: "2026-01-01T00:00:00.000Z",
      connectorId: "chatgpt",
      connectorInstanceId: "cin_same",
      cursor: { last_update_time: "2026-07-01T09:15:22.481Z" },
      stream: "conversations",
    },
    {
      connectionCreatedAt: "2026-01-01T00:00:00.000Z",
      connectorId: "chatgpt",
      connectorInstanceId: "cin_same",
      cursor: { last_update_time: "2026-07-01T09:15:22.481Z" },
      stream: "messages",
    },
  ]);

  for (const finding of findings) {
    assert.equal(finding.suspected, false, "one connection's own two streams are not siblings");
  }
});

test("unregistered and unreadable cursors stay silent", () => {
  const findings = evaluateCursorProvenance([
    // A fingerprint map bounds no fetch and cannot strand history.
    {
      connectionCreatedAt: "2026-01-01T00:00:00.000Z",
      connectorId: "chatgpt",
      connectorInstanceId: "cin_fp",
      cursor: { fetched_at: "2026-08-19T16:25:09.710Z", fingerprints: { a: "b" } },
      stream: "shared_conversations",
    },
    // An opaque CardDAV sync-token is not a timestamp; equality is meaningless.
    {
      connectionCreatedAt: "2026-01-01T00:00:00.000Z",
      connectorId: "apple_contacts",
      connectorInstanceId: "cin_ct",
      cursor: { "https://example/card": { sync_token: "HwoQEgwAABJ" } },
      stream: "contacts",
    },
    // Registered stream, malformed value.
    {
      connectionCreatedAt: "2026-01-01T00:00:00.000Z",
      connectorId: "chatgpt",
      connectorInstanceId: "cin_bad",
      cursor: { last_update_time: "not-a-date" },
      stream: "messages",
    },
  ]);

  assert.equal(findingFor(findings, "cin_fp").reason, "not_registered");
  assert.equal(findingFor(findings, "cin_ct").reason, "not_registered");
  assert.equal(findingFor(findings, "cin_bad").reason, "unreadable");
  for (const finding of findings) {
    assert.equal(finding.suspected, false, "silence must never be reported as a finding");
  }
});

test("the watermark registry covers only single ordered watermarks", () => {
  // Guards the scope boundary: registering a per-partition map or an opaque
  // token here would compare values that are legitimately equal across
  // connections and fire on correct behavior.
  assert.ok(findWatermarkSpec("chatgpt", "conversations"), "the defect's own stream must be registered");
  assert.equal(findWatermarkSpec("apple_contacts", "contacts"), null, "opaque sync-tokens are out of scope");
  assert.equal(findWatermarkSpec("amazon", "orders"), null, "per-partition year maps are out of scope");
  assert.equal(findWatermarkSpec("chase", "transactions"), null, "per-account maps are out of scope");
  assert.equal(findWatermarkSpec("slack", "messages"), null, "per-channel maps are out of scope");
  assert.equal(findWatermarkSpec("gmail", "messages"), null, "UID bands are check #1's job, not this one");

  for (const spec of WATERMARK_SPECS) {
    assert.equal(spec.path.length, 1, `${spec.connectorId}.${spec.stream} must be a top-level watermark`);
  }
});
