// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { linkedInShareUrl, SHARE_CARD_ALT, SHARE_CARD_CAPTION, xIntentUrl } from "@/lib/share-card/copy.ts";
import { ShareCardPanel } from "./share-card-panel.tsx";
import { PdppSigningStatus } from "./signing-status.tsx";

const PANEL_SLOT = /data-slot="pdpp-share-card-panel"/;
const OLD_SHARE_BUTTON = />Share</;
const OLD_FEED_DOWNLOAD = /Download for feed/;

function statusHtml(signed: string): string {
  return renderToStaticMarkup(createElement(PdppSigningStatus, { signed }));
}

test("the panel shows on a confirmed signature", () => {
  assert.match(statusHtml("confirmed"), PANEL_SLOT);
});

test("the panel is hidden on every outcome except confirmed", () => {
  for (const signed of ["pending", "incomplete", "ratelimited", "unavailable", "closed", "error", "invalid", "other"]) {
    assert.doesNotMatch(statusHtml(signed), PANEL_SLOT, signed);
  }
});

test("the panel shows the feed image, the caption and the buttons in order", () => {
  const html = renderToStaticMarkup(createElement(ShareCardPanel));
  assert.ok(html.includes(`alt="${SHARE_CARD_ALT}"`));
  assert.ok(html.includes('src="/principles/card/feed"'));
  assert.ok(html.includes('href="/principles/card/feed"'));
  assert.ok(html.includes('href="/principles/card/story"'));
  assert.ok(html.includes('download="pdpp-supporter-card.png"'));
  assert.ok(html.includes('download="pdpp-supporter-card-story.png"'));
  const labels = ["Download image", "Download for Stories", "Copy image", "Post on X", "Post on LinkedIn"];
  const positions = labels.map((label) => html.indexOf(`>${label}<`));
  assert.ok(
    positions.every((position) => position > -1),
    JSON.stringify(positions)
  );
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b)
  );
  assert.ok(html.includes('aria-label="Copy caption"'));
});

test("the caption is shown verbatim", () => {
  const expected =
    "I just signed the pledge for global rules on where my data goes and who trains AI on it. Sign it too: https://pdpp.dev/principles #PDPP";
  assert.equal(SHARE_CARD_CAPTION, expected);
  assert.ok(renderToStaticMarkup(createElement(ShareCardPanel)).includes(`>${expected}<`));
});

test("the X link carries the caption without the link, and the link in its own field", () => {
  const url = new URL(xIntentUrl());
  assert.equal(`${url.origin}${url.pathname}`, "https://x.com/intent/post");
  assert.equal(
    url.searchParams.get("text"),
    "#PDPP I just signed the pledge for global rules on where my data goes and who trains AI on it. Sign it too:"
  );
  assert.equal(url.searchParams.get("url"), "https://pdpp.dev/principles");
});

test("the LinkedIn link carries only the encoded page link", () => {
  assert.equal(
    linkedInShareUrl(),
    "https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fpdpp.dev%2Fprinciples"
  );
});

test("Share… is not rendered without a browser, and the old link-only Share is gone", () => {
  const html = renderToStaticMarkup(createElement(ShareCardPanel));
  assert.ok(!html.includes("Share…"));
  assert.doesNotMatch(html, OLD_SHARE_BUTTON);
  assert.doesNotMatch(html, OLD_FEED_DOWNLOAD);
});
