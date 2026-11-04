// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { SHARE_CARD_ALT, SHARE_CARD_COPY, SHARE_CARD_LINK } from "./copy.ts";
import { oklchFillsToHex } from "./render.tsx";

const MARK_PATH = join(process.cwd(), "public", "brand", "pdpp-mark.svg");
const PATH_DATA = /\sd="([^"]+)"/g;
const OKLCH_FILL = /fill="oklch\(/;
const HEX_FILLS = /fill="(#[0-9a-f]{6})"/g;

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

test("the mark keeps its geometry and gets the same colours in hex", async () => {
  const svg = await readFile(MARK_PATH, "utf8");
  const converted = oklchFillsToHex(svg);
  assert.doesNotMatch(converted, OKLCH_FILL);
  assert.deepEqual(
    [...converted.matchAll(PATH_DATA)].map((m) => m[1]),
    [...svg.matchAll(PATH_DATA)].map((m) => m[1])
  );
  // Copper, blue and the cream centre dot: oklch(0.52 0.11 45), oklch(0.58 0.18 253), oklch(0.985 0.005 85).
  assert.deepEqual(
    [...converted.matchAll(HEX_FILLS)].map((m) => m[1]),
    ["#9c522e", "#007ae0", "#fcfaf6"]
  );
});
