/**
 * Source-regex guard for the owner-facing browser-session setup page.
 *
 * This page is for a normal owner trying to connect a browser-backed source.
 * Operator runbooks, internal browser service names, and repository paths belong
 * in diagnostics/operator surfaces, not in the primary setup journey.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}[connectorId]/page.tsx`;

const SECURE_BROWSER_COPY_RE = /secure browser/;
const OPERATOR_ARTIFACT_RE =
  /BROWSER_BOUND_RUNBOOK_PATH|browser-collector runbook|docs\/operator\/browser-collector-proof-runbook\.md|\bneko\b|n\.eko|hosted Chromium/;

test("browser-session page does not send owners to operator/browser-service artifacts", async () => {
  const src = await readFile(PAGE_FILE, "utf8");

  assert.match(src, SECURE_BROWSER_COPY_RE);
  assert.doesNotMatch(src, OPERATOR_ARTIFACT_RE);
});
