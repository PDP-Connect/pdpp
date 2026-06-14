import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IcTimestamp, parseTimestampValue } from "./timestamp.tsx";

// IcTimestamp must render a <time> element in the mono token voice and stay
// SSR-stable (absolute label on the server; relative is a post-mount upgrade).
// These render checks pin both the markup contract and the parse logic.

const TIME_EL = /<time[^>]*class="[^"]*pdpp-timestamp/;
// React 19's renderToStaticMarkup preserves the JSX prop name casing (`dateTime`)
// in static markup; the browser still serializes it to the lowercase HTML
// `datetime` attribute. Match case-insensitively so the assertion is robust to
// either serialization.
const DATETIME_ATTR = /datetime="2024-01-02T03:04:05\.000Z"/i;
const TITLE_ATTR = /title="/;
const EM_DASH_SPAN = /<span class="pdpp-timestamp pdpp-timestamp--empty"[^>]*>—<\/span>/;
const CALENDAR_TIME = /<time[^>]*datetime="2024-03-15"[^>]*>Mar 15, 2024<\/time>/i;
const MERGED_CLASS = /class="pdpp-timestamp text-right"/;
const ABSOLUTE_LABEL = /Jan 2, 2024/;

test("IcTimestamp renders an SSR-stable <time> with the token class and absolute label", () => {
  const html = renderToStaticMarkup(createElement(IcTimestamp, { value: "2024-01-02T03:04:05Z" }));
  assert.match(html, TIME_EL);
  // Server render is absolute (UTC) — relative is only applied after mount.
  assert.match(html, DATETIME_ATTR);
  assert.match(html, TITLE_ATTR);
  assert.match(html, ABSOLUTE_LABEL);
});

test("IcTimestamp renders an em dash for null/empty values", () => {
  const html = renderToStaticMarkup(createElement(IcTimestamp, { value: null }));
  assert.match(html, EM_DASH_SPAN);
});

test("IcTimestamp keeps calendar dates timezone-stable (UTC, no clock)", () => {
  const html = renderToStaticMarkup(createElement(IcTimestamp, { value: "2024-03-15", valueKind: "calendar-date" }));
  assert.match(html, CALENDAR_TIME);
});

test("IcTimestamp merges a caller className onto the token class", () => {
  const html = renderToStaticMarkup(
    createElement(IcTimestamp, { className: "text-right", value: "2024-01-02T03:04:05Z" })
  );
  assert.match(html, MERGED_CLASS);
});

test("parseTimestampValue returns null for unparseable input and a Date for valid instants", () => {
  assert.equal(parseTimestampValue(""), null);
  assert.equal(parseTimestampValue("not-a-date"), null);
  const parsed = parseTimestampValue("2024-01-02T03:04:05Z");
  assert.ok(parsed);
  assert.equal(parsed?.kind, "instant");
  assert.equal(parsed?.date.toISOString(), "2024-01-02T03:04:05.000Z");
});
