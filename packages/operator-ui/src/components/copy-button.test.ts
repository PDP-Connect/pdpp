// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SLVP touch-target bar (red-team P2 #5): "Copy connection ID" measured
 * 20x20px at 390x844 — CopyButton backs that usage plus every other
 * copy-to-clipboard affordance in the console, so the fix and this pin apply
 * everywhere it's used, not just `/sources/gmail`.
 *
 * The hit area grows via a `::before` pseudo-element rather than the visible
 * box (which stays the design system's 20px/24px per `size`), so this pins
 * the technique and the per-size expansion math, not just a bigger class.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SOURCE_FILE = fileURLToPath(new URL("./copy-button.tsx", import.meta.url));

const HIT_AREA_PSEUDO_RE = /before:absolute before:content-\[''\]/;
const SM_INSET_RE = /before:inset-\[-12px\]/;
const MD_INSET_RE = /before:inset-\[-10px\]/;
const RELATIVE_POSITION_RE = /"relative inline-flex/;

test("CopyButton grows its hit area via a pseudo-element for both sizes, clearing 44px without resizing the visible box", async () => {
  const src = await readFile(SOURCE_FILE, "utf8");
  assert.match(src, HIT_AREA_PSEUDO_RE);
  // sm: 20px box + 12px/side = 44px. md: 24px box + 10px/side = 44px.
  assert.match(src, SM_INSET_RE);
  assert.match(src, MD_INSET_RE);
  assert.match(src, RELATIVE_POSITION_RE);
});
