/**
 * Structural + behavioral coverage for the `next_action` CTA on the
 * connector row.
 *
 * The row itself is a client component with hooks; we don't have a JSX
 * render harness in this app today, so the strategy mirrors
 * `mobile-drawer.test.ts`: assert that the source wires the CTA path
 * the way the brief requires, and verify the underlying contract via
 * the pure formatter (covered separately in `next-action.test.ts`).
 *
 * The cross-cutting invariant is that the row never invents a CTA when
 * `connection_health.next_action` is null — i.e. loading/empty states
 * cannot produce a false action prompt.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { formatNextAction } from "../lib/next-action.ts";
import type { RefNextAction } from "../lib/ref-client.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROW_FILE = `${HERE}connector-row.tsx`;

const FORMAT_NEXT_ACTION_CALL = /formatNextAction\(connectionHealth\?\.next_action \?\? null\)/;
const PILL_USAGE = /<NextActionPill /;
const PILL_CONDITIONAL = /\{nextAction \? <NextActionPill /;
const LINK_GUARD = /formatted\.actionTarget !== null && formatted\.variant === "structured"/;
const PILL_USES_DETAIL_HREF = /href=\{detailHref\}/;
const PILL_LINKS_RAW_TARGET = /href=\{formatted\.actionTarget\}/;
const DETAILS_UNAVAILABLE = /Details unavailable/;
const FRESHNESS_DEVICE_NO_PUSH_TESTID = /data-testid="freshness-device-no-push"/;
const NO_PUSH_RECEIVED_YET = /no push received yet/;

test("connector-row reads next_action from connection_health and renders a pill", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, FORMAT_NEXT_ACTION_CALL);
  assert.match(src, PILL_USAGE);
});

test("connector-row only renders the pill when formatNextAction returns a value", async () => {
  // No truthy CTA → no pill. Prevents false-action rendering during
  // loading (when connectionHealth itself is undefined) and for
  // healthy/idle states (where next_action is null).
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, PILL_CONDITIONAL);
});

test("connector-row guards link target behind structured + non-null action_target", async () => {
  // The schedule_fallback variant must never appear as a clickable
  // target — the spine knows there's something to do but not what.
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, LINK_GUARD);
});

test("connector-row never links to the spine's raw action_target", async () => {
  // The pill must navigate to the safe in-app destination, not the
  // possibly-secret value the spine carried.
  const src = await readFile(ROW_FILE, "utf8");
  // Find the pill body and confirm the Link href is `detailHref`,
  // not `formatted.actionTarget` (which could carry sensitive data).
  const pillBlock = src.slice(src.indexOf("function NextActionPill"));
  assert.match(pillBlock, PILL_USES_DETAIL_HREF);
  assert.equal(PILL_LINKS_RAW_TARGET.test(pillBlock), false);
});

test("structured next_action with link target produces a clickable pill", () => {
  const structured: RefNextAction = {
    action_target: "dashboard",
    attention_id: "att_otp",
    expires_at: null,
    owner_action: "provide_value",
    reason_code: "otp_required",
    response_contract: "response_required",
    source: "structured",
  };
  const formatted = formatNextAction(structured);
  if (!formatted) {
    assert.fail("expected structured CTA");
  }
  assert.equal(formatted.variant, "structured");
  assert.equal(formatted.actionTarget, "dashboard");
  // No caveat on structured: we know exactly what's needed.
  assert.equal(formatted.caveat, null);
});

test("schedule_fallback next_action is caveated and non-clickable", () => {
  const fallback: RefNextAction = {
    action_target: null,
    attention_id: null,
    expires_at: null,
    owner_action: null,
    reason_code: "browser_runtime_not_configured",
    response_contract: null,
    source: "schedule_fallback",
  };
  const formatted = formatNextAction(fallback);
  if (!formatted) {
    assert.fail("expected schedule_fallback CTA");
  }
  assert.equal(formatted.variant, "schedule_fallback");
  // The pill code path requires both a non-null target AND a structured
  // source to render as a link; a fallback CTA is therefore plain text.
  assert.equal(formatted.actionTarget, null);
  assert.match(formatted.caveat ?? "", DETAILS_UNAVAILABLE);
});

test("null action_target on a structured next_action falls back to plain text", () => {
  // Mirrors the secret-sensitive case in connection-health: the spine
  // suppressed action_target. The pill code path must not invent one.
  const structured: RefNextAction = {
    action_target: null,
    attention_id: "att_secret",
    expires_at: null,
    owner_action: "provide_value",
    reason_code: "otp_required",
    response_contract: "response_required",
    source: "structured",
  };
  const formatted = formatNextAction(structured);
  if (!formatted) {
    assert.fail("expected structured CTA");
  }
  assert.equal(formatted.actionTarget, null);
});

test("null next_action surfaces no CTA at all", () => {
  assert.equal(formatNextAction(null), null);
});

// ─── per-state "what next" guidance wiring ────────────────────────────────
//
// When the spine supplies no structured next_action for a non-green state,
// the row must still give the owner a concrete next step. The vocabulary lives
// in `deriveConnectionNextStep` (unit-tested in connection-evidence.test.ts);
// these assertions verify the row consumes it, suppresses it when a structured
// CTA already renders, and links the guidance to the safe detail href rather
// than any raw target.

const DERIVES_NEXT_STEP = /deriveConnectionNextStep\(\{/;
const NEXT_STEP_SUPPRESSED_BY_STRUCTURED = /hasStructuredNextAction: nextAction !== null/;
const NEXT_STEP_SUPPRESSED_BY_DOMINANT = /hasDominantCondition: dominantCondition !== null/;
const NEXT_STEP_SYNC_GATED_ON_PUSH_MODE = /supportsOwnerSync: !overview\.localDeviceProgress/;
const NEXT_STEP_RENDERED = /\{nextStep \? <NextStepGuidanceRow /;
const NEXT_STEP_ROW_LINKS_DETAIL = /href=\{detailHref\}/;
const NEXT_STEP_TESTID = /data-testid="next-step-guidance"/;

test("connector-row derives per-state next-step guidance from the shared helper", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, DERIVES_NEXT_STEP);
});

test("next-step guidance is suppressed when a structured next_action already renders", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, NEXT_STEP_SUPPRESSED_BY_STRUCTURED);
});

test("next-step guidance is wired to suppress when a dominant condition already explains the row", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, NEXT_STEP_SUPPRESSED_BY_DOMINANT);
});

test("next-step Sync now suggestion is gated on the connection not being push-mode", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, NEXT_STEP_SYNC_GATED_ON_PUSH_MODE);
});

test("connector-row renders the next-step guidance row only when guidance exists", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, NEXT_STEP_RENDERED);
});

test("next-step guidance row links to the safe detail href, carries a testid", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  const block = src.slice(src.indexOf("function NextStepGuidanceRow"));
  assert.match(block, NEXT_STEP_ROW_LINKS_DETAIL);
  assert.match(block, NEXT_STEP_TESTID);
});

// ─── stalled-row count-backed scale wiring ────────────────────────────────
//
// The records-list row surfaces a compact count cue ONLY on the stalled-outbox
// next step. The gating + formatting live in `deriveConnectionNextStep`
// (unit-tested in connection-evidence.test.ts); these assertions verify the row
// (1) threads the connection-summary local-device progress into the helper so
// the cue has a count source, and (2) renders the scale only when present,
// inside the detail-linked guidance row — never as a standalone badge.

const NEXT_STEP_THREADS_LOCAL_DEVICE_PROGRESS = /localDeviceProgress: overview\.localDeviceProgress \?\? null/;
const NEXT_STEP_SCALE_GATED = /\{guidance\.scale \?/;
const NEXT_STEP_SCALE_TESTID = /data-testid="next-step-outbox-scale"/;
const NEXT_STEP_SCALE_RENDERS_VALUE = /\{guidance\.scale\}/;

test("connector-row threads connection-summary local-device progress into the next-step helper", async () => {
  // Without this, the stalled-row cue has no count source. The same object also
  // gates supportsOwnerSync, but the helper reads outbox_counts off it for scale.
  const src = await readFile(ROW_FILE, "utf8");
  // The object-literal form `localDeviceProgress: overview.localDeviceProgress
  // ?? null` is unique to the helper call site (JSX props use `=`, not `:`).
  const call = src.slice(src.indexOf("const nextStep = deriveConnectionNextStep({"));
  assert.match(call, NEXT_STEP_THREADS_LOCAL_DEVICE_PROGRESS);
});

test("connector-row renders the stalled-outbox count cue only when a scale is present", async () => {
  // No scale (quiet/healthy/active/unknown rows, or a stalled row with no
  // counts) → no cue. This is the row-level half of the "keep quiet rows quiet"
  // guarantee; the value-level gating is unit-tested in the helper.
  const src = await readFile(ROW_FILE, "utf8");
  const block = src.slice(src.indexOf("function NextStepGuidanceRow"));
  assert.match(block, NEXT_STEP_SCALE_GATED);
  assert.match(block, NEXT_STEP_SCALE_TESTID);
  assert.match(block, NEXT_STEP_SCALE_RENDERS_VALUE);
});

test("the stalled-outbox count cue lives inside the detail-linked guidance row, not a standalone badge", async () => {
  // The cue must point at the existing detail/remediation panel (the row is a
  // Link to detailHref), never invent its own remote fix. We assert the scale
  // span is rendered within the NextStepGuidanceRow Link block.
  const src = await readFile(ROW_FILE, "utf8");
  const block = src.slice(src.indexOf("function NextStepGuidanceRow"), src.indexOf("function StatusDot"));
  const linkStart = block.indexOf("<Link");
  const scaleIndex = block.indexOf('data-testid="next-step-outbox-scale"');
  const detailHrefIndex = block.indexOf("href={detailHref}");
  assert.ok(linkStart >= 0 && detailHrefIndex > linkStart, "guidance row must be a Link to detailHref");
  assert.ok(scaleIndex > detailHrefIndex, "scale cue must render inside the detail-linked guidance Link");
});

// ─── source-pressure backlog cue ──────────────────────────────────────────
//
// The source-pressure paths carry a SEPARATE, gated count cue
// (`guidance.backlogScale`), rendered inside the same detail-linked guidance
// row. It is distinct from the device-outbox scale and uses backlog copy, never
// device copy. Gating + formatting live in `deriveConnectionNextStep`
// (unit-tested in connection-evidence.test.ts); these assert the row renders it
// only when present and never reuses the device "stuck on the device" copy.

const NEXT_STEP_BACKLOG_GATED = /\{guidance\.backlogScale \?/;
const NEXT_STEP_BACKLOG_TESTID = /data-testid="next-step-backlog-scale"/;
const NEXT_STEP_BACKLOG_RENDERS_VALUE = /\{guidance\.backlogScale\}/;
const STUCK_ON_DEVICE_RE = /Stuck on the device/;
const BACKLOG_WORD_RE = /backlog/i;

test("connector-row renders the source-pressure backlog cue only when a backlog scale is present", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  const block = src.slice(src.indexOf("function NextStepGuidanceRow"), src.indexOf("function StatusDot"));
  assert.match(block, NEXT_STEP_BACKLOG_GATED);
  assert.match(block, NEXT_STEP_BACKLOG_TESTID);
  assert.match(block, NEXT_STEP_BACKLOG_RENDERS_VALUE);
});

test("the source-pressure backlog cue uses backlog copy, not the device-outbox copy", async () => {
  // The backlog is scheduler-managed catch-up, not stuck device work — it must
  // never inherit the "Stuck on the device" framing or imply a host command.
  const src = await readFile(ROW_FILE, "utf8");
  const block = src.slice(src.indexOf("function NextStepGuidanceRow"), src.indexOf("function StatusDot"));
  const backlogSpanStart = block.indexOf('data-testid="next-step-backlog-scale"');
  const backlogSpanEnd = block.indexOf("</span>", backlogSpanStart);
  const backlogSpan = block.slice(backlogSpanStart, backlogSpanEnd);
  assert.doesNotMatch(backlogSpan, STUCK_ON_DEVICE_RE);
  assert.match(backlogSpan, BACKLOG_WORD_RE);
});

test("the source-pressure backlog cue renders inside the detail-linked guidance Link", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  const block = src.slice(src.indexOf("function NextStepGuidanceRow"), src.indexOf("function StatusDot"));
  const detailHrefIndex = block.indexOf("href={detailHref}");
  const backlogIndex = block.indexOf('data-testid="next-step-backlog-scale"');
  assert.ok(backlogIndex > detailHrefIndex, "backlog cue must render inside the detail-linked guidance Link");
});

// ─── AxisChipBadge dimension/value rendering ─────────────────────────────
//
// The chip must render dimension (muted) and value (prominent) as
// distinct elements, not collapse them into the opaque `label` string.
// This structural assertion verifies the split rendering is present in
// source and that a screen-reader-only label still carries the full
// `chip.label` so screen readers see both together.

const AXIS_CHIP_RENDERS_DIMENSION = /chip\.dimension/;
const AXIS_CHIP_RENDERS_VALUE = /chip\.value/;
const AXIS_CHIP_SR_ONLY_LABEL = /<span className="sr-only">\{chip\.label\}<\/span>/;
const AXIS_CHIP_VISUAL_SPANS_ARE_HIDDEN =
  /<span aria-hidden className="opacity-60">\s*\{chip\.dimension\}\s*<\/span>[\s\S]*<span aria-hidden className="font-medium">\s*\{chip\.value\}\s*<\/span>/;
test("AxisChipBadge renders chip.dimension and chip.value as separate elements", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  const chipBadgeBlock = src.slice(src.indexOf("function AxisChipBadge"));
  assert.match(chipBadgeBlock, AXIS_CHIP_RENDERS_DIMENSION);
  assert.match(chipBadgeBlock, AXIS_CHIP_RENDERS_VALUE);
});

test("AxisChipBadge uses sr-only chip.label for accessible text", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  const chipBadgeBlock = src.slice(src.indexOf("function AxisChipBadge"));
  assert.match(chipBadgeBlock, AXIS_CHIP_SR_ONLY_LABEL);
});

test("AxisChipBadge hides visual dimension and value from assistive text", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  const chipBadgeBlock = src.slice(src.indexOf("function AxisChipBadge"), src.indexOf("function axisChipClass"));
  assert.match(chipBadgeBlock, AXIS_CHIP_VISUAL_SPANS_ARE_HIDDEN);
});

// ─── 6.1 / 6.5 wiring assertions ───────────────────────────────────────
//
// The row must consume the pure helpers from `connection-evidence.ts`
// rather than reinventing the rules in JSX. These structural assertions
// make the wiring explicit so future edits cannot regress the
// honest-by-default invariants without flipping a test.

const IMPORTS_EVIDENCE_HELPERS =
  /import \{[\s\S]*?formatLastDurableProgress[\s\S]*?formatProjectionFreshness[\s\S]*?resolveRecordCountDisplay[\s\S]*?summarizeAxisChips[\s\S]*?\} from "\.\.\/lib\/connection-evidence\.ts"/;
const USES_RECORD_COUNT_DISPLAY = /resolveRecordCountDisplay\(overview\)/;
const RECORDS_UNAVAILABLE_BRANCH = /recordCount\.label === null/;
const AXIS_CHIPS_STRIP = /data-testid="axis-chip-strip"/;
const PROJECTION_UNRELIABLE_BANNER = /data-testid="projection-unreliable"/;
const FRESHNESS_RESPECTS_ERROR = /hasError=\{Boolean\(overview\.error\)\}/;
const FRESHNESS_UNAVAILABLE_RENDER = /data-testid="freshness-unavailable"/;

test("connector-row imports the connection-evidence helpers", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, IMPORTS_EVIDENCE_HELPERS);
});

test("connector-row uses resolveRecordCountDisplay rather than raw totalRecords for the count", async () => {
  // The raw number must not be rendered without going through the
  // honest-by-default helper, so an evidence error cannot produce a
  // false "0 records" line.
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, USES_RECORD_COUNT_DISPLAY);
  assert.match(src, RECORDS_UNAVAILABLE_BRANCH);
});

test("connector-row renders an axis chip strip when health is present", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, AXIS_CHIPS_STRIP);
});

const OUTBOX_GATE_CALL_RE = /summarizeAxisChips\(connectionHealth\?\.axes, \{/;
const OUTBOX_GATE_SIGNAL_RE = /isLocalDeviceBacked: Boolean\(overview\.localDeviceProgress\)/;

test("connector-row gates the outbox axis on local-device backing (report 1)", async () => {
  // The outbox axis is only meaningful for local/device-backed connections.
  // The row must thread `isLocalDeviceBacked` from `localDeviceProgress` so a
  // non-local connection never renders a mysterious "Outbox · unknown" chip.
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, OUTBOX_GATE_CALL_RE);
  assert.match(src, OUTBOX_GATE_SIGNAL_RE);
});

test("connector-row surfaces a projection-unreliable banner when unknown_reasons is non-empty", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, PROJECTION_UNRELIABLE_BANNER);
});

test("connector-row freshness line refuses to render content when evidence collection failed", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, FRESHNESS_RESPECTS_ERROR);
  assert.match(src, FRESHNESS_UNAVAILABLE_RENDER);
});

// ─── local-device operator-ideal assertions ──────────────────────────────
//
// The pill vocabulary lives in `lib/connection-evidence.ts` so it can be
// tested directly without a JSX harness. These structural assertions
// verify that the row consumes the shared helper and threads the
// evidence it needs (local-device progress, in particular) without
// reintroducing an inline vocabulary table.

const FRESHNESS_DEVICE_BOTH = /data-testid="freshness-device-both"/;
const LAST_CHECKED_LABEL = /last checked:/;
const LAST_INGEST_LABEL = /last ingest:/;
const RETAINED_BREAKDOWN = /data-testid="retained-bytes-breakdown"/;
const RETAINED_CURRENT_LABEL = /current \$\{formatBytes\(currentBytes\)\}/;
const RETAINED_HISTORY_LABEL = /history \$\{formatBytes\(historyBytes\)\}/;
const RUN_ACTION_RECEIVES_CONNECTION_ID =
  /runConnectorNowAction\(\s*connectorId,\s*connectionId \?\? connectorInstanceId \?\? null\s*\)/;
const USES_SHARED_STATUS_HELPER = /deriveConnectionStatusDisplay\(\{/;
const PASSES_LOCAL_DEVICE_PROGRESS = /localDeviceProgress=\{overview\.localDeviceProgress \?\? null\}/;

test("connector-row delegates pill rendering to the shared deriveConnectionStatusDisplay helper", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, USES_SHARED_STATUS_HELPER);
});

test("connector-row threads local-device progress into the connection pill", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, PASSES_LOCAL_DEVICE_PROGRESS);
});

test("connector-row freshness line shows both last-checked and last-ingest when both are present", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, FRESHNESS_DEVICE_BOTH);
  assert.match(src, LAST_CHECKED_LABEL);
  assert.match(src, LAST_INGEST_LABEL);
});

test("connector-row freshness line shows device-no-push label when device row exists but no timestamps yet", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, FRESHNESS_DEVICE_NO_PUSH_TESTID);
  assert.match(src, NO_PUSH_RECEIVED_YET);
});

test("connector-row no longer carries an inline connectionHealthDisplay vocabulary table", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.equal(src.includes("function connectionHealthDisplay"), false);
});

test("connector-row explains retained bytes as current records plus retained history", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, RETAINED_BREAKDOWN);
  assert.match(src, RETAINED_CURRENT_LABEL);
  assert.match(src, RETAINED_HISTORY_LABEL);
});

test("connector-row sync action targets the concrete connection when present", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, RUN_ACTION_RECEIVES_CONNECTION_ID);
});

// ─── modality-aware primary row action (sync honesty) ─────────────────────
//
// "Sync now" starts an owner-controlled connector run. Existing browser-bound
// rows can use it and may surface browser assistance in the run timeline after
// start. Push-mode local-device rows cannot remote-pull from the dashboard, so
// they must render an honest non-clickable next step instead of a dead button.
// These structural assertions verify the row consumes the shared
// `derivePrimaryRowAction` helper and routes every primary action through the
// modality-aware control.

const DERIVES_PRIMARY_ACTION = /derivePrimaryRowAction\(\{/;
const PRIMARY_ACTION_KEYS_CONNECTOR = /connectorId: connector\.connector_id/;
const PRIMARY_ACTION_KEYS_DEVICE_PROGRESS = /hasLocalDeviceProgress: Boolean\(overview\.localDeviceProgress\)/;
const RENDERS_PRIMARY_CONTROL = /<PrimaryRowActionControl\s/;
const SYNC_BUTTON_GATED_ON_SYNC_KIND = /action\.kind === "sync"/;
const DEVICE_WAIT_SURFACE = /data-testid="row-action-device-wait"/;

test("connector-row derives a modality-aware primary action", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, DERIVES_PRIMARY_ACTION);
  assert.match(src, PRIMARY_ACTION_KEYS_CONNECTOR);
  assert.match(src, PRIMARY_ACTION_KEYS_DEVICE_PROGRESS);
});

test("connector-row routes its primary action through PrimaryRowActionControl", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, RENDERS_PRIMARY_CONTROL);
});

test("the Sync now button only renders inside the owner-syncable branch", async () => {
  // The defect was an unconditional <Button>Sync now</Button> gated only by
  // running/isPending. The button must now live inside the `action.kind ===
  // "sync"` branch so push-mode rows can never render it.
  const src = await readFile(ROW_FILE, "utf8");
  const control = src.slice(src.indexOf("function PrimaryRowActionControl"), src.indexOf("function ConnectorStats"));
  assert.match(control, SYNC_BUTTON_GATED_ON_SYNC_KIND);
  // The Button must appear after the sync-kind guard within the control.
  const guardIndex = control.indexOf('action.kind === "sync"');
  const buttonIndex = control.indexOf("<Button");
  assert.ok(guardIndex >= 0 && buttonIndex > guardIndex, "Sync now <Button> must be gated behind the sync-kind branch");
});

test("connector-row surfaces an honest device-wait next step for push-mode rows", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  const control = src.slice(src.indexOf("function PrimaryRowActionControl"), src.indexOf("function ConnectorStats"));
  assert.match(control, DEVICE_WAIT_SURFACE);
});

test("the non-sync primary-action surface is inert text, never a button or run handler", async () => {
  // Honesty guard: the device-wait branch must not carry an onClick that could
  // reach runConnectorNowAction.
  const src = await readFile(ROW_FILE, "utf8");
  const control = src.slice(src.indexOf("function PrimaryRowActionControl"), src.indexOf("function ConnectorStats"));
  // Exactly one Button in the control (the sync branch); non-sync guidance is a
  // <span>.
  const buttonCount = (control.match(/<Button/g) ?? []).length;
  assert.equal(buttonCount, 1, "only the owner-syncable branch may render a Button");
  const onClickCount = (control.match(/onClick=/g) ?? []).length;
  assert.equal(onClickCount, 1, "only the owner-syncable Button may carry an onClick");
});

// ─── Sync now error handling (report 5) ───────────────────────────────────
//
// A failed run-start must stay a row-local toast and tell the owner whether the
// request reached the reference server. It must never throw past the handler
// (which would crash to the dashboard error boundary).

const TOAST_CARRIES_PHASE = /setToast\(\{ kind: "error", message: res\.message, phase: res\.phase \}\)/;
const TOAST_USES_SHARED_LEAD = /syncStartFailureLead\(toast\.phase\)/;
const TOAST_RENDERS_PHASE_ATTR = /data-sync-error-phase=\{toast\.phase\}/;
const TOAST_BEFORE_SERVER_WARNING_TONE = /toast\.phase === "before_server"[\s\S]{0,260}var\(--warning\)/;
const ACTION_PHASE_FIELD_RE = /phase: RunStartFailurePhase; reached_server: boolean/;
const ACTION_BEFORE_SERVER_RETURN_RE = /phase: "before_server"[\s\S]{0,160}reached_server: false/;
const ACTION_AFTER_SERVER_RETURN_RE = /phase: "after_server"[\s\S]{0,160}reached_server: true/;

test("connector-row threads the run-start failure phase into a row-local error toast", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, TOAST_CARRIES_PHASE);
});

test("connector-row error toast uses the shared before/after-server lead copy", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, TOAST_USES_SHARED_LEAD);
  assert.match(src, TOAST_RENDERS_PHASE_ATTR);
});

test("connector-row renders before-server failures as warnings, not destructive connector errors", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, TOAST_BEFORE_SERVER_WARNING_TONE);
});

test("the sync handler never rethrows — every action result resolves to a toast/refresh", async () => {
  // The handler must branch on res.ok / res.reason and set state; it must not
  // contain a `throw`, which would escape the transition and hit error.tsx.
  const src = await readFile(ROW_FILE, "utf8");
  const handler = src.slice(src.indexOf("const handleSync = useCallback("), src.indexOf("return {\n    handleSync"));
  assert.equal(handler.includes("throw"), false, "sync handler must not throw");
});

test("records and runs segments scope their own error boundaries (report 5)", () => {
  // A run-start refresh that fails must hit a contextful records/runs boundary,
  // not the dashboard-wide "Something went wrong".
  assert.ok(existsSync(`${HERE}error.tsx`), "records/error.tsx must exist");
  assert.ok(existsSync(`${HERE}../runs/error.tsx`), "runs/error.tsx must exist");
});

test("the run-start action classifies failures by before/after-server phase", async () => {
  const actionsSrc = await readFile(`${HERE}actions.ts`, "utf8");
  // The phase discriminator is on the error union.
  assert.match(actionsSrc, ACTION_PHASE_FIELD_RE);
  // before_server is keyed on the unreachable-server error; normal server
  // rejections are still marked as after_server.
  assert.match(actionsSrc, ACTION_BEFORE_SERVER_RETURN_RE);
  assert.match(actionsSrc, ACTION_AFTER_SERVER_RETURN_RE);
});
