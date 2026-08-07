// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-regex guard for the sidebar/content seam.
 *
 * The sidebar masthead (the pdpp lockup) and the content Topbar sit on either
 * side of the shell's vertical border. Both draw a bottom rule, so the two
 * only read as ONE continuous line when they share a height and a border
 * color. Before this was pinned, the masthead sat in a `py-6` block while the
 * Topbar was a fixed `h-12` bar, so the rules met the seam at different
 * heights and the corner visibly stepped.
 *
 * Reported by the owner against the Overview page, 2026-08-07.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SHELL_FILE = `${HERE}shell.tsx`;

// Both bars: h-12, and a bottom border in the shared border-border/80 token.
const TOPBAR_RE = /className="sticky top-0 z-30 flex h-12 items-center[^"]*border-border\/80 border-b/;
const MASTHEAD_RE = /className="flex h-12 items-center border-border\/80 md:border-b/;

test("sidebar masthead and Topbar share the same height", async () => {
  const src = await readFile(SHELL_FILE, "utf8");
  assert.match(src, TOPBAR_RE, "Topbar must stay h-12 with a border-border/80 bottom rule");
  assert.match(src, MASTHEAD_RE, "sidebar masthead must stay h-12 with a border-border/80 bottom rule");
});

test("sidebar masthead draws its rule only on the desktop rail", async () => {
  // The mobile drawer renders SidebarContent with no Topbar beside it, so an
  // unconditional border-b would draw a rule that lines up with nothing.
  const src = await readFile(SHELL_FILE, "utf8");
  assert.match(src, /border-border\/80 md:border-b/);
});

test("the desktop rail does not re-add top padding above the masthead", async () => {
  // `py-6` here is what broke the alignment originally: it pushed the lockup
  // down so its rule no longer met the Topbar's. Padding belongs below the
  // masthead (pb-6), not around it.
  const src = await readFile(SHELL_FILE, "utf8");
  const aside = src.slice(src.indexOf("<aside"), src.indexOf("</aside>"));
  assert.doesNotMatch(aside, /\bpy-6\b/, "use pb-6 on the rail; py-6 re-breaks the masthead seam");
});
