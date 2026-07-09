/**
 * Structural coverage for the console connection-rename wiring.
 *
 * Like `connector-row.test.ts`, the live UI is a client component with hooks
 * and the app has no JSX render harness, so we assert that the source wires
 * the rename path the way the brief requires:
 *  - the mutation targets a concrete connection (`connection_id`), never a
 *    connector type;
 *  - the action validates a non-empty, length-bounded label and returns a
 *    discriminated result (no redirect that would drop the message);
 *  - the inline island re-seeds from server-confirmed state and refreshes;
 *  - the row surfaces a "label needed" hint only behind the list-supplied
 *    `labelNeeded` prop (decided by the cross-row ambiguity rule in
 *    `lib/connection-label-ambiguity.ts`, not the row itself) so a lone
 *    connection of a type is never nagged and loading/empty states cannot
 *    invent a false prompt.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ACTIONS_FILE = `${HERE}actions.ts`;
const ISLAND_FILE = `${HERE}rename-connection.tsx`;
const PAGE_FILE = `${HERE}page.tsx`;

const ACTION_SIGNATURE_RE =
  /export async function renameConnectionAction\(\s*connectionId: string \| null,\s*displayName: string\s*\): Promise<RenameConnectionResult>/;
const ACTION_REQUIRES_ACCESS_RE = /await requireDashboardAccess\(/;
const ACTION_GUARDS_CONNECTION_RE = /if \(!connectionId\)/;
const ACTION_GUARDS_EMPTY_RE = /if \(!trimmed\)/;
const ACTION_GUARDS_LENGTH_RE = /MAX_DISPLAY_NAME_LENGTH/;
const ACTION_CALLS_STORE_RE = /setConnectionDisplayName\(connectionId, trimmed\)/;
const ACTION_REVALIDATES_RE = /revalidatePath\("\/sources"\)/;
const ACTION_RETURNS_OK_RE = /return \{ ok: true, display_name: trimmed \}/;
const ACTION_REDIRECT_RE = /redirect\(/;

const ISLAND_RESEEDS_RE = /useEffect\(\(\) => \{\s*setValue\(currentLabel\);\s*\}, \[currentLabel\]\)/;
const ISLAND_REFRESHES_RE = /router\.refresh\(\)/;
const ISLAND_DISABLES_EMPTY_RE = /disabled=\{isPending \|\| !value\.trim\(\)\}/;
const ISLAND_HIDES_WHEN_NULL_RE = /if \(connectionId === null\) \{\s*return null;\s*\}/;

const PAGE_SEED_RE = /isFallbackConnectionLabel\(\{[\s\S]*?\}\)\s*\?\s*""\s*:\s*\(summary\.display_name \?\? ""\)/;
const PAGE_RENDERS_ISLAND_RE = /<RenameConnection/;

test("rename action takes a connection_id and display_name and returns a result", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, ACTION_SIGNATURE_RE);
});

test("rename action re-verifies dashboard access before mutating", async () => {
  // CVE-2025-29927: every Server Action must re-check the session.
  const src = await readFile(ACTIONS_FILE, "utf8");
  const block = src.slice(src.indexOf("renameConnectionAction"));
  assert.match(block, ACTION_REQUIRES_ACCESS_RE);
});

test("rename action rejects an empty or absent connection and empty labels", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  const block = src.slice(src.indexOf("renameConnectionAction"), src.indexOf("saveConnectorScheduleAction"));
  assert.match(block, ACTION_GUARDS_CONNECTION_RE);
  assert.match(block, ACTION_GUARDS_EMPTY_RE);
  assert.match(block, ACTION_GUARDS_LENGTH_RE);
});

test("rename action calls the connection-scoped store mutation and revalidates", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  const block = src.slice(src.indexOf("renameConnectionAction"), src.indexOf("saveConnectorScheduleAction"));
  assert.match(block, ACTION_CALLS_STORE_RE);
  assert.match(block, ACTION_REVALIDATES_RE);
});

test("rename action returns rather than redirects on success so the message survives", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  const block = src.slice(src.indexOf("renameConnectionAction"), src.indexOf("saveConnectorScheduleAction"));
  assert.match(block, ACTION_RETURNS_OK_RE);
  // No redirect inside the rename action body (the schedule actions redirect;
  // this one must not, or the toast is lost).
  assert.equal(ACTION_REDIRECT_RE.test(block), false);
});

test("rename island re-seeds from the server-confirmed label and refreshes the route", async () => {
  const src = await readFile(ISLAND_FILE, "utf8");
  assert.match(src, ISLAND_RESEEDS_RE);
  assert.match(src, ISLAND_REFRESHES_RE);
});

test("rename island disables save on an empty label", async () => {
  const src = await readFile(ISLAND_FILE, "utf8");
  assert.match(src, ISLAND_DISABLES_EMPTY_RE);
});

test("rename island hides itself when there is no addressable connection", async () => {
  const src = await readFile(ISLAND_FILE, "utf8");
  assert.match(src, ISLAND_HIDES_WHEN_NULL_RE);
});

// The "label needed" hint's cross-row ambiguity rule (a fallback label like
// "Amazon" is only worth nagging when two or more unnamed connections of the
// same connector type exist, so a lone connection is never nagged) lived in
// the now-deleted `connector-row.tsx` (Wave 10a/10b, 2026-07-09 state-model
// convergence — that whole component was unimported dead code). The ambiguity
// computation itself is covered directly in `lib/connection-label-ambiguity.test.ts`.
// The live Sources list does not currently render an inline "label needed"
// hint at all; re-adding one is out of this tranche's scope.

test("detail page seeds the rename field blank for fallback labels", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // Fallback → "" seed; owner-set → the stored display_name.
  assert.match(src, PAGE_SEED_RE);
  assert.match(src, PAGE_RENDERS_ISLAND_RE);
});
