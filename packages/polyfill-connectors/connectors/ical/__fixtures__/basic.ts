// Synthetic .ics fixtures for parsers.test.ts. Strings are what a real
// `export.ics` would look like on disk (CRLF + line folding), since
// parsers consume that directly.

/** Two VEVENTs, both UTC, with UID/SUMMARY/DESCRIPTION/LOCATION + STATUS. */
export const BASIC_ICS =
  "BEGIN:VCALENDAR\r\n" +
  "VERSION:2.0\r\n" +
  "BEGIN:VEVENT\r\n" +
  "UID:event-1@example.com\r\n" +
  "DTSTART:20240605T130000Z\r\n" +
  "DTEND:20240605T140000Z\r\n" +
  "SUMMARY:Team standup\r\n" +
  "DESCRIPTION:Daily sync\\, dial-in via Meet\r\n" +
  "LOCATION:Remote\r\n" +
  "STATUS:CONFIRMED\r\n" +
  "END:VEVENT\r\n" +
  "BEGIN:VEVENT\r\n" +
  "UID:event-2@example.com\r\n" +
  "DTSTART:20240606T090000Z\r\n" +
  "SUMMARY:1:1 with manager\r\n" +
  "ORGANIZER;CN=Boss:mailto:boss@example.com\r\n" +
  "ATTENDEE;CN=Alice;ROLE=REQ-PARTICIPANT:mailto:alice@example.com\r\n" +
  "ATTENDEE;CN=Bob:mailto:bob@example.com\r\n" +
  "RRULE:FREQ=WEEKLY;BYDAY=MO\r\n" +
  "END:VEVENT\r\n" +
  "END:VCALENDAR\r\n";

/** All-day event via VALUE=DATE parameter. */
export const ALL_DAY_ICS =
  "BEGIN:VCALENDAR\r\n" +
  "BEGIN:VEVENT\r\n" +
  "UID:holiday-1\r\n" +
  "DTSTART;VALUE=DATE:20240704\r\n" +
  "DTEND;VALUE=DATE:20240705\r\n" +
  "SUMMARY:Independence Day\r\n" +
  "END:VEVENT\r\n" +
  "END:VCALENDAR\r\n";

/** Folded SUMMARY line (RFC 5545 continuation) that must be unfolded. */
export const FOLDED_ICS =
  "BEGIN:VCALENDAR\r\n" +
  "BEGIN:VEVENT\r\n" +
  "UID:folded-1\r\n" +
  "DTSTART:20240701T100000Z\r\n" +
  "SUMMARY:A very long meeting title that\r\n" +
  " wraps across two lines\r\n" +
  "END:VEVENT\r\n" +
  "END:VCALENDAR\r\n";

/** VEVENT missing UID — should be filtered out by buildEventRecord. */
export const MISSING_UID_ICS =
  "BEGIN:VCALENDAR\r\n" +
  "BEGIN:VEVENT\r\n" +
  "DTSTART:20240701T100000Z\r\n" +
  "SUMMARY:Anonymous event\r\n" +
  "END:VEVENT\r\n" +
  "END:VCALENDAR\r\n";
