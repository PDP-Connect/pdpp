// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PublicSupporter } from "@/lib/public-supporters.ts";
import { PdppSupportersRoll, PdppSupportersTable } from "./supporters.tsx";

// The roll is the front page's view of the same published register the table
// shows on /principles. Its risks are all in the duplication that makes the
// loop seamless — a second copy of real names is the thing a reader must not
// be read twice, and a register too short to fill the window is the thing that
// must not be handed to the loop at all. Rendering is the only oracle that
// sees either: both are properties of the emitted markup, not of a value any
// cheaper unit test could hold.

function supporter(publicName: string, signedOn: string): PublicSupporter {
  return { country: "Australia", principlesVersion: "1.0", publicName, signedOn, type: "Individual" };
}

// Six: one more than the five-row window, which is the smallest register that
// rolls.
const ROLLING_REGISTER = [
  supporter("Ada A.", "2026-09-01"),
  supporter("Bo B.", "2026-09-02"),
  supporter("Cai C.", "2026-09-03"),
  supporter("Dev D.", "2026-09-04"),
  supporter("Eli E.", "2026-09-05"),
  supporter("Fay F.", "2026-09-06"),
] as const;

const ARIA_HIDDEN_TRACK = /aria-hidden="true"/g;
const ANIMATION_DURATION = /animation-duration:\s*21s/;
const ROLL_ANIMATION_CLASS = /animate-\[pdpp-supporters-roll/;

test("the roll duplicates the register for the seam and hides the duplicate from readers", () => {
  const html = renderToStaticMarkup(createElement(PdppSupportersRoll, { supporters: ROLLING_REGISTER }));

  // Each name is present twice — once per track — but exactly one track is
  // hidden, so a screen reader reads the register once.
  for (const { publicName } of ROLLING_REGISTER) {
    assert.equal(html.split(publicName).length - 1, 2, publicName);
  }
  assert.equal(html.match(ARIA_HIDDEN_TRACK)?.length, 1);
});

test("the roll keeps the register's own signing order", () => {
  const html = renderToStaticMarkup(createElement(PdppSupportersRoll, { supporters: ROLLING_REGISTER }));

  // Rows arrive in the order people signed. Reversing them would show a feed
  // of arrivals running backwards through time.
  const positions = ROLLING_REGISTER.map(({ publicName }) => html.indexOf(publicName));
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions
  );
});

test("the roll holds its speed as the register grows", () => {
  const html = renderToStaticMarkup(createElement(PdppSupportersRoll, { supporters: ROLLING_REGISTER }));

  // Six rows at 3.5s of travel each. A duration baked into the animation
  // shorthand instead would make every new signature speed the roll up.
  assert.match(html, ANIMATION_DURATION);
});

test("a register no taller than the window sits still", () => {
  const html = renderToStaticMarkup(createElement(PdppSupportersRoll, { supporters: ROLLING_REGISTER.slice(0, 5) }));

  // Two stacked copies of a five-row register in a five-row window loop once
  // per window, which reads as a stutter rather than a roll.
  assert.doesNotMatch(html, ROLL_ANIMATION_CLASS);
  assert.doesNotMatch(html, ARIA_HIDDEN_TRACK);
});

test("the roll and the table say the same thing about an empty register", () => {
  // The two share one empty state. Drift between them would have the front
  // page and /principles disagree about whether anyone has signed.
  assert.equal(
    renderToStaticMarkup(createElement(PdppSupportersRoll, { supporters: [] })),
    renderToStaticMarkup(createElement(PdppSupportersTable, { supporters: [] }))
  );
});
