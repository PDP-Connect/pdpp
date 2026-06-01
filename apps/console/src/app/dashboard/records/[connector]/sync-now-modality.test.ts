/**
 * Source-text invariants for the connector detail page's modality-aware
 * primary action.
 *
 * `page.tsx` is a server component with no JSX render harness in this app, so
 * we assert the structural properties by reading the source - the same
 * strategy used by `connection-identity.test.ts`, `records-list-view.test.ts`,
 * and `connector-row.test.ts`. The pure decision logic itself
 * (`derivePrimaryRowAction`) is exhaustively unit-tested in
 * `connection-evidence.test.ts`; here we pin only that the detail page routes
 * its primary action through that shared classifier and never renders a
 * clickable `SyncNowButton` outside the owner-syncable branch.
 *
 * Why this matters: the records row was made modality-aware (the "false Sync
 * now" honesty fix), but the connection *detail* page rendered `SyncNowButton`
 * unconditionally - gated only by `running`. For a browser-bound connection
 * (Amazon/Chase/ChatGPT) or a push-mode local-collector connection, that
 * detail-page button reaches the failing `runConnectorNowAction`, so the owner
 * only learns the action is dead after clicking. This suite fails if the
 * detail page regresses to an unconditional Sync now.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

const IMPORTS_SHARED_CLASSIFIER =
  /import \{ (?=[^}]*derivePrimaryRowAction)(?=[^}]*type PrimaryRowAction)[^}]+ \} from "\.\.\/\.\.\/lib\/connection-evidence\.ts"/;
const DERIVES_PRIMARY_ACTION = /const primaryAction = derivePrimaryRowAction\(\{/;
const SYNC_BRANCH_GUARD = /\{primaryAction\.kind === "sync" \? \(\s*<SyncNowButton/;
const NON_SYNC_NOTICE = /\) : \(\s*<PrimaryActionNotice action=\{primaryAction\} \/>/;
const RUNBOOK_NOTICE_TESTID = /data-testid="detail-action-browser-runbook"/;
const DEVICE_WAIT_NOTICE_TESTID = /data-testid="detail-action-device-wait"/;
// The "Click Sync now" copy must be gated behind the owner-syncable branch of
// `emptyStreamsHint`, never shown unconditionally for every connection.
const SYNC_HINT_GATED_RE =
  /if \(action\.kind === "sync"\) \{\s*return "No records for this connector yet\. Click Sync now/;

test("detail page imports the shared primary-action classifier", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, IMPORTS_SHARED_CLASSIFIER);
});

test("detail page derives its primary action from the shared classifier (no scattered string checks)", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, DERIVES_PRIMARY_ACTION);
});

test("SyncNowButton renders only inside the owner-syncable branch", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, SYNC_BRANCH_GUARD);
  // Exactly one SyncNowButton render site, and it is guarded.
  const renders = src.match(/<SyncNowButton/g) ?? [];
  assert.equal(renders.length, 1, "expected exactly one <SyncNowButton render site");
});

test("non-syncable connections get an honest non-clickable notice, not a dead button", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, NON_SYNC_NOTICE);
  assert.match(src, RUNBOOK_NOTICE_TESTID);
  assert.match(src, DEVICE_WAIT_NOTICE_TESTID);
});

test("the empty-streams hint no longer tells every connection to click Sync now", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // The "Click Sync now to pull your first data." copy must be gated behind the
  // owner-syncable branch so browser-bound / push-mode connections are not told
  // to click a button they do not have.
  assert.match(src, SYNC_HINT_GATED_RE);
});
