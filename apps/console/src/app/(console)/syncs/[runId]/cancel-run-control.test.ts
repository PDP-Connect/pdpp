/**
 * Structural coverage for the console run-cancel control (task 4.2).
 *
 * Like `rename-connection.test.ts`, the control is a client component with
 * hooks (`useTransition` / `useState`) and this app has no JSX render harness
 * (no jsdom / testing-library in the repo). So we assert — via source regex —
 * that the wiring matches the `add-console-run-cancel-control` contract:
 *   - the control renders only while the run is active (page gating on the
 *     existing `active` computation inside `beforeTimeline`);
 *   - clicking requires an explicit confirmation step — it never cancels on the
 *     first click;
 *   - confirming calls `cancelRunAction(runId)`;
 *   - the copy states it stops ONLY the current run and preserves records /
 *     schedule / grants / configuration, distinct from revoke / delete;
 *   - the three outcomes render their distinct copy (202 → "cancellation
 *     requested…"; 409/404 → "already reached a terminal state").
 *
 * The server action's discriminated-union wiring is asserted too: it
 * re-verifies dashboard access, revalidates the run detail route, and maps the
 * raced-terminal / unreachable outcomes to `{ ok: false, kind }`.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CONTROL_FILE = `${HERE}cancel-run-control.tsx`;
const ACTIONS_FILE = `${HERE}actions.ts`;
const PAGE_FILE = `${HERE}page.tsx`;

// ── Page: render only when active, inside beforeTimeline ──────────────────────

const PAGE_IMPORTS_CONTROL_RE = /import \{ CancelRunControl \} from "\.\/cancel-run-control\.tsx"/;
const PAGE_GATES_ON_ACTIVE_RE = /\{active \? <CancelRunControl runId=\{runId\} \/> : null\}/;

test("run detail page renders the cancel control only when the run is active", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, PAGE_IMPORTS_CONTROL_RE);
  assert.match(src, PAGE_GATES_ON_ACTIVE_RE);
  // The gate must live inside the before-timeline fragment that is handed to
  // TimelineDetailView's `beforeTimelineContent` slot. The fragment is defined
  // (`const beforeTimeline = (`) before it is passed (`beforeTimelineContent={`),
  // and the active-gated control sits inside that fragment definition.
  const fragmentDefAt = src.indexOf("const beforeTimeline = (");
  const slotPassAt = src.indexOf("beforeTimelineContent={");
  const gateAt = src.search(PAGE_GATES_ON_ACTIVE_RE);
  assert.ok(fragmentDefAt >= 0, "before-timeline fragment must be defined");
  assert.ok(slotPassAt > fragmentDefAt, "fragment must be passed to the beforeTimelineContent slot");
  assert.ok(
    gateAt > fragmentDefAt && gateAt < slotPassAt,
    "the active-gated cancel control must render inside the before-timeline fragment"
  );
});

// ── Control: client component, confirmation step, action call ─────────────────

const CONTROL_IS_CLIENT_RE = /^"use client";/;
const CONTROL_USES_TRANSITION_RE = /useTransition\(\)/;
const CONTROL_HAS_CONFIRM_STATE_RE = /const \[confirming, setConfirming\] = useState/;
// First click only opens the confirm step; it does NOT call the action.
const CONTROL_FIRST_CLICK_CONFIRMS_RE = /onClick=\{\(\) => \{\s*setResult\(null\);\s*setConfirming\(true\);\s*\}\}/;
// The action is only called from the dedicated confirm handler.
const CONTROL_CONFIRM_CALLS_ACTION_RE = /const next = await cancelRunAction\(runId\)/;
const CONTROL_CONFIRM_HANDLER_RE = /function handleConfirm\(\)/;
const CALLS_ACTION_RE = /cancelRunAction/;

// Non-destructive copy distinct from revoke / delete.
const COPY_STOPS_CURRENT_RUN_RE = /stops only the current run/i;
const COPY_RECORDS_RE = /records/i;
const COPY_SCHEDULE_RE = /schedule/i;
const COPY_GRANTS_RE = /grants/i;
const COPY_CONFIGURATION_RE = /configuration/i;
const COPY_REVOKING_RE = /revoking/i;
const COPY_DELETING_RE = /deleting/i;

// Outcome copy.
const OUTCOME_REQUESTED_RE = /Cancellation requested — the run will stop shortly\./;
const OUTCOME_TERMINAL_RE = /already reached a terminal state/i;
const OUTCOME_ALREADY_TERMINAL_KIND_RE = /already_terminal/;
const OUTCOME_NO_ACTIVE_RUN_KIND_RE = /no_active_run/;
const CONTROL_REFRESHES_RE = /router\.refresh\(\)/;

const ACTION_IS_SERVER_RE = /^"use server";/;

test("cancel control is a client component using useTransition + a confirm state", async () => {
  const src = await readFile(CONTROL_FILE, "utf8");
  assert.match(src, CONTROL_IS_CLIENT_RE);
  assert.match(src, CONTROL_USES_TRANSITION_RE);
  assert.match(src, CONTROL_HAS_CONFIRM_STATE_RE);
});

test("cancel control requires an explicit confirmation step before issuing the cancel", async () => {
  const src = await readFile(CONTROL_FILE, "utf8");
  // The primary button only flips into the confirm state.
  assert.match(src, CONTROL_FIRST_CLICK_CONFIRMS_RE);
  // The action is invoked from the confirm handler, not the first-click handler.
  assert.match(src, CONTROL_CONFIRM_HANDLER_RE);
  assert.match(src, CONTROL_CONFIRM_CALLS_ACTION_RE);
  // Guard: cancelRunAction must NOT be called directly from the first-click
  // open handler (no cancel-on-first-click).
  const firstClickBlock = src.slice(src.search(CONTROL_FIRST_CLICK_CONFIRMS_RE));
  const openHandler = firstClickBlock.slice(0, firstClickBlock.indexOf("}}"));
  assert.equal(CALLS_ACTION_RE.test(openHandler), false, "first click must not call the cancel action");
});

// ── Control: non-destructive copy distinct from revoke / delete ───────────────

test("cancel control copy states it stops only the current run and preserves sources/schedule/grants/config", async () => {
  const src = await readFile(CONTROL_FILE, "utf8");
  assert.match(src, COPY_STOPS_CURRENT_RUN_RE);
  assert.match(src, COPY_RECORDS_RE);
  assert.match(src, COPY_SCHEDULE_RE);
  assert.match(src, COPY_GRANTS_RE);
  assert.match(src, COPY_CONFIGURATION_RE);
  // Distinct from revoke and delete.
  assert.match(src, COPY_REVOKING_RE);
  assert.match(src, COPY_DELETING_RE);
});

// ── Control: the three outcomes render distinct copy ──────────────────────────

test("cancel control reflects the 202 outcome as a cancellation-requested message", async () => {
  const src = await readFile(CONTROL_FILE, "utf8");
  assert.match(src, OUTCOME_REQUESTED_RE);
});

test("cancel control reflects 409/404 as the run already reaching a terminal state", async () => {
  const src = await readFile(CONTROL_FILE, "utf8");
  assert.match(src, OUTCOME_TERMINAL_RE);
  // It branches on the discriminated outcome kinds.
  assert.match(src, OUTCOME_ALREADY_TERMINAL_KIND_RE);
  assert.match(src, OUTCOME_NO_ACTIVE_RUN_KIND_RE);
});

test("cancel control refreshes the route after a resolved outcome so the now-terminal status shows", async () => {
  const src = await readFile(CONTROL_FILE, "utf8");
  assert.match(src, CONTROL_REFRESHES_RE);
});

// ── Server action: discriminated union, access re-check, revalidate ───────────

const ACTION_SIGNATURE_RE = /export async function cancelRunAction\(runId: string\): Promise<CancelRunActionResult>/;
const ACTION_UNION_RE =
  /\{ ok: true; status: CancelRunOutcome \}\s*\|\s*\{\s*ok: false;\s*kind: "already_terminal" \| "no_active_run" \| "unreachable" \| "error";\s*message: string;\s*\}/;
const ACTION_REQUIRES_ACCESS_RE = /await requireDashboardAccess\(/;
const ACTION_CALLS_CANCEL_RE = /await cancelRun\(trimmed\)/;
const ACTION_REVALIDATES_RE = /revalidatePath\(`\/syncs\/\$\{trimmed\}`\)/;
const ACTION_HANDLES_UNREACHABLE_RE =
  /if \(err instanceof ReferenceServerUnreachableError\) \{\s*return \{ ok: false, kind: "unreachable"/;

test("cancelRunAction is a use-server action returning a discriminated union", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, ACTION_IS_SERVER_RE);
  assert.match(src, ACTION_SIGNATURE_RE);
  assert.match(src, ACTION_UNION_RE);
});

test("cancelRunAction re-verifies dashboard access, calls cancelRun, and revalidates the run detail route", async () => {
  // CVE-2025-29927: every Server Action must re-check the session.
  const src = await readFile(ACTIONS_FILE, "utf8");
  const block = src.slice(src.indexOf("export async function cancelRunAction"));
  assert.match(block, ACTION_REQUIRES_ACCESS_RE);
  assert.match(block, ACTION_CALLS_CANCEL_RE);
  assert.match(block, ACTION_REVALIDATES_RE);
});

test("cancelRunAction maps an unreachable reference server to a typed in-place outcome", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, ACTION_HANDLES_UNREACHABLE_RE);
});
