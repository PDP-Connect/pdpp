// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SHARE_CARD_ALT } from "@/lib/share-card/copy.ts";
import { ShareCardPanel } from "./share-card-panel.tsx";
import { PdppSigningStatus } from "./signing-status.tsx";

const FLAG = "NEXT_PUBLIC_PDPP_SHARE_CARD";
const PANEL_SLOT = /data-slot="pdpp-share-card-panel"/;

afterEach(() => {
  delete process.env[FLAG];
});

function statusHtml(signed: string): string {
  return renderToStaticMarkup(createElement(PdppSigningStatus, { signed }));
}

test("the panel shows on a confirmed signature when the flag is 1", () => {
  process.env[FLAG] = "true";
  assert.match(statusHtml("confirmed"), PANEL_SLOT);
});

test("the panel is hidden when the flag is off, unset, or not exactly 1", () => {
  for (const value of [undefined, "", "0", "1"]) {
    if (value === undefined) {
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = value;
    }
    assert.doesNotMatch(statusHtml("confirmed"), PANEL_SLOT, JSON.stringify(value));
  }
});

test("the panel is hidden on every outcome except confirmed, even with the flag on", () => {
  process.env[FLAG] = "true";
  for (const signed of ["pending", "incomplete", "ratelimited", "unavailable", "closed", "error", "invalid", "other"]) {
    assert.doesNotMatch(statusHtml(signed), PANEL_SLOT, signed);
  }
});

test("the panel shows the feed image with alt text, both downloads and a share button", () => {
  const html = renderToStaticMarkup(createElement(ShareCardPanel));
  assert.ok(html.includes(`alt="${SHARE_CARD_ALT}"`));
  assert.ok(html.includes('src="/principles/card/feed"'));
  assert.ok(html.includes('href="/principles/card/feed"'));
  assert.ok(html.includes('href="/principles/card/story"'));
  assert.ok(html.includes(">Download for feed<"));
  assert.ok(html.includes(">Download for Stories<"));
  assert.ok(html.includes(">Share<"));
});
