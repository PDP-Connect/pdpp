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
const ACTIONABILITY_PROJECTION = /const actionability = projectSourceActionability\(summary\)/;
const RENDERED_VERDICT_ACTION_FROM_PROJECTION = /connectionPrimaryAction: actionability\.primaryAction/;
const RENDERED_VERDICT_HEADER_ACTION = /function RenderedVerdictHeaderAction/;
const RENDERED_VERDICT_ACTION_TESTID = /data-testid="detail-action-rendered-verdict"/;
const RENDERED_OWNER_ACTION_GUARD =
  /const renderedOwnerAction =\s*renderedAction && renderedAction\.audience === "owner" && renderedAction\.satisfied_when\.kind !== "none"\s*\? renderedAction\s*: null;/;
const NON_OWNER_HEADER_ACTIONS_RETURN_NULL =
  /if \(action\.audience !== "owner" \|\| action\.satisfied_when\.kind === "none"\) \{\s*return null;\s*\}/;
const EXACT_SYNC_TARGET_GUARD = /action\.target\?\.kind !== "sync"/;
const EXACT_SYNC_RUN_HREF = /href=\{`\/syncs\/\$\{encodeURIComponent\(action\.target\.run_id\)\}`\}/;
const EXACT_SYNC_LINK_LABEL = /\{action\.cta\}/;
const EXACT_SYNC_LINK_NO_TITLE = /title="Open the exact sync that needs owner input\."/;
const EXACT_SYNC_LINK_NO_GENERIC_FALLBACK = /href=\{syncDetailHref \?\? "\/syncs"\}/;
// A device-local add_info recovery is NOT navigable — it must render as
// non-clickable guidance pointing to the Diagnostics commands, never a <Link>
// to /runs (which sent the owner in a hero→panel→runs→panel circle).
const DEVICE_LOCAL_GUARD = /action\.remediation\?\.target\.kind === "local_device"/;
const DEVICE_LOCAL_TESTID = /data-testid="detail-action-rendered-verdict-device-local"/;
const RENDERED_OWNER_ACTION_PRECEDES_SYNC = /if \(renderedOwnerAction\)[\s\S]*if \(primaryAction\.kind === "sync"\)/;
const SYNC_BRANCH_GUARD = /if \(primaryAction\.kind === "sync"\)/;
const COOLDOWN_BRANCH_GUARD = /if \(primaryAction\.kind === "cooldown_wait"\)/;
const COOLDOWN_FORCE_BUTTON = /<SyncNowButton[\s\S]{0,260}force[\s\S]{0,260}idleLabel="Force run anyway"/;
const FORCE_BUTTON_WARNING = /Bypasses the provider-pressure cooldown/;
const MANUAL_UPLOAD_IMPORT_LINK = /Add another export/;
const MANUAL_UPLOAD_REPROCESS_BUTTON = /idleLabel="Reprocess all exports"/;
const MANUAL_UPLOAD_RUNNING_LABEL = /runningLabel="Import running"/;
const STATIC_SECRET_CAPTURE_RESOLVED_ONCE =
  /const staticSecretCapture = staticSecretCredentialCaptureFromManifest\(manifest\)/;
const STATIC_SECRET_UPDATE_PRECEDES_BROWSER_SESSION =
  /if \(storedCredentialUpdateHref !== null\) \{[\s\S]{0,180}return storedCredentialUpdateHref;[\s\S]{0,180}if \(browserSessionRepairHref !== null\) \{/;
const STATIC_SECRET_UPDATE_CAPABILITY_PASSED =
  /hasStaticSecretCredentialUpdate=\{\s*storedCredentialUpdateHref !== null && !sessionBound && primaryActionSurface !== "stored_credential"\s*\}/;
const STATIC_SECRET_UPDATE_LINK_VISIBLE = /storedCredentialUpdateHref && !revoked && hasStaticSecretCredentialUpdate/;
const NON_SYNC_NOTICE = /return <PrimaryActionNotice action=\{primaryAction\} \/>/;
const DEVICE_WAIT_NOTICE_TESTID = /data-testid="detail-action-device-wait"/;
// The "Click Sync now" copy must be gated behind the owner-syncable branch of
// `emptyStreamsHint`, never shown unconditionally for every connection.
const SYNC_HINT_GATED_RE =
  /if \(action\.kind === "sync"\) \{\s*return `No records for this connector yet\. \$\{syncIdleLabel\}/;
const EMPTY_STREAMS_HINT_RECEIVES_IDLE_LABEL = /emptyStreamsHint\(primaryAction, syncIdleLabel\)/;
const SYNC_BUTTON_FILE = `${HERE}sync-now-button.tsx`;
const SYNC_BUTTON_NO_OPTIMISTIC_RUNNING = /optimisticRunning/;
const SYNC_BUTTON_PENDING_LABEL = /else if \(isPending\) \{\s*buttonLabel = "Starting…";\s*\}/;
const SYNC_BUTTON_SUCCESS_TOAST =
  /markSyncStartToast\([\s\S]*?syncToastScopeId,[\s\S]*?\{\s*message: nextToast\.message,[\s\S]*?runId: nextToast\.runId,[\s\S]*?tone: nextToast\.tone\s*\},[\s\S]*?TOAST_TTL_MS[\s\S]*?\)/;
const SYNC_BUTTON_RUN_LINK =
  /<Link className="underline underline-offset-2" href=\{toastRunHref\}>[\s\S]{0,120}View sync →/;
const SYNC_BUTTON_LONGER_TOAST_TTL = /const TOAST_TTL_MS = 15_000/;
const SYNC_BUTTON_DERIVES_RUN_HREF = /const toastRunHref = syncRunHref\(toast\?\.runId\)/;
const SYNC_BUTTON_NO_REMARK_EFFECT = /markSyncStartToast\(syncToastScopeId, toast, TOAST_TTL_MS\)/;
const SYNC_BUTTON_NO_HYDRATION_STATE = /hasHydrated/;
const REATTACH_SCHEDULE_ACTION_EXPORT = /export async function resumeConnectorScheduleAction\(formData: FormData\)/;
const REATTACH_SCHEDULE_RESUME_CALL =
  /connectionId \? resumeConnectionSchedule\(connectionId\) : resumeConnectorSchedule\(connectorId\)/;

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
  assert.match(src, ACTIONABILITY_PROJECTION);
  assert.match(src, RENDERED_VERDICT_ACTION_FROM_PROJECTION);
  assert.match(src, RENDERED_VERDICT_HEADER_ACTION);
  assert.match(src, RENDERED_VERDICT_ACTION_TESTID);
  assert.match(src, RENDERED_OWNER_ACTION_GUARD);
  assert.match(src, NON_OWNER_HEADER_ACTIONS_RETURN_NULL);
  assert.match(src, RENDERED_OWNER_ACTION_PRECEDES_SYNC);
  assert.match(src, EXACT_SYNC_TARGET_GUARD);
  assert.match(src, EXACT_SYNC_RUN_HREF);
  assert.match(src, EXACT_SYNC_LINK_LABEL);
  assert.doesNotMatch(src, EXACT_SYNC_LINK_NO_TITLE);
  assert.doesNotMatch(src, EXACT_SYNC_LINK_NO_GENERIC_FALLBACK);
});

test("stored-credential sources repair credentials before browser-session fallback", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, STATIC_SECRET_CAPTURE_RESOLVED_ONCE);
  assert.match(src, STATIC_SECRET_UPDATE_PRECEDES_BROWSER_SESSION);
  assert.match(src, STATIC_SECRET_UPDATE_CAPABILITY_PASSED);
  assert.match(src, STATIC_SECRET_UPDATE_LINK_VISIBLE);
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

test("detail Sync now acknowledges accepted starts without stale optimistic running state", async () => {
  const src = await readFile(SYNC_BUTTON_FILE, "utf8");
  assert.doesNotMatch(src, SYNC_BUTTON_NO_OPTIMISTIC_RUNNING);
  assert.doesNotMatch(src, SYNC_BUTTON_NO_REMARK_EFFECT);
  assert.doesNotMatch(src, SYNC_BUTTON_NO_HYDRATION_STATE);
  assert.match(src, SYNC_BUTTON_DERIVES_RUN_HREF);
  assert.match(src, SYNC_BUTTON_PENDING_LABEL);
  assert.match(src, SYNC_BUTTON_SUCCESS_TOAST);
  assert.match(src, SYNC_BUTTON_RUN_LINK);
  assert.match(src, SYNC_BUTTON_LONGER_TOAST_TTL);
});

// Wave 10a: `reattach_schedule` (owner-paused connection with a disabled
// schedule and prior success) must wire to the real schedule-resume server
// action, not fall through to the ordinary Sync now button. Sync now would
// run once but leave the schedule disabled — it does not satisfy the
// action's real contract (`schedule_attached_and_enabled`). Without this
// guard, `reattach_schedule` silently mis-wires to `runConnectorNowAction`
// via the fallthrough branch, a dead end for the schedule itself.
const REATTACH_SCHEDULE_IMPORT = /import \{ resumeConnectorScheduleAction \} from "\.\/actions\.ts";/;
const REATTACH_SCHEDULE_BRANCH_GUARD = /if \(action\.kind === "reattach_schedule"\)/;
const REATTACH_SCHEDULE_FORM_ACTION = /<form action=\{resumeConnectorScheduleAction\}>/;
const REATTACH_SCHEDULE_CONNECTOR_ID_INPUT = /<input name="connector_id" type="hidden" value=\{connectorId\} \/>/;
const REATTACH_SCHEDULE_CONNECTION_ID_INPUT = /<input name="connection_id" type="hidden" value=\{connectionId\} \/>/;
const REATTACH_SCHEDULE_TESTID = /data-testid="detail-action-reattach-schedule"/;
// The branch must appear before the generic SyncNowButton fallthrough so a
// future refactor cannot silently reorder it behind the catch-all.
const REATTACH_SCHEDULE_PRECEDES_SYNC_FALLTHROUGH =
  /if \(action\.kind === "reattach_schedule"\)[\s\S]*return \(\s*<SyncNowButton/;

test("reattach_schedule wires to the real schedule-resume server action, never the sync-now fallthrough", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, REATTACH_SCHEDULE_IMPORT);
  assert.match(src, REATTACH_SCHEDULE_BRANCH_GUARD);
  assert.match(src, REATTACH_SCHEDULE_FORM_ACTION);
  assert.match(src, REATTACH_SCHEDULE_CONNECTOR_ID_INPUT);
  assert.match(src, REATTACH_SCHEDULE_CONNECTION_ID_INPUT);
  assert.match(src, REATTACH_SCHEDULE_TESTID);
  assert.match(src, REATTACH_SCHEDULE_PRECEDES_SYNC_FALLTHROUGH);
});

test("resumeConnectorScheduleAction reaches the real instance-scoped schedule-resume call, not a stub", async () => {
  const src = await readFile(`${HERE}actions.ts`, "utf8");
  assert.match(src, REATTACH_SCHEDULE_ACTION_EXPORT);
  // Instance-scoped resume when a connection_id is present — never silently
  // falls back to the connector-wide resume for a connection-scoped action.
  assert.match(src, REATTACH_SCHEDULE_RESUME_CALL);
});
