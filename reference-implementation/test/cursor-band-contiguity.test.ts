// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cursor-band contiguity oracle.
 *
 * The anchor case is the REAL live-instance defect: the Gmail `messages`
 * cursor held `backfill.target_uid: 323723` and `all_mail.forward_uidnext:
 * 324021`, orphaning 297 UIDs (two days of mail) that neither the historical
 * walk nor the forward walk would ever fetch — while every coverage signal
 * still read `covered == considered`, because the connector genuinely did
 * process everything it fetched.
 *
 * The tests below pin four separable behaviors, so a mutation to any one of
 * them reddens on its own:
 *   1. the violation fires, with the exact band size, on the real defect state;
 *   2. the repaired live state (`324020`/`324021`) is contiguous — the
 *      boundary case, which a naive `>` instead of `>=` would fail;
 *   3. silence (never a violation) for undeclared streams, unrecognized
 *      declared shapes, half-written cursors, and mismatched UIDVALIDITY
 *      epochs;
 *   4. the variant table excludes every non-two-pointer shape in the live
 *      fleet, and gmail's manifest still declares the shape that opts its
 *      `messages` stream into the check at all.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CURSOR_BAND_SPECS,
  describeCursorBandViolation,
  evaluateCursorBand,
  findCursorBandSpec,
} from "../runtime/cursor-band-contiguity.ts";

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const BAND_SIZE_RE = /297/;
const CEILING_RE = /323723/;
const RESUME_RE = /324021/;

/** The exact cursor shape read off the live instance at discovery. */
function gmailCursor(args: {
  readonly ceilingEpoch?: number;
  readonly forwardUidnext?: number;
  readonly resumeEpoch?: number;
  readonly targetUid?: number;
}): unknown {
  return {
    all_mail: {
      forward_uidnext: args.forwardUidnext,
      highest_modseq: 12_400_354,
      uidnext: 150_001,
      uidvalidity: args.resumeEpoch ?? 1,
    },
    backfill: {
      backfilled_through_uid: 150_000,
      completed_at: null,
      target_uid: args.targetUid,
      uidvalidity: args.ceilingEpoch ?? 1,
    },
  };
}

test("fires on the real live-instance Gmail defect and names the exact orphaned band", () => {
  // Live values at discovery: target_uid 323723, forward_uidnext 324021.
  const verdict = evaluateCursorBand({
    cursor: gmailCursor({ forwardUidnext: 324_021, targetUid: 323_723 }),
    declaredShape: "imap_uid_band",
  });

  assert.equal(verdict.violated, true, "the 297-UID band must be reported as a proven defect");
  assert.equal(verdict.reason, "violated");
  // UIDs 323724..324020 inclusive belong to neither walk.
  assert.equal(verdict.bandSize, 297, "band size must be exactly the count of unreachable UIDs");
  assert.equal(verdict.ceiling, 323_723);
  assert.equal(verdict.resume, 324_021);

  const described = describeCursorBandViolation({ connectorId: "gmail", stream: "messages", verdict });
  assert.match(described, BAND_SIZE_RE, "the operator message must state the band size");
  assert.match(described, CEILING_RE, "the operator message must state the ceiling");
  assert.match(described, RESUME_RE, "the operator message must state the resume point");
});

test("the repaired live state is contiguous at the exact boundary", () => {
  // The live instance today: target_uid 324020, forward_uidnext 324021.
  // 324020 + 1 >= 324021 holds with zero margin. A `>` instead of `>=`, or an
  // off-by-one in the `+ 1`, turns this correct state into a false positive.
  const verdict = evaluateCursorBand({
    cursor: gmailCursor({ forwardUidnext: 324_021, targetUid: 324_020 }),
    declaredShape: "imap_uid_band",
  });

  assert.equal(verdict.violated, false, "the repaired live cursor must NOT fire");
  assert.equal(verdict.reason, "contiguous");
  assert.equal(verdict.bandSize, 0);
});

test("an overlapping walk (ceiling past the resume point) is contiguous, not a violation", () => {
  const verdict = evaluateCursorBand({
    cursor: gmailCursor({ forwardUidnext: 324_021, targetUid: 400_000 }),
    declaredShape: "imap_uid_band",
  });
  assert.equal(verdict.violated, false, "re-fetching an overlap is wasteful, never a gap");
  assert.equal(verdict.reason, "contiguous");
});

test("a one-identifier band still fires — the smallest provable loss", () => {
  const verdict = evaluateCursorBand({
    cursor: gmailCursor({ forwardUidnext: 324_021, targetUid: 324_019 }),
    declaredShape: "imap_uid_band",
  });
  assert.equal(verdict.violated, true);
  assert.equal(verdict.bandSize, 1, "UID 324020 alone is unreachable");
});

test("mismatched UIDVALIDITY refuses the comparison instead of answering it", () => {
  // RFC 9051 §2.3.1.1: a UIDVALIDITY change invalidates every stored UID, so
  // the two pointers are not points in one ordered space. The arithmetic would
  // "detect" a huge band that is really an identifier-space reset.
  const verdict = evaluateCursorBand({
    cursor: gmailCursor({ ceilingEpoch: 1, forwardUidnext: 324_021, resumeEpoch: 2, targetUid: 323_723 }),
    declaredShape: "imap_uid_band",
  });

  assert.equal(verdict.violated, false, "incomparable epochs must never be reported as a gap");
  assert.equal(verdict.reason, "epoch_mismatch");
});

test("a half-written cursor is silent, never a violation", () => {
  // A backfill that has not yet frozen its ceiling, and a connection whose
  // forward pass has not yet run, are both normal early states. Firing here
  // would cry wolf on every freshly-created Gmail connection.
  const noCeiling = evaluateCursorBand({
    cursor: gmailCursor({ forwardUidnext: 324_021 }),
    declaredShape: "imap_uid_band",
  });
  assert.equal(noCeiling.violated, false);
  assert.equal(noCeiling.reason, "incomplete_cursor");

  const noResume = evaluateCursorBand({
    cursor: gmailCursor({ targetUid: 323_723 }),
    declaredShape: "imap_uid_band",
  });
  assert.equal(noResume.violated, false);
  assert.equal(noResume.reason, "incomplete_cursor");

  for (const cursor of [null, undefined, {}, [], "not-an-object", 42]) {
    const verdict = evaluateCursorBand({ cursor, declaredShape: "imap_uid_band" });
    assert.equal(verdict.violated, false, `malformed cursor ${JSON.stringify(cursor)} must be silent`);
    assert.equal(verdict.reason, "incomplete_cursor");
  }
});

test("a non-integer pointer reads as absent rather than being coerced", () => {
  const verdict = evaluateCursorBand({
    cursor: { all_mail: { forward_uidnext: "324021" }, backfill: { target_uid: 323_723 } },
    declaredShape: "imap_uid_band",
  });
  assert.equal(verdict.violated, false, "a string pointer must not be coerced into arithmetic");
  assert.equal(verdict.reason, "incomplete_cursor");
});

test("streams that declare no band are silent, not healthy and not violated", () => {
  // Every one of these is a real live-instance cursor whose shape cannot
  // express a band, so none of them declares `cursor_shape`. A check that
  // fired on any of them would be worse than no check at all. The cursors are
  // kept verbatim (they are the real persisted shapes) but the check no
  // longer keys on who produced them — an undeclared stream is silent
  // whatever its connector.
  const undeclared: readonly (readonly [string, unknown])[] = [
    // single-watermark — one pointer cannot bracket a band
    ["single-watermark iso8601", { last_update_time: "2026-06-19T20:30:04.127Z" }],
    ["single-watermark pushed_at", { last_pushed_at: "2026-08-18T00:00:00.000Z" }],
    ["single-watermark epoch", { last_created_utc: 1_787_000_000 }],
    // per-partition maps — each partition owns its own space
    ["per-partition years", { years: { 2005: { frozen: false, order_count: 10 } } }],
    ["per-partition accounts", { per_account: { 1212486749: { max_seen_date: "2026-08-17" } } }],
    ["per-partition file mtimes", { file_mtimes: { "/a.jsonl": 1 }, local_jsonl_cursor_version: 1 }],
    ["per-partition channels", { channel_last_ts: { C1: "1.2" }, last_ts: "1.2" }],
    ["per-partition groups", { cursors: { g1: "99" } }],
    // opaque tokens — not ordered, arithmetic undefined
    ["opaque sync token", { "https://example/card": { sync_token: "Hwo..." } }],
    ["opaque server knowledge", { budget_1: { server_knowledge: 4711 } }],
    // a one-sided backfill floor with no ceiling and no forward pointer
    ["one-sided backfill floor", { all_mail: { backfilled_through_uid: 3, uidvalidity: 1 } }],
  ];

  for (const [label, cursor] of undeclared) {
    const verdict = evaluateCursorBand({ cursor, declaredShape: undefined });
    assert.equal(verdict.violated, false, `${label} must not fire`);
    assert.equal(verdict.reason, "not_registered", `${label} must report honest silence`);
  }
});

test("an unrecognized declared shape is silent — a manifest cannot invent a band the RI has not reasoned about", () => {
  // The enum is CLOSED. A manifest declaring something the RI does not
  // implement selects no variant and stays silent; it must never fall back to
  // guessing a shape, and must never be reported as healthy.
  const bandCursor = gmailCursor({ forwardUidnext: 324_021, targetUid: 323_723 });
  for (const bogus of ["imap_uid_band_v2", "made_up_shape", "", 42, null, {}, ["imap_uid_band"]]) {
    const verdict = evaluateCursorBand({ cursor: bandCursor, declaredShape: bogus });
    assert.equal(verdict.violated, false, `${JSON.stringify(bogus)} must not select a variant`);
    assert.equal(verdict.reason, "not_registered", `${JSON.stringify(bogus)} must report honest silence`);
  }
});

test("the variant table stays narrow: only genuine two-pointer-over-one-space shapes", () => {
  // Guards against a future contributor adding a variant for a shape that
  // merely has two numbers in it (e.g. gmail's own uidnext/highest_modseq, or
  // chatgpt's pacing fields), which would fire on correct behavior.
  assert.equal(CURSOR_BAND_SPECS.length, 1, "the IMAP UID band is the only two-pointer shape in the fleet today");

  const spec = findCursorBandSpec("imap_uid_band");
  assert.ok(spec, "the declared imap_uid_band shape must select a variant");
  assert.deepEqual(spec.ceilingPath, ["backfill", "target_uid"]);
  assert.deepEqual(spec.resumePath, ["all_mail", "forward_uidnext"]);
  assert.ok(spec.ceilingEpochPath && spec.resumeEpochPath, "a UID band must be epoch-guarded");

  assert.equal(findCursorBandSpec(undefined), null);
  assert.equal(findCursorBandSpec("not_a_shape"), null);
});

test("gmail's messages stream still declares the shape that opts it into this check", () => {
  // The live-instance defect this module exists for was on gmail.messages.
  // The RI no longer names that stream, so the wiring is only real if the
  // manifest still declares it — this is the drift guard for that, and it
  // reads the manifest as DATA rather than importing connector code.
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "packages/polyfill-connectors/manifests/gmail.json"), "utf8")
  ) as { streams?: { cursor_shape?: unknown; name?: string }[] };
  const messages = (manifest.streams ?? []).find((s) => s.name === "messages");
  assert.ok(messages, "gmail must still declare a messages stream");
  assert.equal(
    messages.cursor_shape,
    "imap_uid_band",
    "gmail.messages must declare cursor_shape, or the contiguity check silently stops running"
  );
  assert.ok(findCursorBandSpec(messages.cursor_shape), "the declared shape must select an RI-owned variant");
});
