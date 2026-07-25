// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard: the site reference page must not contain a hardcoded
 * `localhost` URL as a JSX prop value.
 *
 * The previous bug: `<CalloutMetric label="Local app" value="http://localhost:3002" />`
 * rendered the localhost URL verbatim in production. The fix derives the URL
 * from `getRequestOrigin()` (which reads `x-forwarded-host` / `host` headers).
 * This test prevents a regression where someone re-introduces a literal.
 *
 * Run: node --test apps/site/scripts/reference-page-no-hardcoded-host.test.mjs
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE_PATH = new URL("../src/app/reference/page.tsx", import.meta.url);

// Match JSX attribute patterns like value="http://localhost:..." or
// href="http://localhost:..." but not string-fallback defaults in code like
// ?? "localhost:3002" (which is legitimate for local dev).
const JSX_HARDCODED_LOCALHOST_RE = /(?:value|href|src)="https?:\/\/localhost(?::\d+)?[^"]*"/;

test("reference page has no hardcoded localhost URL as a JSX attribute value", async () => {
  const src = await readFile(fileURLToPath(PAGE_PATH), "utf8");

  assert.ok(
    !JSX_HARDCODED_LOCALHOST_RE.test(src),
    "reference/page.tsx must not contain a hardcoded localhost URL as a JSX attribute value (use providerUrl from getRequestOrigin() instead)"
  );
});
