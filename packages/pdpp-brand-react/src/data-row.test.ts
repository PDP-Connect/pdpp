// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DataRow, DataRowDetail, DataRowMeta, DataRowWho, Monogram } from "./data-row.tsx";

const MONOGRAM_CLASS = /class="pdpp-monogram"/;
const ARIA_HIDDEN_TRUE = /aria-hidden="true"/;
const CLAUDE_INITIALS_DATA = /data-initials="CL"/;
const CLAUDE_INITIALS_TEXT = />CL</;

test("Monogram renders decorative initials without polluting accessible labels", () => {
  const html = renderToStaticMarkup(createElement(Monogram, { name: "Claude" }));

  assert.match(html, MONOGRAM_CLASS);
  assert.match(html, ARIA_HIDDEN_TRUE);
  assert.match(html, CLAUDE_INITIALS_DATA);
  assert.doesNotMatch(html, CLAUDE_INITIALS_TEXT);
});

test("Monogram keeps supplementary Unicode initials intact", () => {
  const html = renderToStaticMarkup(createElement(Monogram, { name: "🌱 B" }));

  assert.ok(html.includes('data-initials="🌱B"'));
});

test("Monogram derives single-word initials after trimming", () => {
  const html = renderToStaticMarkup(createElement(Monogram, { name: "  A  " }));

  assert.ok(html.includes('data-initials="A"'));
});

test("DataRow applies revoked styling without hiding the row content", () => {
  const render = (revoked: boolean) =>
    renderToStaticMarkup(createElement(DataRow, { revoked, cols: "1fr 2fr", className: "custom-row", children: "Example record" }));

  assert.match(render(true), /class="pdpp-data-row pdpp-data-row--revoked custom-row"/);
  assert.doesNotMatch(render(false), /pdpp-data-row--revoked/);
  assert.match(render(true), /style="--cols:1fr 2fr"/);
  assert.match(render(true), />Example record<\/div>/);
});

test("DataRowWho keeps the display title when the protocol identifier is absent", () => {
  const anonymous = renderToStaticMarkup(createElement(DataRowWho, { title: "Sample client" }));
  assert.match(anonymous, /class="pdpp-data-row__title">Sample client<\/span>/);
  assert.doesNotMatch(anonymous, /pdpp-data-row__id/);

  const identified = renderToStaticMarkup(createElement(DataRowWho, { title: "Sample client", id: "example-id" }));
  assert.match(identified, /class="pdpp-data-row__id">example-id<\/span>/);
});

test("DataRowDetail combines the caller class with the detail class and renders its label as text", () => {
  const html = renderToStaticMarkup(createElement(DataRowDetail, { className: "custom-detail", children: "A < B & C" }));

  assert.equal(html, '<span class="pdpp-data-row__detail custom-detail">A &lt; B &amp; C</span>');
});

test("DataRowMeta renders an explicit numeric zero rather than a blank value", () => {
  const html = renderToStaticMarkup(createElement(DataRowMeta, { children: 0 }));

  assert.equal(html, '<span class="pdpp-data-row__meta">0</span>');
});

test("Monogram tint is opt-in and stable across case and outside spacing", () => {
  const plain = renderToStaticMarkup(createElement(Monogram, { name: "Sample Name" }));
  const first = renderToStaticMarkup(createElement(Monogram, { name: "Sample Name", tinted: true }));
  const normalized = renderToStaticMarkup(createElement(Monogram, { name: "  SAMPLE NAME  ", tinted: true }));
  assert.doesNotMatch(plain, /pdpp-monogram--tinted|--pdpp-monogram-hue/);
  assert.match(first, /pdpp-monogram--tinted/);
  assert.match(first, /--pdpp-monogram-hue:\d+/);
  assert.equal(first, normalized);
});

test("DataRowWho preserves an added class and renders identifier punctuation as text", () => {
  const html = renderToStaticMarkup(createElement(DataRowWho, { title: "App & data", id: "sample:<id>", className: "external" }));
  assert.match(html, /class="pdpp-data-row__who external"/);
  assert.match(html, />App &amp; data<\/span>/);
  assert.match(html, />sample:&lt;id&gt;<\/span>/);
});
