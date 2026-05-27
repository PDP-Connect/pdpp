/**
 * Source-regex guard for the operator dashboard page.
 *
 * The spec scenarios that matter most for the dashboard are also the ones
 * that are easiest to backslide on once a renderer is rewritten:
 *
 *  - No secret material renders in the operator projection (no reference to
 *    `secret`, `secret_hash`, or `secret_text` in the page or its server
 *    action).
 *  - The disable affordance must POST through the server action, not call
 *    the `_ref` route directly from a client component.
 *  - The owner-session re-verify (`requireDashboardAccess`) must run inside
 *    the disable action, per CVE-2025-29927 / Next.js 2026 guidance.
 *
 * Spec: openspec/changes/add-client-event-subscription-management/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;
const ACTION_FILE = `${HERE}disable-action.ts`;

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /^\s*\/\/.*$/gm;

const SECRET_HASH_RE = /secret_hash/;
const SECRET_TEXT_RE = /secret_text/;
const SECRET_FIELD_RE = /\.secret\b/;
const SECRET_LITERAL_RE = /"secret"/;

const FORM_ACTION_RE = /action=\{disableSubscriptionAction\}/;
const REF_DISABLE_PATH_RE = /\/_ref\/event-subscriptions\/.+\/disable/;

const USE_SERVER_DIRECTIVE_RE = /"use server"/;
const REQUIRE_DASHBOARD_ACCESS_CALL_RE = /requireDashboardAccess\(/;
const DISABLE_CLIENT_CALL_RE = /disableClientEventSubscription\(/;

function stripComments(src: string): string {
  return src.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "");
}

test("operator dashboard page does not reference subscription secret material", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // Strip comments so the assertion targets executable code, not the file
  // header rationale which legitimately explains the no-secret invariant.
  const code = stripComments(src);
  assert.doesNotMatch(code, SECRET_HASH_RE);
  assert.doesNotMatch(code, SECRET_TEXT_RE);
  // Neither the field name `secret` nor a string literal containing
  // "secret" should appear in the rendered page code.
  assert.doesNotMatch(code, SECRET_FIELD_RE);
  assert.doesNotMatch(code, SECRET_LITERAL_RE);
});

test("operator dashboard page wires Disable through the server action", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, FORM_ACTION_RE);
  // The page must not POST to the `_ref` route directly — the server action
  // owns that hop, including the owner-session re-verify.
  assert.doesNotMatch(src, REF_DISABLE_PATH_RE);
});

test("disable server action re-verifies the owner session", async () => {
  const src = await readFile(ACTION_FILE, "utf8");
  assert.match(src, USE_SERVER_DIRECTIVE_RE);
  assert.match(src, REQUIRE_DASHBOARD_ACCESS_CALL_RE);
  assert.match(src, DISABLE_CLIENT_CALL_RE);
});
