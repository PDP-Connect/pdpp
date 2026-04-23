import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_DAY_ICS, BASIC_ICS, FOLDED_ICS, MISSING_UID_ICS } from "./__fixtures__/basic.ts";
import {
  advanceCursor,
  applyIcsProperty,
  buildEventRecord,
  hashId,
  isBeforeCursor,
  parseIcs,
  parseIcsDate,
  parseIcsLine,
  unescapeIcsText,
  unfoldIcal,
} from "./parsers.ts";
import type { IcsEvent } from "./types.ts";

// ─── parseIcsDate ───────────────────────────────────────────────────────

test("parseIcsDate: UTC datetime → ISO Z", () => {
  assert.equal(parseIcsDate("20240605T130000Z", false), "2024-06-05T13:00:00Z");
});

test("parseIcsDate: local datetime → ISO without offset", () => {
  assert.equal(parseIcsDate("20240605T130000", false), "2024-06-05T13:00:00");
});

test("parseIcsDate: date-only → midnight UTC", () => {
  assert.equal(parseIcsDate("20240704", true), "2024-07-04T00:00:00Z");
});

test("parseIcsDate: falls back to Date parser for RFC-like strings", () => {
  const got = parseIcsDate("Wed, 05 Jun 2024 13:00:00 GMT", false);
  assert.equal(got, "2024-06-05T13:00:00.000Z");
});

test("parseIcsDate: undefined → null", () => {
  assert.equal(parseIcsDate(undefined, false), null);
});

test("parseIcsDate: garbage → null", () => {
  assert.equal(parseIcsDate("not-a-date", false), null);
});

// ─── unescapeIcsText ────────────────────────────────────────────────────

test("unescapeIcsText: \\n → newline, \\, → comma", () => {
  assert.equal(unescapeIcsText("line1\\nline2\\, end"), "line1\nline2, end");
});

// ─── unfoldIcal ─────────────────────────────────────────────────────────

test("unfoldIcal: collapses CRLF+space continuation into single line (fold char dropped)", () => {
  // Per RFC 5545 fold semantics: the single whitespace indent after CRLF is
  // itself part of the fold marker, so real calendars intentionally put a
  // trailing space at the break-point when they need one in the final text.
  const folded = "SUMMARY:A very\r\n long title";
  assert.equal(unfoldIcal(folded), "SUMMARY:A verylong title");
});

test("unfoldIcal: CRLF+tab also collapses (only the fold char is dropped)", () => {
  // The regex strips "\r\n" plus exactly one whitespace char — matches
  // RFC 5545's single-character continuation marker.
  const folded = "SUMMARY:A very\r\n\tlong title";
  assert.equal(unfoldIcal(folded), "SUMMARY:A verylong title");
});

// ─── parseIcsLine ───────────────────────────────────────────────────────

test("parseIcsLine: SUMMARY:Hello → name/value", () => {
  const got = parseIcsLine("SUMMARY:Hello");
  assert.ok(got);
  assert.equal(got.name, "SUMMARY");
  assert.equal(got.value, "Hello");
  assert.equal(got.isDateOnly, false);
});

test("parseIcsLine: DTSTART;VALUE=DATE:20240605 → isDateOnly true", () => {
  const got = parseIcsLine("DTSTART;VALUE=DATE:20240605");
  assert.ok(got);
  assert.equal(got.name, "DTSTART");
  assert.equal(got.value, "20240605");
  assert.equal(got.isDateOnly, true);
});

test("parseIcsLine: ORGANIZER;CN=Boss:mailto:boss@x.com → params.CN preserved", () => {
  const got = parseIcsLine("ORGANIZER;CN=Boss:mailto:boss@x.com");
  assert.ok(got);
  assert.equal(got.params.CN, "Boss");
  assert.equal(got.value, "mailto:boss@x.com");
});

test("parseIcsLine: line without ':' → null", () => {
  assert.equal(parseIcsLine("BEGIN_NOT_A_PROPERTY"), null);
});

test("parseIcsLine: uppercases property name (case-insensitive RFC rule)", () => {
  const got = parseIcsLine("summary:hi");
  assert.ok(got);
  assert.equal(got.name, "SUMMARY");
});

// ─── applyIcsProperty ───────────────────────────────────────────────────

function emptyEvent(): IcsEvent {
  return { calendar_name: "cal", attendees: [] };
}

test("applyIcsProperty: UID sets uid", () => {
  const e = emptyEvent();
  const line = parseIcsLine("UID:abc-1");
  assert.ok(line);
  applyIcsProperty(e, line);
  assert.equal(e.uid, "abc-1");
});

test("applyIcsProperty: DTSTART with VALUE=DATE sets all_day + date-only start", () => {
  const e = emptyEvent();
  const line = parseIcsLine("DTSTART;VALUE=DATE:20240704");
  assert.ok(line);
  applyIcsProperty(e, line);
  assert.equal(e.all_day, true);
  assert.equal(e.start, "2024-07-04T00:00:00Z");
});

test("applyIcsProperty: SUMMARY unescapes \\n/\\,", () => {
  const e = emptyEvent();
  const line = parseIcsLine("SUMMARY:hi\\, there\\nfriend");
  assert.ok(line);
  applyIcsProperty(e, line);
  assert.equal(e.summary, "hi, there\nfriend");
});

test("applyIcsProperty: ORGANIZER extracts email from mailto:", () => {
  const e = emptyEvent();
  const line = parseIcsLine("ORGANIZER;CN=Boss:mailto:boss@x.com");
  assert.ok(line);
  applyIcsProperty(e, line);
  assert.equal(e.organizer_email, "boss@x.com");
});

test("applyIcsProperty: ATTENDEE appends with CN/ROLE", () => {
  const e = emptyEvent();
  const line = parseIcsLine("ATTENDEE;CN=Alice;ROLE=REQ-PARTICIPANT:mailto:alice@x.com");
  assert.ok(line);
  applyIcsProperty(e, line);
  assert.equal(e.attendees.length, 1);
  assert.deepEqual(e.attendees[0], {
    email: "alice@x.com",
    name: "Alice",
    role: "REQ-PARTICIPANT",
  });
});

test("applyIcsProperty: unknown property is a no-op", () => {
  const e = emptyEvent();
  const line = parseIcsLine("X-WR-CALNAME:Personal");
  assert.ok(line);
  applyIcsProperty(e, line);
  assert.equal(e.summary, undefined);
  assert.equal(e.attendees.length, 0);
});

// ─── parseIcs (integration, still pure) ────────────────────────────────

test("parseIcs: BASIC_ICS → 2 events with attendees on the second", () => {
  const events = parseIcs(BASIC_ICS, "work");
  assert.equal(events.length, 2);
  const [first, second] = events;
  assert.ok(first && second);
  assert.equal(first.uid, "event-1@example.com");
  assert.equal(first.summary, "Team standup");
  assert.equal(first.description, "Daily sync, dial-in via Meet");
  assert.equal(first.location, "Remote");
  assert.equal(first.start, "2024-06-05T13:00:00Z");
  assert.equal(first.end, "2024-06-05T14:00:00Z");
  assert.equal(first.status, "CONFIRMED");
  assert.equal(second.uid, "event-2@example.com");
  assert.equal(second.organizer_email, "boss@example.com");
  assert.equal(second.attendees.length, 2);
  assert.equal(second.rrule, "FREQ=WEEKLY;BYDAY=MO");
});

test("parseIcs: ALL_DAY_ICS → all_day=true and date-only start", () => {
  const events = parseIcs(ALL_DAY_ICS, "holidays");
  assert.equal(events.length, 1);
  const [e] = events;
  assert.ok(e);
  assert.equal(e.all_day, true);
  assert.equal(e.start, "2024-07-04T00:00:00Z");
});

test("parseIcs: FOLDED_ICS → continuation line unfolded into SUMMARY", () => {
  const events = parseIcs(FOLDED_ICS, "cal");
  assert.equal(events.length, 1);
  const [e] = events;
  assert.ok(e);
  assert.equal(e.summary, "A very long meeting title thatwraps across two lines");
});

test("parseIcs: MISSING_UID_ICS parses but uid is undefined", () => {
  const events = parseIcs(MISSING_UID_ICS, "cal");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.uid, undefined);
});

// ─── buildEventRecord ───────────────────────────────────────────────────

test("buildEventRecord: populated event → full record", () => {
  const [first] = parseIcs(BASIC_ICS, "work");
  assert.ok(first);
  const rec = buildEventRecord(first, "work");
  assert.ok(rec);
  assert.equal(rec.calendar_name, "work");
  assert.equal(rec.uid, "event-1@example.com");
  assert.equal(rec.start, "2024-06-05T13:00:00Z");
  assert.equal(rec.end, "2024-06-05T14:00:00Z");
  assert.equal(rec.all_day, false);
  assert.equal(rec.status, "CONFIRMED");
  assert.match(rec.id, /^[0-9a-f]{24}$/);
});

test("buildEventRecord: missing UID → null (skip)", () => {
  const [e] = parseIcs(MISSING_UID_ICS, "cal");
  assert.ok(e);
  assert.equal(buildEventRecord(e, "cal"), null);
});

test("buildEventRecord: same calendar+uid+start → stable id", () => {
  const [e] = parseIcs(BASIC_ICS, "work");
  assert.ok(e);
  const a = buildEventRecord(e, "work");
  const b = buildEventRecord(e, "work");
  assert.ok(a && b);
  assert.equal(a.id, b.id);
});

// ─── Cursor helpers ─────────────────────────────────────────────────────

test("isBeforeCursor: no cursor → false (keep)", () => {
  assert.equal(isBeforeCursor("2024-06-05T13:00:00Z", undefined), false);
});

test("isBeforeCursor: equal → true (skip already-emitted)", () => {
  assert.equal(isBeforeCursor("2024-06-05T13:00:00Z", "2024-06-05T13:00:00Z"), true);
});

test("isBeforeCursor: strictly after → false (keep)", () => {
  assert.equal(isBeforeCursor("2024-06-06T13:00:00Z", "2024-06-05T13:00:00Z"), false);
});

test("advanceCursor: monotonic max", () => {
  assert.equal(advanceCursor(undefined, "2024-06-05T13:00:00Z"), "2024-06-05T13:00:00Z");
  assert.equal(advanceCursor("2024-06-05T13:00:00Z", "2024-06-06T13:00:00Z"), "2024-06-06T13:00:00Z");
  assert.equal(advanceCursor("2024-06-06T13:00:00Z", "2024-06-05T13:00:00Z"), "2024-06-06T13:00:00Z");
});

// ─── hashId ─────────────────────────────────────────────────────────────

test("hashId: deterministic 24-char hex", () => {
  const id = hashId("a|b|c");
  assert.match(id, /^[0-9a-f]{24}$/);
  assert.equal(id, hashId("a|b|c"));
  assert.notEqual(id, hashId("a|b|d"));
});
