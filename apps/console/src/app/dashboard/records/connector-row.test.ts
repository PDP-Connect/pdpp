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
// "Sync now" starts a scheduler-managed pull, which only some connectors can
// be owner-triggered for. Push-mode (local-device) and browser-bound rows
// cannot, so the row must render an honest non-clickable next step instead of a
// dead button. These structural assertions verify the row consumes the shared
// `derivePrimaryRowAction` helper and routes every primary action through the
// modality-aware control — so the false "Sync now" affordance cannot return.

const DERIVES_PRIMARY_ACTION = /derivePrimaryRowAction\(\{/;
const PRIMARY_ACTION_KEYS_CONNECTOR = /connectorId: connector\.connector_id/;
const PRIMARY_ACTION_KEYS_DEVICE_PROGRESS = /hasLocalDeviceProgress: Boolean\(overview\.localDeviceProgress\)/;
const RENDERS_PRIMARY_CONTROL = /<PrimaryRowActionControl\s/;
const SYNC_BUTTON_GATED_ON_SYNC_KIND = /action\.kind === "sync"/;
const BROWSER_RUNBOOK_SURFACE = /data-testid="row-action-browser-runbook"/;
const BROWSER_RUNBOOK_RENDERS_PATH = /action\.runbookPath/;
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
  // "sync"` branch so push-mode and browser-bound rows can never render it.
  const src = await readFile(ROW_FILE, "utf8");
  const control = src.slice(src.indexOf("function PrimaryRowActionControl"), src.indexOf("function ConnectorStats"));
  assert.match(control, SYNC_BUTTON_GATED_ON_SYNC_KIND);
  // The Button must appear after the sync-kind guard within the control.
  const guardIndex = control.indexOf('action.kind === "sync"');
  const buttonIndex = control.indexOf("<Button");
  assert.ok(guardIndex >= 0 && buttonIndex > guardIndex, "Sync now <Button> must be gated behind the sync-kind branch");
});

test("connector-row surfaces an honest browser-bound runbook next step (not a dead sync)", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  const control = src.slice(src.indexOf("function PrimaryRowActionControl"), src.indexOf("function ConnectorStats"));
  assert.match(control, BROWSER_RUNBOOK_SURFACE);
  // The runbook path is rendered from the action, not a clickable run.
  assert.match(control, BROWSER_RUNBOOK_RENDERS_PATH);
});

test("connector-row surfaces an honest device-wait next step for push-mode rows", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  const control = src.slice(src.indexOf("function PrimaryRowActionControl"), src.indexOf("function ConnectorStats"));
  assert.match(control, DEVICE_WAIT_SURFACE);
});

test("the non-sync primary-action surfaces are inert text, never a button or run handler", async () => {
  // Honesty guard: the device-wait and browser-runbook branches must not carry
  // an onClick that could reach the failing runConnectorNowAction.
  const src = await readFile(ROW_FILE, "utf8");
  const control = src.slice(src.indexOf("function PrimaryRowActionControl"), src.indexOf("function ConnectorStats"));
  // Exactly one Button in the control (the sync branch); the other two branches
  // are <span> guidance.
  const buttonCount = (control.match(/<Button/g) ?? []).length;
  assert.equal(buttonCount, 1, "only the owner-syncable branch may render a Button");
  const onClickCount = (control.match(/onClick=/g) ?? []).length;
  assert.equal(onClickCount, 1, "only the owner-syncable Button may carry an onClick");
});
