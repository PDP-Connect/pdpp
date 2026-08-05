// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// A reader who comes to connect ChatGPT, Amazon or USAA needs a command that
// can launch a real browser. The default `reference` image ships none, so a
// command built on it starts cleanly and then fails at sign-in with
// "Executable doesn't exist at /opt/patchright-browsers/...".
//
// This test fails if a Self-Host tab offers a browser command that would hit
// that wall, and it fails if a tab silently drops the browser choice instead of
// saying it cannot serve it. Both failures are invisible by inspection: the
// command still looks right.
//
// Verified by execution 2026-08-05, and this is what the assertions encode:
//   ghcr.io/pdp-connect/pdpp/reference-browser:main
//     -> /opt/patchright-browsers/chromium-1217 present
//   ghcr.io/pdp-connect/pdpp/reference:main
//     -> no /opt/patchright-browsers directory at all

const PAGE = readFileSync(join(import.meta.dirname, "../src/app/reference/page.tsx"), "utf8");

const BROWSER_IMAGE = "reference-browser";

/**
 * Each tab object in COMMAND_TABS. Tabs are separated by a `},\n  {` at the
 * array's indentation, so splitting there keeps every field of a tab with the
 * `id:` that names it. Splitting on `id:` alone drops the fields declared above
 * it, which silently passed a tab that had no browser handling at all.
 */
function tabBlocks(): { id: string; body: string }[] {
  const start = PAGE.indexOf("const COMMAND_TABS");
  assert.notEqual(start, -1, "COMMAND_TABS not found; this test is anchored to the wrong file");
  const table = PAGE.slice(start, PAGE.indexOf("\n];", start));
  return table
    .split(/\n {2}\{\n/)
    .slice(1)
    .map((body) => ({ body, id: /id:\s*"([a-z]+)"/.exec(body)?.[1] ?? "" }))
    .filter((block) => block.id !== "");
}

test("every Self-Host tab either serves browser sources or says it cannot", () => {
  const blocks = tabBlocks();
  assert.ok(blocks.length >= 3, `expected at least 3 tabs, found ${blocks.length}`);

  for (const { body, id } of blocks) {
    const offers = body.includes("browserCommand:");
    const declines = body.includes("browserUnavailable:");
    assert.ok(
      offers !== declines,
      `tab "${id}" must define exactly one of browserCommand or browserUnavailable, so the browser choice is never silently ignored`
    );
  }
});

test("a tab that offers a browser command names the browser-capable image", () => {
  for (const { body, id } of tabBlocks()) {
    if (!body.includes("browserCommand:")) {
      continue;
    }
    const command = body.slice(body.indexOf("browserCommand:"));
    assert.ok(
      command.includes(BROWSER_IMAGE),
      `tab "${id}" offers a browser command that never names ${BROWSER_IMAGE}, so it would run the browser-free image and fail at sign-in`
    );
  }
});

test("no command or copy exposes a platform-specific artifact name", () => {
  // Public artifact names are platform-neutral: `core` and `core-browser`.
  // `railway-core` is an internal Docker target kept for compatibility, and a
  // reader who sees it learns a deployment provider's name as if it were the
  // product's. Comments are exempt; they explain why the target exists.
  const visible = PAGE.split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.ok(
    !visible.includes("railway-core"),
    "railway-core is an internal target name and must not appear in a command or in copy a reader sees"
  );
});

test("the browser-free default image is never the image a browser command selects", () => {
  for (const { body, id } of tabBlocks()) {
    if (!body.includes("browserCommand:")) {
      continue;
    }
    const command = body.slice(body.indexOf("browserCommand:"));
    const override = /PDPP_REFERENCE_IMAGE=\S*?pdpp\/(reference|reference-browser)(:|"|\\)/.exec(command);
    if (override) {
      assert.equal(
        override[1],
        BROWSER_IMAGE,
        `tab "${id}" sets PDPP_REFERENCE_IMAGE to the browser-free image; browser-backed connectors would fail at Patchright launch`
      );
    }
  }
});
