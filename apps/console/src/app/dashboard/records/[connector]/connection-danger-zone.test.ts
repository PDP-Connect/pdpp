/**
 * Structural coverage for the console connection danger zone (revoke + delete).
 *
 * Like `rename-connection.test.ts` / `cancel-run-control.test.ts`, the control
 * is a client component with hooks and this app has no JSX render harness (no
 * jsdom / testing-library). So we assert — via source regex — that the wiring
 * matches the `add-console-connection-revoke-delete-controls` contract:
 *
 *   - the danger zone renders only on the connection detail page, which resolves
 *     a concrete configured connection (catalog-only / unavailable rows
 *     `notFound()` before reaching it), so destructive controls never attach to
 *     a catalog row; a connector type with no addressable connection renders
 *     disabled guidance, not destructive forms;
 *   - revoke copy says records/grants are retained and only future collection
 *     stops, and does NOT claim records are erased;
 *   - delete copy says this connection's records are erased, distinguishes
 *     itself from revoke, and names the active-run / default-account refusals;
 *   - delete requires reproducing the connection id before the destructive
 *     submit enables (client gating) AND the server action enforces the same
 *     (`confirm_delete === connection_id`), revoke enforces `confirm_revoke`;
 *   - the server actions call the shared owner-session client wrappers
 *     (`revokeConnection` / `deleteConnection`), not a duplicate cascade, and
 *     re-verify dashboard access + revalidate.
 *
 * This file imports no app code (source-regex only), so it runs under the
 * `node:test` `run({files})` API with native type-stripping even from the
 * bracketed `[connector]` directory.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DANGER_ZONE_FILE = `${HERE}connection-danger-zone.tsx`;
const ACTIONS_FILE = `${HERE}actions.ts`;
const PAGE_FILE = `${HERE}page.tsx`;

const PAGE_RESOLVES_CONNECTION_RE = /resolveConnectionForRecordsRoute/;
const PAGE_NOT_FOUND_RE = /notFound\(\)/;
const PAGE_RENDERS_DANGER_ZONE_RE = /<ConnectionDangerZone/;
const PAGE_ADDRESSES_RESOLVED_RE = /connectionId=\{connectorInstanceId \?\? connectionId\}/;

const DZ_NULL_GUARD_RE = /connectionId === null/;
const DZ_NULL_GUIDANCE_RE = /nothing to revoke or delete/i;
const DZ_REVOKE_RETAINED_RE = /retained/i;
const DZ_REVOKE_FUTURE_RE = /future collection/i;
const DZ_REVOKE_NO_ERASE_RE = /does not erase anything/i;
const DZ_DELETE_ERASES_RE = /[Ee]rases this connection's records/;
const DZ_DELETE_NOT_REVOKE_RE = /not revoke/i;
const DZ_DELETE_RUN_REFUSAL_RE = /run is in flight|run in flight|a run is in flight/i;
const DZ_DELETE_DEFAULT_ACCOUNT_RE = /default-account/i;
const DZ_DELETE_CONFIRMED_RE = /const confirmed = typed === connectionId/;
const DZ_DELETE_DISABLED_RE = /disabled=\{!confirmed\}/;
const DZ_DESTRUCTIVE_VARIANT_RE = /variant="destructive"/;
const DZ_CONFIRM_DELETE_FIELD_RE = /name="confirm_delete"/;
const DZ_REVOKE_ACTION_RE = /action=\{revokeConnectionAction\}/;
const DZ_CONFIRM_REVOKE_FIELD_RE = /name="confirm_revoke"/;
const DZ_CONNECTION_ID_FIELD_RE = /name="connection_id"/;
const DZ_DELETE_ACTION_RE = /action=\{deleteConnectionAction\}/;

const ACT_REVOKE_FN_RE = /export async function revokeConnectionAction/;
const ACT_DELETE_FN_RE = /export async function deleteConnectionAction/;
const ACT_REQUIRE_ACCESS_RE = /requireDashboardAccess/;
const ACT_CONFIRM_REVOKE_RE = /confirm_revoke/;
const ACT_CONFIRM_REVOKE_GUARD_RE = /confirm !== "yes"/;
const ACT_CONFIRM_DELETE_GUARD_RE = /confirm !== connectionId/;
const ACT_CALLS_REVOKE_WRAPPER_RE = /await revokeConnection\(connectionId\)/;
const ACT_CALLS_DELETE_WRAPPER_RE = /await deleteConnection\(connectionId\)/;
const ACT_REVALIDATE_RE = /revalidatePath\("\/dashboard\/records"\)/;
const ACT_RUN_ACTIVE_RE = /result\.status === "run_active"/;
const ACT_DEFAULT_ACCOUNT_RE = /result\.status === "default_account"/;
const ACT_DELETE_REDIRECT_LIST_RE = /redirect\(recordsListHref\(message \?\? "Connection deleted\."\)\)/;
const ACT_REVOKE_REDIRECT_LIST_RE = /redirect\(error \? dangerZoneHref\(routeId, message, error\) : recordsListHref\(message\)\)/;
const ACT_DANGER_ANCHOR_RE = /#danger-zone/;

async function read(file: string): Promise<string> {
  return await readFile(file, "utf8");
}

test("the danger zone is rendered on the resolved connection detail page", async () => {
  const page = await read(PAGE_FILE);
  assert.match(page, PAGE_RESOLVES_CONNECTION_RE);
  assert.match(page, PAGE_NOT_FOUND_RE);
  assert.match(page, PAGE_RENDERS_DANGER_ZONE_RE);
  assert.match(page, PAGE_ADDRESSES_RESOLVED_RE);
});

test("a connector with no addressable connection renders disabled guidance, not destructive forms", async () => {
  const dz = await read(DANGER_ZONE_FILE);
  assert.match(dz, DZ_NULL_GUARD_RE);
  assert.match(dz, DZ_NULL_GUIDANCE_RE);
});

test("revoke copy retains records and stops only future collection, never claims erasure", async () => {
  const dz = await read(DANGER_ZONE_FILE);
  assert.match(dz, DZ_REVOKE_RETAINED_RE);
  assert.match(dz, DZ_REVOKE_FUTURE_RE);
  assert.match(dz, DZ_REVOKE_NO_ERASE_RE);
});

test("delete copy erases this connection, distinguishes from revoke, names the refusals", async () => {
  const dz = await read(DANGER_ZONE_FILE);
  assert.match(dz, DZ_DELETE_ERASES_RE);
  assert.match(dz, DZ_DELETE_NOT_REVOKE_RE);
  assert.match(dz, DZ_DELETE_RUN_REFUSAL_RE);
  assert.match(dz, DZ_DELETE_DEFAULT_ACCOUNT_RE);
});

test("delete requires reproducing the connection id before the destructive submit enables", async () => {
  const dz = await read(DANGER_ZONE_FILE);
  assert.match(dz, DZ_DELETE_CONFIRMED_RE);
  assert.match(dz, DZ_DELETE_DISABLED_RE);
  assert.match(dz, DZ_DESTRUCTIVE_VARIANT_RE);
  assert.match(dz, DZ_CONFIRM_DELETE_FIELD_RE);
});

test("revoke uses a confirm checkbox and the shared revoke action", async () => {
  const dz = await read(DANGER_ZONE_FILE);
  assert.match(dz, DZ_REVOKE_ACTION_RE);
  assert.match(dz, DZ_CONFIRM_REVOKE_FIELD_RE);
  assert.match(dz, DZ_CONNECTION_ID_FIELD_RE);
});

test("delete form posts the shared delete action with the connection id", async () => {
  const dz = await read(DANGER_ZONE_FILE);
  assert.match(dz, DZ_DELETE_ACTION_RE);
  assert.match(dz, DZ_CONNECTION_ID_FIELD_RE);
});

test("server actions re-verify access, enforce confirmation server-side, and call the shared wrappers", async () => {
  const actions = await read(ACTIONS_FILE);
  assert.match(actions, ACT_REVOKE_FN_RE);
  assert.match(actions, ACT_DELETE_FN_RE);
  assert.match(actions, ACT_REQUIRE_ACCESS_RE);
  assert.match(actions, ACT_CONFIRM_REVOKE_RE);
  assert.match(actions, ACT_CONFIRM_REVOKE_GUARD_RE);
  assert.match(actions, ACT_CONFIRM_DELETE_GUARD_RE);
  assert.match(actions, ACT_CALLS_REVOKE_WRAPPER_RE);
  assert.match(actions, ACT_CALLS_DELETE_WRAPPER_RE);
  assert.match(actions, ACT_REVALIDATE_RE);
});

test("the delete action surfaces each typed refusal in place rather than a generic boundary", async () => {
  const actions = await read(ACTIONS_FILE);
  assert.match(actions, ACT_RUN_ACTIVE_RE);
  assert.match(actions, ACT_DEFAULT_ACCOUNT_RE);
  assert.match(actions, ACT_DELETE_REDIRECT_LIST_RE);
  assert.match(actions, ACT_DANGER_ANCHOR_RE);
});

test("successful revoke redirects to the visible connections list instead of a now-revoked detail URL", async () => {
  const actions = await read(ACTIONS_FILE);
  assert.match(actions, ACT_REVOKE_REDIRECT_LIST_RE);
});
