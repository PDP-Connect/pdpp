// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the gmail-delta-blanked-envelope-restore tool.
 *
 * The tool's whole correctness question is which side of a merge wins for
 * each field, so that is what these pin:
 *
 *   - the envelope fields the Gmail delta pass destroyed come from the
 *     last known-good history payload;
 *   - the label/flag fields the delta pass legitimately observed come from
 *     the CURRENT row, so restoring an envelope never rolls back a real
 *     label change (the failure mode that would make this tool worse than
 *     the defect it repairs).
 *
 * Payload-free by construction: the fixtures below are synthetic, and no
 * assertion prints record content.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backupTableName,
  mergeRestoredRecord,
  parseArgs,
  RESTORED_FIELDS,
  sanitizeIdentifierToken,
  truncateId,
  validateArgs,
} from "../scripts/repair/gmail-delta-blanked-envelope-restore.ts";

const UNSAFE_TOKEN_ERROR = /unsafe x/;
const BACKUP_TABLE_PREFIX_PATTERN = /^gdber_backup_[0-9a-f]{8}__/;
const SAFE_IDENTIFIER_PATTERN = /^[a-z0-9_]+$/;

test("mergeRestoredRecord: restores the blanked envelope from history", () => {
  const merged = mergeRestoredRecord({
    current: {
      date: null,
      from_email: null,
      id: "m1",
      labels: ["\\Inbox"],
      received_at: "2026-08-21T03:04:31.579Z",
      size_bytes: null,
      snippet: null,
      subject: null,
    },
    history: {
      date: "2026-04-20T10:00:00.000Z",
      from_email: "sender@example.com",
      id: "m1",
      labels: ["\\Important"],
      received_at: "2026-04-20T10:00:05.000Z",
      size_bytes: 1024,
      snippet: "prior snippet",
      subject: "prior subject",
    },
  });
  assert.equal(merged.subject, "prior subject");
  assert.equal(merged.from_email, "sender@example.com");
  assert.equal(merged.date, "2026-04-20T10:00:00.000Z");
  assert.equal(merged.size_bytes, 1024);
  assert.equal(merged.snippet, "prior snippet");
  assert.equal(
    merged.received_at,
    "2026-04-20T10:00:05.000Z",
    "received_at is restored to the message's own time, not the run clock that overwrote it"
  );
});

test("mergeRestoredRecord: keeps the CURRENT label/flag state, never history's", () => {
  // The delta pass observed these truthfully. Taking them from history would
  // undo the very label change that triggered the blanking.
  const merged = mergeRestoredRecord({
    current: {
      id: "m1",
      is_answered: true,
      is_flagged: true,
      is_seen: true,
      labels: ["\\Inbox", "\\Important"],
      subject: null,
    },
    history: {
      id: "m1",
      is_answered: false,
      is_flagged: false,
      is_seen: false,
      labels: ["\\Inbox"],
      subject: "prior subject",
    },
  });
  assert.deepEqual(merged.labels, ["\\Inbox", "\\Important"], "live labels win");
  assert.equal(merged.is_seen, true, "live \\Seen wins");
  assert.equal(merged.is_flagged, true, "live \\Flagged wins");
  assert.equal(merged.is_answered, true, "live \\Answered wins");
  assert.equal(merged.subject, "prior subject", "and the envelope still comes back");
});

test("mergeRestoredRecord: leaves a field absent from history untouched", () => {
  const merged = mergeRestoredRecord({
    current: { id: "m1", snippet: null, subject: null },
    history: { id: "m1", subject: "prior subject" },
  });
  assert.equal(merged.subject, "prior subject");
  assert.equal(merged.snippet, null, "history had no snippet to give, so nothing is invented");
});

test("RESTORED_FIELDS: covers every field the delta pass nulled, and no flag field", () => {
  for (const field of ["subject", "from_name", "from_email", "date", "received_at", "size_bytes", "snippet"]) {
    assert.ok(RESTORED_FIELDS.includes(field as (typeof RESTORED_FIELDS)[number]), `${field} is restored`);
  }
  for (const field of ["labels", "is_seen", "is_flagged", "is_draft", "is_answered", "id", "thread_id"]) {
    assert.ok(
      !RESTORED_FIELDS.includes(field as (typeof RESTORED_FIELDS)[number]),
      `${field} must NOT be restored from history — the delta pass observed it truthfully`
    );
  }
});

test("parseArgs/validateArgs: apply defaults off and the instance id is required", () => {
  const bare = parseArgs([]);
  assert.equal(bare.apply, false, "writes are opt-in");
  assert.equal(validateArgs(bare), "--connector-instance-id is required");

  const full = parseArgs(["--connector-instance-id=cin_abc", "--apply"]);
  assert.equal(full.apply, true);
  assert.equal(full.connectorInstanceId, "cin_abc");
  assert.equal(validateArgs(full), null);
});

test("backupTableName: stays within Postgres' 63-byte identifier limit", () => {
  const name = backupTableName({
    connectorInstanceId: "cin_12407c1afb78d56848fe0b20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    stamp: "20260821035110",
  });
  assert.ok(name.length <= 63, `identifier fits: ${name.length}`);
  assert.match(name, BACKUP_TABLE_PREFIX_PATTERN);
});

test("sanitizeIdentifierToken: rejects what it cannot make safe to interpolate", () => {
  assert.equal(sanitizeIdentifierToken("cin_ABC-123", "x"), "cin_abc_123");
  assert.throws(() => sanitizeIdentifierToken("", "x"), UNSAFE_TOKEN_ERROR);
  assert.throws(() => sanitizeIdentifierToken("a".repeat(97), "x"), UNSAFE_TOKEN_ERROR, "over-long is rejected");
  // Punctuation maps to underscores rather than being rejected. Underscores
  // are valid identifier characters, so the result is still safe to
  // interpolate — which is the property this function exists to guarantee.
  assert.equal(sanitizeIdentifierToken("!!!", "x"), "___");
  assert.match(
    sanitizeIdentifierToken("drop table x;--", "x"),
    SAFE_IDENTIFIER_PATTERN,
    "no SQL metacharacter survives"
  );
});

test("truncateId: elides a long identifier for payload-free output", () => {
  assert.equal(truncateId("short"), "short");
  assert.equal(truncateId("cin_12407c1afb78d56848fe0b20"), "cin_1240...0b20");
});
