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
  /derivePrimaryRowAction[\s\S]*type PrimaryRowAction[\s\S]*from "\.\.\/\.\.\/lib\/connection-evidence\.ts"/;
const DERIVES_PRIMARY_ACTION = /const primaryAction = derivePrimaryRowAction\(\{/;
const PRIMARY_ACTION_KEYS_RAW_HEALTH = /derivePrimaryRowAction\(\{[\s\S]{0,220}health:/;
const SYNC_ACTION_LABEL_FROM_LAST_RUN = /const syncIdleLabel = syncActionIdleLabel\(overview\.lastRun\?\.status\)/;
const SYNC_BUTTON_RECEIVES_IDLE_LABEL = /idleLabel=\{syncIdleLabel\}/;
const RENDERED_VERDICT_ACTION_HELPER = /function primaryRenderedAction\(verdict: RefRenderedVerdict \| null\)/;
const RENDERED_VERDICT_HEADER_ACTION = /function RenderedVerdictHeaderAction/;
const RENDERED_VERDICT_ACTION_TESTID = /data-testid="detail-action-rendered-verdict"/;
const RENDERED_VERDICT_STATUS_TESTID = /data-testid="detail-action-rendered-verdict-status"/;
// A device-local add_info recovery is NOT navigable — it must render as
// non-clickable guidance pointing to the Diagnostics commands, never a <Link>
// to /runs (which sent the owner in a hero→panel→runs→panel circle).
const DEVICE_LOCAL_GUARD = /action\.remediation\?\.target\.kind === "local_device"/;
const DEVICE_LOCAL_TESTID = /data-testid="detail-action-rendered-verdict-device-local"/;
const RENDERED_VERDICT_ACTION_PRECEDES_SYNC =
  /const renderedAction = primaryRenderedAction\(renderedVerdict\);[\s\S]*if \(renderedAction\)[\s\S]*if \(primaryAction\.kind === "sync"\)/;
const SYNC_BRANCH_GUARD = /if \(primaryAction\.kind === "sync"\)/;
const COOLDOWN_BRANCH_GUARD = /if \(primaryAction\.kind === "cooldown_wait"\)/;
const COOLDOWN_FORCE_BUTTON = /<SyncNowButton[\s\S]{0,260}force[\s\S]{0,260}idleLabel="Force run anyway"/;
const FORCE_BUTTON_WARNING = /Bypasses the provider-pressure cooldown/;
const MANUAL_UPLOAD_IMPORT_LINK = /Add another export/;
const MANUAL_UPLOAD_REPROCESS_BUTTON = /idleLabel="Reprocess all exports"/;
const MANUAL_UPLOAD_RUNNING_LABEL = /runningLabel="Import running"/;
const NON_SYNC_NOTICE = /return <PrimaryActionNotice action=\{primaryAction\} \/>/;
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
  assert.doesNotMatch(src, PRIMARY_ACTION_KEYS_RAW_HEALTH);
});

test("detail page labels failed owner syncs as retryable", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, SYNC_ACTION_LABEL_FROM_LAST_RUN);
  assert.match(src, SYNC_BUTTON_RECEIVES_IDLE_LABEL);
});

test("rendered verdict owner action owns the header before generic sync fallback", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RENDERED_VERDICT_ACTION_HELPER);
  assert.match(src, RENDERED_VERDICT_HEADER_ACTION);
  assert.match(src, RENDERED_VERDICT_ACTION_TESTID);
  assert.match(src, RENDERED_VERDICT_STATUS_TESTID);
  assert.match(src, RENDERED_VERDICT_ACTION_PRECEDES_SYNC);
});

test("SyncNowButton renders only inside owner-actionable branches", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, SYNC_BRANCH_GUARD);
  // Four render sites are allowed: the rendered-verdict repair action,
  // ordinary sync, manual-upload reprocess nested under the owner-syncable
  // branch, and the separately-named force override nested under cooldown.
  const renders = src.match(/<SyncNowButton/g) ?? [];
  assert.equal(
    renders.length,
    4,
    "expected rendered-verdict repair, ordinary sync, manual reprocess, and cooldown force render sites"
  );
  assert.match(src, MANUAL_UPLOAD_IMPORT_LINK);
  assert.match(src, MANUAL_UPLOAD_REPROCESS_BUTTON);
  assert.match(src, MANUAL_UPLOAD_RUNNING_LABEL);
  assert.match(src, COOLDOWN_BRANCH_GUARD);
  assert.match(src, COOLDOWN_FORCE_BUTTON);
  assert.match(src, FORCE_BUTTON_WARNING);
});

test("push-mode connections get an honest non-clickable notice, not a dead button", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, NON_SYNC_NOTICE);
  assert.match(src, DEVICE_WAIT_NOTICE_TESTID);
});

test("a device-local add_info recovery renders non-clickable guidance, not a /runs link", async () => {
  // The loop bug: clicking a device-local recovery action on the detail header
  // navigated to /runs, which showed the same button, which linked back — a
  // circle, because the dashboard cannot run a device command. The add_info
  // branch must guard on the local_device remediation target and render the
  // non-clickable guidance span instead.
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, DEVICE_LOCAL_GUARD);
  assert.match(src, DEVICE_LOCAL_TESTID);
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
