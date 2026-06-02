/**
 * Source-regex invariants for the grant-package detail page and its
 * server-action revoke flow.
 *
 * The revoke affordance is the entire reason this page exists; if it
 * loses its confirmation gate or the server action drops its owner-
 * session check, the page becomes a one-click cascade-revoke vector
 * for anyone who can land a CSRF on the operator console. These tests
 * pin the safety surface:
 *
 *   1. The page wires its form to `revokePackageAction` (server
 *      action), not to a hand-rolled POST or a client component.
 *   2. The form carries a `confirm_revoke` field; the action enforces
 *      `confirm_revoke=yes` server-side.
 *   3. The action re-verifies the owner session via
 *      `requireDashboardAccess` before calling the revoke helper.
 *   4. Child grant rows link to `/dashboard/grants/[grantId]` with
 *      `encodeURIComponent` over the id.
 *   5. The page never renders secret-shaped fields.
 *
 * Spec: openspec/changes/add-grant-package-operator-visibility/
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;
const ACTION_FILE = `${HERE}revoke-action.ts`;
const REF_CLIENT_FILE = fileURLToPath(new URL("../../../lib/ref-client.ts", import.meta.url));

const FORM_ACTION_RE = /action=\{revokePackageAction\}/;
const CONFIRM_FIELD_RE = /name="confirm_revoke"/;
const CHILD_HREF_RE = /\/dashboard\/grants\/\$\{encodeURIComponent\(child\.grant_id\)\}/;
const FORBIDDEN_FIELDS_RE = /\b(access_token|refresh_token|token_hash|package_secret|client_secret)\b/;
const PACKAGE_ID_DECODE_RE = /decodeURIComponent\(raw\)/;

const SERVER_DIRECTIVE_RE = /^"use server"/;
const REQUIRE_ACCESS_RE = /requireDashboardAccess\(/;
const CONFIRM_GUARD_RE = /confirm\s*!==\s*"yes"|confirm\s*===\s*"yes"/;
const REVOKE_CALL_RE = /revokeGrantPackage\(\s*packageId\s*\)/;
const PARTIAL_FAILURE_IMPORT_RE = /GrantPackageRevokePartialFailureError/;
const PARTIAL_FAILURE_BRANCH_RE = /err\s+instanceof\s+GrantPackageRevokePartialFailureError/;
const REF_REQUEST_BODY_RE = /class RefRequestError[\s\S]*readonly bodyText: string/;
const PARTIAL_FAILURE_PARSE_RE =
  /parsed\.object\s*!==\s*"grant_package_revoke_result"[\s\S]*parsed\.status\s*!==\s*"partial_failure"/;
const PARTIAL_FAILURE_THROW_RE = /throw new GrantPackageRevokePartialFailureError\(result\)/;
const PARTIAL_FAILURE_COPY_RE = /Package remains active/;
const CUMULATIVE_FETCH_RE = /getCumulativeClientAccess\(packageId\)/;
const CUMULATIVE_SECTION_RE = /title="Cumulative client access"/;
const CUMULATIVE_EXPERIMENTAL_RE = /Reference-experimental/;
const CUMULATIVE_LINEAGE_LINK_RE = /\/dashboard\/grants\/packages\/\$\{encodeURIComponent\(member\.package_id\)\}/;
const PARENT_LINK_RE = /\/dashboard\/grants\/packages\/\$\{encodeURIComponent\(pkg\.parent_package_id\)\}/;
const CUMULATIVE_IFACE_RE = /export interface CumulativeClientAccess/;
const CUMULATIVE_FN_RE = /export async function getCumulativeClientAccess/;
const PARENT_FIELD_RE = /parent_package_id: string \| null/;

test("package detail page wires its revoke form to the server action with a confirm_revoke field", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, FORM_ACTION_RE);
  assert.match(src, CONFIRM_FIELD_RE);
});

test("package detail page round-trips the package id through decodeURIComponent on the URL segment", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, PACKAGE_ID_DECODE_RE);
});

test("package detail page links children to grant detail pages with encodeURIComponent", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, CHILD_HREF_RE);
});

test("package detail page never renders secret-shaped fields", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.doesNotMatch(src, FORBIDDEN_FIELDS_RE);
});

test("revoke server action declares 'use server' and re-verifies the owner session", async () => {
  const src = await readFile(ACTION_FILE, "utf8");
  assert.match(src, SERVER_DIRECTIVE_RE);
  assert.match(src, REQUIRE_ACCESS_RE);
});

test("revoke server action enforces confirm_revoke=yes before calling revokeGrantPackage", async () => {
  const src = await readFile(ACTION_FILE, "utf8");
  assert.match(src, CONFIRM_GUARD_RE);
  assert.match(src, REVOKE_CALL_RE);
  // The confirm guard MUST appear before the revoke call in source order;
  // otherwise the revoke helper would run even on unconfirmed submissions.
  const confirmIdx = src.search(CONFIRM_GUARD_RE);
  const revokeIdx = src.search(REVOKE_CALL_RE);
  assert.ok(confirmIdx >= 0 && revokeIdx >= 0);
  assert.ok(confirmIdx < revokeIdx, "confirm_revoke guard must precede the revokeGrantPackage call in source order");
});

test("package detail page renders the reference-experimental cumulative per-client lineage view", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, CUMULATIVE_FETCH_RE, "page must fetch the cumulative client access view");
  assert.match(src, CUMULATIVE_SECTION_RE, "page must render a cumulative client access section");
  assert.match(src, CUMULATIVE_EXPERIMENTAL_RE, "cumulative view must carry the reference-experimental label");
  assert.match(src, CUMULATIVE_LINEAGE_LINK_RE, "lineage members must link to their own package detail pages");
  assert.match(src, PARENT_LINK_RE, "a linked package must surface a pivot to its parent package");
});

test("ref-client exposes a typed cumulative client access surface", async () => {
  const refClientSrc = await readFile(REF_CLIENT_FILE, "utf8");
  assert.match(refClientSrc, CUMULATIVE_IFACE_RE);
  assert.match(refClientSrc, CUMULATIVE_FN_RE);
  assert.match(refClientSrc, PARENT_FIELD_RE);
});

test("revoke flow preserves package partial-failure details for the operator", async () => {
  const actionSrc = await readFile(ACTION_FILE, "utf8");
  assert.match(actionSrc, PARTIAL_FAILURE_IMPORT_RE);
  assert.match(actionSrc, PARTIAL_FAILURE_BRANCH_RE);

  const refClientSrc = await readFile(REF_CLIENT_FILE, "utf8");
  assert.match(refClientSrc, REF_REQUEST_BODY_RE);
  assert.match(refClientSrc, PARTIAL_FAILURE_PARSE_RE);
  assert.match(refClientSrc, PARTIAL_FAILURE_THROW_RE);
  assert.match(refClientSrc, PARTIAL_FAILURE_COPY_RE);
});
