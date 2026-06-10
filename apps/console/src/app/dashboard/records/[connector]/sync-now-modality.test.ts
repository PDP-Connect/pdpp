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
 * clickable `SyncNowButton` outside the owner-runnable branch.
 *
 * Why this matters: the records row was made modality-aware (the "false Sync
 * now" honesty fix), but the connection *detail* page rendered `SyncNowButton`
 * unconditionally - gated only by `running`. For a push-mode local-collector
 * connection, that detail-page button reaches a dead remote-run path, so the
 * owner only learns the action is invalid after clicking. This suite fails if
 * the detail page regresses to an unconditional Sync now.
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
const SYNC_ACTION_LABEL_FROM_LAST_RUN = /const syncIdleLabel = syncActionIdleLabel\(overview\.lastRun\?\.status\)/;
const SYNC_BUTTON_RECEIVES_IDLE_LABEL = /idleLabel=\{syncIdleLabel\}/;
const SYNC_BRANCH_GUARD = /primaryAction\.kind === "sync" \? \(\s*<SyncNowButton/;
const NON_SYNC_NOTICE = /\) : \(\s*<PrimaryActionNotice action=\{primaryAction\} \/>/;
const DEVICE_WAIT_NOTICE_TESTID = /data-testid="detail-action-device-wait"/;
// The "Click Sync now" copy must be gated behind the owner-syncable branch of
// `emptyStreamsHint`, never shown unconditionally for every connection.
const SYNC_HINT_GATED_RE =
  /if \(action\.kind === "sync"\) \{\s*return `No records for this connector yet\. \$\{syncIdleLabel\}/;
const EMPTY_STREAMS_HINT_RECEIVES_IDLE_LABEL = /emptyStreamsHint\(primaryAction, syncIdleLabel\)/;

test("detail page imports the shared primary-action classifier", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, IMPORTS_SHARED_CLASSIFIER);
});

test("detail page derives its primary action from the shared classifier (no scattered string checks)", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, DERIVES_PRIMARY_ACTION);
});

test("detail page labels failed owner syncs as retryable", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, SYNC_ACTION_LABEL_FROM_LAST_RUN);
  assert.match(src, SYNC_BUTTON_RECEIVES_IDLE_LABEL);
});

test("SyncNowButton renders only inside the owner-syncable branch", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, SYNC_BRANCH_GUARD);
  // Exactly one SyncNowButton render site, and it is guarded.
  const renders = src.match(/<SyncNowButton/g) ?? [];
  assert.equal(renders.length, 1, "expected exactly one <SyncNowButton render site");
});

test("push-mode connections get an honest non-clickable notice, not a dead button", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, NON_SYNC_NOTICE);
  assert.match(src, DEVICE_WAIT_NOTICE_TESTID);
});

test("the empty-streams hint gates Sync now copy on the owner-runnable branch", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // The owner-run copy must be gated behind the owner-runnable branch so
  // push-mode connections are not told to click a button they do not have. It
  // also uses the same idle label as the button ("Sync now" / "Retry sync") so
  // failed first attempts do not fall back to stale first-run copy.
  assert.match(src, SYNC_HINT_GATED_RE);
  assert.match(src, EMPTY_STREAMS_HINT_RECEIVES_IDLE_LABEL);
});
