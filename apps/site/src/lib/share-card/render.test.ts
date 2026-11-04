// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { WORDMARK_PATH } from "../../components/elements/icons.tsx";
import { SHARE_CARD_ALT, SHARE_CARD_COPY, SHARE_CARD_LINK } from "./copy.ts";
import { wordmarkSvg } from "./render.tsx";

const OKLCH = /oklch\(/;

test("the card copy is the brand owner's, verbatim", () => {
  assert.equal(SHARE_CARD_COPY.statement, "My data, my rules.");
  assert.equal(
    SHARE_CARD_COPY.subtext,
    "I just signed the pledge for global rules on where my data goes and who trains AI on it."
  );
  assert.equal(SHARE_CARD_COPY.button, "Sign the pledge → pdpp.dev");
  assert.equal(SHARE_CARD_COPY.hashtag, "#PDPP");
  assert.equal(SHARE_CARD_LINK, "https://pdpp.dev/principles");
});

test("the card alt text carries every word on the card", () => {
  for (const text of Object.values(SHARE_CARD_COPY)) {
    assert.ok(SHARE_CARD_ALT.includes(text), text);
  }
});

test("the wordmark is the header's path and viewBox, unmodified, in the primary colour", () => {
  const svg = wordmarkSvg("#295171");
  assert.ok(svg.includes(` d="${WORDMARK_PATH}"`));
  assert.ok(svg.includes('viewBox="0 0 365 160"'));
  assert.ok(svg.includes('fill="#295171"'));
  assert.doesNotMatch(svg, OKLCH);
});
