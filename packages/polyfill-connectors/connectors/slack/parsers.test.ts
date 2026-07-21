// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildCanvasRecord,
  buildChannelCanvasIndex,
  buildChannelMembershipRecord,
  buildChannelRecord,
  buildChannelStatsRecord,
  buildDmReadStateRecord,
  buildFileRecord,
  buildMessageAttachmentRecords,
  buildMessageRecord,
  buildReactionRecords,
  buildReminderRecord,
  buildStarRecord,
  buildUserGroupRecord,
  buildUserRecord,
  buildWorkspaceRecord,
  epochToIso,
  extractMessageTimeRange,
  parseBlob,
  parseMessageRow,
  selectCommittedMaxTs,
  toSlackTime,
  tsToIso,
} from "./parsers.ts";
import { dmReadStatesSchema, remindersSchema, starsSchema, userGroupsSchema } from "./schemas.ts";
import type { CanvasRow, ChannelRow, MessageRow } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "__fixtures__");

function readFixture(rel: string): string {
  return readFileSync(join(FIXTURE_DIR, rel), "utf8");
}

// ─── Blob / time helpers ──────────────────────────────────────────────

test("parseBlob: returns empty object for null / empty / garbage", () => {
  assert.deepEqual(parseBlob(null), {});
  assert.deepEqual(parseBlob(undefined), {});
  assert.deepEqual(parseBlob(""), {});
  assert.deepEqual(parseBlob("{not json"), {});
});

test("parseBlob: decodes Uint8Array payload", () => {
  const bytes = new TextEncoder().encode('{"user":"U1","team":"T2"}');
  assert.deepEqual(parseBlob(bytes), { user: "U1", team: "T2" });
});

test("parseBlob: string payload parses identically", () => {
  assert.deepEqual(parseBlob('{"x":1}'), { x: 1 });
});

test("tsToIso: Slack ts 'seconds.micros' → ISO, null for missing", () => {
  assert.equal(tsToIso("1700000000.000000"), new Date(1_700_000_000 * 1000).toISOString());
  assert.equal(tsToIso(null), null);
  assert.equal(tsToIso(undefined), null);
});

test("epochToIso: only finite seconds produce an ISO string", () => {
  assert.equal(epochToIso(1_700_000_000), new Date(1_700_000_000 * 1000).toISOString());
  assert.equal(epochToIso(null), null);
  assert.equal(epochToIso(Number.NaN), null);
});

test("toSlackTime: strips fractional seconds + trailing Z", () => {
  assert.equal(toSlackTime("2024-01-02T03:04:05.123Z"), "2024-01-02T03:04:05");
  assert.equal(toSlackTime("2024-01-02T03:04:05Z"), "2024-01-02T03:04:05");
  assert.equal(toSlackTime(null), null);
});

// ─── Record builders ───────────────────────────────────────────────────

test("buildWorkspaceRecord: prefers row TEAM_ID, then blob, then stringified ID", () => {
  const rec = buildWorkspaceRecord(
    {
      ID: 7,
      TEAM: "Eng",
      TEAM_ID: null,
      USERNAME: "alice",
      USER_ID: "U1",
      URL: "https://eng.slack.com/",
      ENTERPRISE_ID: null,
      DATA: '{"team_id":"Tblob","bot_id":"B1","domain":"eng","icon":{"image_230":"i230.png"}}',
    },
    "2026-04-22T10:00:00.000Z"
  );
  assert.equal(rec.id, "Tblob");
  assert.equal(rec.domain, "eng");
  assert.equal(rec.icon_url, "i230.png");
  assert.equal(rec.authenticated_bot_id, "B1");
  assert.equal(rec.fetched_at, "2026-04-22T10:00:00.000Z");
});

test("buildChannelRecord: flattens topic/purpose + canvas/restriction flags from fixture (no num_members)", () => {
  const data = readFixture("channel-with-canvas.json");
  const row: ChannelRow = { id: "C100", name: "engineering", data };
  const rec = buildChannelRecord(row);
  assert.equal(rec.id, "C100");
  assert.equal(rec.name, "engineering");
  assert.equal(rec.is_general, true);
  assert.equal(rec.topic, "deploys on green");
  assert.equal(rec.topic_creator, "U123");
  // num_members must NOT appear on the entity record (moved to channel_stats).
  assert.equal("num_members" in rec, false);
  assert.equal(rec.has_canvas, true);
  assert.equal(rec.canvas_file_id, "Fcanvas1");
  assert.equal(rec.posting_restricted, true);
  assert.equal(rec.threads_restricted, false);
  assert.deepEqual(rec.shared_team_ids, ["T456"]);
});

// ─── buildChannelStatsRecord ──────────────────────────────────────────────

test("buildChannelStatsRecord: key is {channel_id}:{observed_on}", () => {
  const data = readFixture("channel-with-canvas.json");
  const row: ChannelRow = { id: "C100", name: "engineering", data };
  const rec = buildChannelStatsRecord(row, "2026-06-03");
  assert.equal(rec.id, "C100:2026-06-03");
  assert.equal(rec.channel_id, "C100");
  assert.equal(rec.observed_on, "2026-06-03");
});

test("buildChannelStatsRecord: carries num_members from blob", () => {
  const data = readFixture("channel-with-canvas.json");
  const row: ChannelRow = { id: "C100", name: "engineering", data };
  const rec = buildChannelStatsRecord(row, "2026-06-03");
  assert.equal(rec.num_members, 42);
});

test("buildChannelStatsRecord: same-day key is stable (idempotent)", () => {
  const data = readFixture("channel-with-canvas.json");
  const row: ChannelRow = { id: "C100", name: "engineering", data };
  const r1 = buildChannelStatsRecord(row, "2026-06-03");
  const r2 = buildChannelStatsRecord(row, "2026-06-03");
  assert.equal(r1.id, r2.id);
});

test("buildChannelStatsRecord: different-day key is distinct", () => {
  const data = readFixture("channel-with-canvas.json");
  const row: ChannelRow = { id: "C100", name: "engineering", data };
  const r1 = buildChannelStatsRecord(row, "2026-06-03");
  const r2 = buildChannelStatsRecord(row, "2026-06-04");
  assert.notEqual(r1.id, r2.id);
});

test("buildChannelStatsRecord: null blob → num_members null", () => {
  const row: ChannelRow = { id: "C200", name: "empty", data: null };
  const rec = buildChannelStatsRecord(row, "2026-06-03");
  assert.equal(rec.num_members, null);
});

test("buildChannelMembershipRecord: composite id is channel:user", () => {
  const rec = buildChannelMembershipRecord({ CHANNEL_ID: "C1", USER_ID: "U1" }, "2026-04-22T10:00:00.000Z");
  assert.equal(rec.id, "C1:U1");
  assert.equal(rec.channel_id, "C1");
  assert.equal(rec.user_id, "U1");
  assert.equal(rec.fetched_at, "2026-04-22T10:00:00.000Z");
});

test("buildUserRecord: flattens profile + role flags from fixture", () => {
  const data = readFixture("user-profile.json");
  const rec = buildUserRecord({ id: "U1", username: "alice", data });
  assert.equal(rec.id, "U1");
  assert.equal(rec.name, "alice");
  assert.equal(rec.real_name, "Alice Example");
  assert.equal(rec.email, "alice@example.com");
  assert.equal(rec.image_192_url, "https://cdn/192.png");
  assert.equal(rec.is_admin, true);
  assert.equal(rec.is_bot, false);
  assert.equal(rec.enterprise_id, "E789");
  assert.equal(rec.tz_offset, -18_000);
});

// ─── Message record + reactions + attachments ──────────────────────────

function messageRowFromFixture(): MessageRow {
  return {
    CHANNEL_ID: "C1",
    TS: "1714000000.000100",
    THREAD_TS: "1713999999.000000",
    IS_PARENT: 1,
    TXT: "hello world",
    NUM_FILES: 1,
    DATA: readFixture("message-with-reactions.json"),
  };
}

test("parseMessageRow: populates sentAt from ts, falls back on missing ts", () => {
  const parsed = parseMessageRow(messageRowFromFixture(), "2026-04-22T00:00:00.000Z");
  assert.equal(parsed.channelId, "C1");
  assert.equal(parsed.messageId, "C1:1714000000.000100");
  assert.ok(parsed.sentAt.startsWith("2024-"));
  assert.equal(parsed.attachments.length, 2);

  const noTs = { ...messageRowFromFixture(), TS: "" };
  const parsedNoTs = parseMessageRow(noTs, "2026-04-22T00:00:00.000Z");
  assert.equal(parsedNoTs.sentAt, "2026-04-22T00:00:00.000Z");
});

test("buildMessageRecord: pulls counts + thread + reactions from blob", () => {
  const parsed = parseMessageRow(messageRowFromFixture(), "2026-04-22T00:00:00.000Z");
  const rec = buildMessageRecord(parsed);
  assert.equal(rec.id, "C1:1714000000.000100");
  assert.equal(rec.channel_id, "C1");
  assert.equal(rec.user_id, "U123");
  assert.equal(rec.client_msg_id, "abc-def");
  assert.equal(rec.thread_ts, "1713999999.000000");
  assert.equal(rec.is_thread_parent, true);
  assert.equal(rec.reply_count, 2);
  assert.deepEqual(rec.reply_user_ids, ["U789", "UAAA"]);
  assert.equal(rec.text, "hello world");
  assert.equal(rec.has_files, true);
  assert.equal(rec.has_attachments, true);
  assert.equal(rec.attachment_count, 2);
  assert.equal(rec.has_blocks, true);
  // two emoji reactions: tada (count=2) + eyes (users=[U3] ⇒ 1) = 3
  assert.equal(rec.reaction_count, 3);
  assert.equal(rec.is_pinned, true);
  assert.deepEqual(rec.pinned_to, ["C1"]);
  assert.equal(rec.metadata_event_type, "app_posted");
  assert.equal(rec.edited_ts, "1713999991.000000");
});

test("buildReactionRecords: expands (emoji, user) into per-user rows", () => {
  const parsed = parseMessageRow(messageRowFromFixture(), "2026-04-22T00:00:00.000Z");
  const recs = buildReactionRecords(parsed);
  assert.equal(recs.length, 3);
  assert.equal(recs[0]?.id, "C1:1714000000.000100:tada:U1");
  assert.equal(recs[2]?.emoji, "eyes");
  assert.equal(recs[2]?.user_id, "U3");
});

test("buildReactionRecords: no reactions key → empty list", () => {
  const row: MessageRow = {
    CHANNEL_ID: "C1",
    TS: "1714000000.000100",
    THREAD_TS: null,
    IS_PARENT: 0,
    TXT: "hey",
    NUM_FILES: null,
    DATA: '{"user":"U1"}',
  };
  const parsed = parseMessageRow(row, "2026-04-22T00:00:00.000Z");
  assert.deepEqual(buildReactionRecords(parsed), []);
});

test("buildMessageAttachmentRecords: one per attachment, id ordered by index", () => {
  const parsed = parseMessageRow(messageRowFromFixture(), "2026-04-22T00:00:00.000Z");
  const recs = buildMessageAttachmentRecords(parsed);
  assert.equal(recs.length, 2);
  assert.equal(recs[0]?.id, "C1:1714000000.000100:att:0");
  assert.equal(recs[0]?.fallback, "fb1");
  assert.equal(recs[0]?.service_name, "SN");
  assert.equal(recs[0]?.from_url, "https://ex/1");
  assert.equal(recs[1]?.id, "C1:1714000000.000100:att:1");
  assert.equal(recs[1]?.fallback, "fb2");
  assert.equal(recs[1]?.title, "t2");
});

// ─── File + canvas + channel-canvas index ──────────────────────────────

test("buildFileRecord: flattens core file metadata", () => {
  const rec = buildFileRecord({
    id: "F1",
    filename: "a.pdf",
    url: "https://files.slack.com/a.pdf",
    mode: "hosted",
    data: '{"mimetype":"application/pdf","size":1234,"created":1700000000,"user":"U1","is_public":true}',
  });
  assert.equal(rec.id, "F1");
  assert.equal(rec.mimetype, "application/pdf");
  assert.equal(rec.size, 1234);
  assert.equal(rec.uploader_id, "U1");
  assert.equal(rec.is_public, true);
  assert.equal(rec.mode, "hosted");
  assert.equal(rec.url_private, "https://files.slack.com/a.pdf");
});

test("buildChannelCanvasIndex: indexed by canvas file_id, skips channels without canvas", () => {
  const rows: ChannelRow[] = [
    { id: "C1", name: "has", data: readFixture("channel-with-canvas.json") },
    { id: "C2", name: "no-canvas", data: '{"is_channel":true}' },
  ];
  const idx = buildChannelCanvasIndex(rows);
  assert.equal(idx.size, 1);
  const meta = idx.get("Fcanvas1");
  assert.equal(meta?.channel_id, "C1");
  assert.equal(meta?.is_empty, false);
  assert.equal(meta?.quip_thread_id, "Qthread123");
});

test("buildCanvasRecord: overlays channel-canvas-index metadata onto file row", () => {
  const chanRows: ChannelRow[] = [{ id: "C1", name: "eng", data: readFixture("channel-with-canvas.json") }];
  const idx = buildChannelCanvasIndex(chanRows);
  const canvas: CanvasRow = {
    id: "Fcanvas1",
    filename: "spec.canvas",
    url: "https://files.slack.com/Fcanvas1",
    mode: "quip",
    data: '{"title":"Spec","mimetype":"application/vnd.slack-docs","size":9876,"created":1700000000,"user":"U99"}',
    channel_id: null,
    message_id: 42,
  };
  const rec = buildCanvasRecord(canvas, idx);
  assert.equal(rec.id, "Fcanvas1");
  assert.equal(rec.channel_id, "C1");
  assert.equal(rec.message_id, "42");
  assert.equal(rec.title, "Spec");
  assert.equal(rec.is_empty, false);
  assert.equal(rec.quip_thread_id, "Qthread123");
  assert.equal(rec.content_markdown, null);
});

// ─── Cursor + time-range helpers ──────────────────────────────────────

test("selectCommittedMaxTs: table-driven", () => {
  const cases: Array<{ prior: string | null; run: string | null; want: string | null }> = [
    { prior: null, run: null, want: null },
    { prior: null, run: "1714000000.000100", want: "1714000000.000100" },
    { prior: "1700000000.000000", run: null, want: "1700000000.000000" },
    { prior: "1700000000.000000", run: "1714000000.000100", want: "1714000000.000100" },
    { prior: "1714000000.000100", run: "1700000000.000000", want: "1714000000.000100" },
  ];
  for (const c of cases) {
    assert.equal(selectCommittedMaxTs(c.prior, c.run), c.want, `prior=${c.prior} run=${c.run}`);
  }
});

test("extractMessageTimeRange: missing scope → both null; present → passthrough", () => {
  assert.deepEqual(extractMessageTimeRange(undefined), { timeFrom: null, timeTo: null });
  assert.deepEqual(extractMessageTimeRange({}), { timeFrom: null, timeTo: null });
  assert.deepEqual(extractMessageTimeRange({ from: "2024-01-01T00:00:00", to: "2024-12-31T23:59:59" }), {
    timeFrom: "2024-01-01T00:00:00",
    timeTo: "2024-12-31T23:59:59",
  });
});

// ─── Direct Slack Web API record builders ──────────────────────────────

test("buildStarRecord: message star builds a stable composite id and passes schema validation", () => {
  const rec = buildStarRecord({
    type: "message",
    channel: "C01",
    message: { ts: "1714032849.123456", user: "U01" },
    date_create: 1_714_032_900,
  });
  assert.equal(rec.id, "message:C01:1714032849.123456");
  assert.equal(rec.item_type, "message");
  assert.equal(rec.channel_id, "C01");
  assert.equal(rec.message_ts, "1714032849.123456");
  assert.equal(rec.target_id, "1714032849.123456");
  assert.equal(rec.user_id, "U01");
  assert.equal(rec.starred_at, epochToIso(1_714_032_900));
  assert.doesNotThrow(() => starsSchema.parse(rec));
});

test("buildStarRecord: file star uses the file id as target_id", () => {
  const rec = buildStarRecord({ type: "file", channel: "C01", file: { id: "F01" }, date_create: 1_700_000_000 });
  assert.equal(rec.file_id, "F01");
  assert.equal(rec.target_id, "F01");
  assert.doesNotThrow(() => starsSchema.parse(rec));
});

test("buildStarRecord: same input produces the same id across runs (idempotent)", () => {
  const item = { type: "message", channel: "C01", message: { ts: "1.1", user: "U01" }, date_create: 1 };
  assert.equal(buildStarRecord(item).id, buildStarRecord(item).id);
});

test("buildUserGroupRecord: active group maps deleted=false and passes schema validation", () => {
  const rec = buildUserGroupRecord({
    id: "S01",
    handle: "eng",
    name: "Engineering",
    description: "Engineering team",
    users: ["U01", "U02"],
    prefs: { channels: ["C01"] },
    date_create: 1_700_000_000,
    date_update: 1_710_000_000,
    date_delete: 0,
  });
  assert.equal(rec.id, "S01");
  assert.deepEqual(rec.member_ids, ["U01", "U02"]);
  assert.deepEqual(rec.channel_ids, ["C01"]);
  assert.equal(rec.deleted, false);
  assert.doesNotThrow(() => userGroupsSchema.parse(rec));
});

test("buildUserGroupRecord: date_delete > 0 maps deleted=true", () => {
  const rec = buildUserGroupRecord({ id: "S02", date_delete: 1_710_000_001 });
  assert.equal(rec.deleted, true);
  assert.doesNotThrow(() => userGroupsSchema.parse(rec));
});

test("buildUserGroupRecord: missing optional fields fall back to null and still validate", () => {
  const rec = buildUserGroupRecord({ id: "S03" });
  assert.equal(rec.member_ids, null);
  assert.equal(rec.channel_ids, null);
  assert.equal(rec.deleted, null);
  assert.doesNotThrow(() => userGroupsSchema.parse(rec));
});

test("buildReminderRecord: incomplete reminder has null completed_at, passes schema validation", () => {
  const rec = buildReminderRecord({ id: "Rm01", creator: "U01", user: "U01", text: "ping bob", time: 1_714_032_900 });
  assert.equal(rec.scheduled_at, epochToIso(1_714_032_900));
  assert.equal(rec.complete_ts, null);
  assert.equal(rec.completed_at, null);
  assert.doesNotThrow(() => remindersSchema.parse(rec));
});

test("buildReminderRecord: complete_ts=0 is treated as not completed (falsy)", () => {
  const rec = buildReminderRecord({ id: "Rm02", complete_ts: 0 });
  assert.equal(rec.completed_at, null);
  assert.doesNotThrow(() => remindersSchema.parse(rec));
});

test("buildReminderRecord: completed reminder derives completed_at from complete_ts", () => {
  const rec = buildReminderRecord({ id: "Rm03", complete_ts: 1_710_000_500 });
  assert.equal(rec.completed_at, epochToIso(1_710_000_500));
  assert.doesNotThrow(() => remindersSchema.parse(rec));
});

test("buildDmReadStateRecord: converts Slack ts last_read to ISO and passes schema validation", () => {
  const rec = buildDmReadStateRecord(
    { channelId: "D01", lastRead: "1714032849.123456", unreadCount: 2, unreadCountDisplay: 1 },
    "2026-07-10T00:00:00.000Z"
  );
  assert.equal(rec.id, "D01");
  assert.equal(rec.channel_id, "D01");
  assert.equal(rec.last_read, tsToIso("1714032849.123456"));
  assert.equal(rec.last_read_at, rec.last_read);
  assert.equal(rec.unread_count, 2);
  assert.equal(rec.fetched_at, "2026-07-10T00:00:00.000Z");
  assert.doesNotThrow(() => dmReadStatesSchema.parse(rec));
});

test("buildDmReadStateRecord: null last_read (never-read DM) stays null, still validates", () => {
  const rec = buildDmReadStateRecord(
    { channelId: "D02", lastRead: null, unreadCount: 0, unreadCountDisplay: 0 },
    "2026-07-10T00:00:00.000Z"
  );
  assert.equal(rec.last_read, null);
  assert.doesNotThrow(() => dmReadStatesSchema.parse(rec));
});
