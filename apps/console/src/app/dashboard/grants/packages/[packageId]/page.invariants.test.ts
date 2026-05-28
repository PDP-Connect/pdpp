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

const FORM_ACTION_RE = /action=\{revokePackageAction\}/;
const CONFIRM_FIELD_RE = /name="confirm_revoke"/;
const CHILD_HREF_RE = /\/dashboard\/grants\/\$\{encodeURIComponent\(child\.grant_id\)\}/;
const FORBIDDEN_FIELDS_RE = /\b(access_token|refresh_token|token_hash|package_secret|client_secret)\b/;
const PACKAGE_ID_DECODE_RE = /decodeURIComponent\(raw\)/;

const SERVER_DIRECTIVE_RE = /^"use server"/;
const REQUIRE_ACCESS_RE = /requireDashboardAccess\(/;
const CONFIRM_GUARD_RE = /confirm\s*!==\s*"yes"|confirm\s*===\s*"yes"/;
const REVOKE_CALL_RE = /revokeGrantPackage\(\s*packageId\s*\)/;

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
  assert.ok(
    confirmIdx < revokeIdx,
    "confirm_revoke guard must precede the revokeGrantPackage call in source order",
  );
});
