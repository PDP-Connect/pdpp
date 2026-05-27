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

// Stale-string sentinels. These are real defects we corrected; the
// regression-tests keep the page from drifting back.
const STALE_CLIENT_EVENTS_ENDPOINT_RE = /\/as\/client-events\/subscriptions/;
const STALE_CLIENT_SUBSCRIPTION_STATUS_RE = /client_subscription_status/;
const STALE_REASON_CHARS_LABEL_RE = /max 256 chars/i;

// Filter-status select must surface exactly one empty-value option (the
// "any" fallback). A duplicate is a real bug we saw upstream of this
// revision; locking it in keeps a future refactor from re-introducing it.
const ANY_STATUS_OPTION_GLOBAL_RE = /<option\s+value=""[^>]*>/g;

// Server-rendered confirmation. The form must POST a `confirm_disable`
// field and the action must reject submits where it is not exactly "yes".
const CONFIRM_INPUT_RE = /name="confirm_disable"/;
const CONFIRM_REQUIRED_GATE_RE = /confirm_disable[\s\S]{0,200}!==\s*"yes"/;

// Reason cap is byte-based and never truncates silently.
const REASON_BYTE_CAP_LABEL_RE = /max 256 bytes/i;
const REASON_BYTE_LENGTH_CALL_RE = /Buffer\.byteLength\(.+,\s*"utf8"\)/;
const SILENT_TRUNCATE_RE = /raw\.slice\(0,\s*MAX_REASON_BYTES\)/;

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

test("operator dashboard page references the correct client-facing routes", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.doesNotMatch(src, STALE_CLIENT_EVENTS_ENDPOINT_RE);
  assert.doesNotMatch(src, STALE_CLIENT_SUBSCRIPTION_STATUS_RE);
  assert.doesNotMatch(src, STALE_REASON_CHARS_LABEL_RE);
});

test("status filter renders exactly one empty-value option", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  const matches = src.match(ANY_STATUS_OPTION_GLOBAL_RE) ?? [];
  assert.equal(
    matches.length,
    1,
    `expected exactly one <option value=""> in page.tsx but found ${matches.length}: ${JSON.stringify(matches)}`
  );
});

test("disable form is server-rendered with an explicit confirmation input", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, CONFIRM_INPUT_RE);
  assert.match(src, REASON_BYTE_CAP_LABEL_RE);
});

test("disable server action enforces confirmation and byte-bounded reason without truncation", async () => {
  const src = await readFile(ACTION_FILE, "utf8");
  assert.match(src, CONFIRM_REQUIRED_GATE_RE);
  // Byte-based cap with Buffer.byteLength, not UTF-16 `slice` truncation.
  assert.match(src, REASON_BYTE_LENGTH_CALL_RE);
  assert.doesNotMatch(src, SILENT_TRUNCATE_RE);
});
