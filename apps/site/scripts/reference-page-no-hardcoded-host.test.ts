// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard: the public reference page must not contain a hardcoded
 * local deployment URL as a JSX prop value.
 *
 * The public site is documentation, not a running PDPP node. Deployment
 * origins belong in the operator's copied commands, never in a public live
 * surface.
 *
 * Run: node --test apps/site/scripts/reference-page-no-hardcoded-host.test.ts
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE_PATH = new URL("../src/app/reference/page.tsx", import.meta.url);

// Match JSX attribute patterns like value="http://localhost:..." or
// href="http://localhost:..." but not string-fallback defaults in code like
// ?? "localhost:3000" (which is legitimate for local dev).
const JSX_HARDCODED_LOCALHOST_RE = /(?:value|href|src)="https?:\/\/localhost(?::\d+)?[^"]*"/;

test("reference page has no hardcoded localhost URL as a JSX attribute value", async () => {
  const src = await readFile(fileURLToPath(PAGE_PATH), "utf8");

  assert.ok(
    !JSX_HARDCODED_LOCALHOST_RE.test(src),
    "reference/page.tsx must not contain a hardcoded localhost URL as a JSX attribute value"
  );
});
