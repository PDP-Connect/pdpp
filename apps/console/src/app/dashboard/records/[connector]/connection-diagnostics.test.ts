/**
 * Structural assertions for the connector detail diagnostics block.
 *
 * Mirrors the file-grep style used by `connector-row.test.ts`: we
 * verify the source wires the honest-by-default paths the brief
 * requires for task 6.3 and 6.5:
 *   - explicit "Projection evidence unavailable" branch when there is
 *     no `connection_health`;
 *   - explicit "Schedule unavailable" / "Device-exporter diagnostics
 *     unavailable" branches when the individual fetches fail;
 *   - explicit "never ingested" rendering for sources with no
 *     `last_ingest_at` rather than substituting a placeholder time;
 *   - backoff and ineligibility reasons surface from the schedule
 *     summary helper, not from re-derived logic.
 *
 * The detail page is a server component, so we also verify it
 * uses Promise.allSettled to keep one failing branch from poisoning
 * the others — that's the contract that makes the unavailable
 * branches above reachable in practice.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DIAG_FILE = `${HERE}connection-diagnostics.tsx`;
const PAGE_FILE = `${HERE}page.tsx`;

const PROJECTION_MISSING_TESTID = /data-testid="diagnostics-projection-missing"/;
const PROJECTION_UNAVAILABLE_COPY = /Projection evidence unavailable/;
const PROJECTION_FRESHNESS_HELPER = /formatProjectionFreshness/;
const PROJECTION_UNRELIABLE_TESTID = /data-testid="diagnostics-projection-unreliable"/;
const DOMINANT_CONDITION_HELPER = /formatDominantCondition/;
const DOMINANT_CONDITION_TESTID = /data-testid="diagnostics-dominant-condition"/;
const CONDITIONS_TESTID = /data-testid="diagnostics-conditions"/;
const CONDITIONS_USE_SUPPORTING_IDS = /supporting_condition_ids/;
const CONDITIONS_BY_ID = /conditionById/;
const SCHEDULE_ERROR_TESTID = /data-testid="diagnostics-schedule-error"/;
const SCHEDULE_UNAVAILABLE_COPY = /Schedule unavailable/;
const SOURCES_ERROR_TESTID = /data-testid="diagnostics-sources-error"/;
const SOURCES_UNAVAILABLE_COPY = /Device-exporter diagnostics unavailable/;
const SUMMARIZE_SCHEDULE_HELPER = /summarizeSchedule/;
const BACKOFF_TESTID = /data-testid="diagnostics-backoff"/;
const INELIGIBILITY_TESTID = /data-testid="diagnostics-ineligibility"/;
const SOURCE_NO_INGEST_TESTID = /data-testid="diagnostics-source-no-ingest"/;
const SOURCE_HEARTBEAT_STATUS = /last_heartbeat_status/;
const SOURCE_RECORDS_PENDING = /records_pending/;
const SOURCE_OUTBOX_STATE_TESTID = /data-testid="diagnostics-outbox-state"/;
const SOURCE_OUTBOX_STATE_HELPER = /formatSourceOutboxState/;
const SOURCE_LOCAL_GAPS_TESTID = /data-testid="diagnostics-local-gaps"/;
const SOURCE_LOCAL_GAPS_MISSING_TESTID = /data-testid="diagnostics-local-gaps-missing"/;
const OUTBOX_REMEDIATION_HELPER = /summarizeOutboxStallRemediation/;
const OUTBOX_REMEDIATION_TESTID = /data-testid="diagnostics-outbox-remediation"/;
const OUTBOX_REMEDIATION_LABEL_TESTID = /data-testid="diagnostics-outbox-remediation-label"/;
const OUTBOX_REMEDIATION_COMMAND_TESTID = /data-testid="diagnostics-outbox-remediation-command"/;
const OUTBOX_REMEDIATION_DOCTOR_COMMAND = /pdppLocalCollectorDoctorCommand/;
const OUTBOX_REMEDIATION_RETRY_COMMAND = /pdppLocalCollectorRetryDeadLettersCommand/;
const OUTBOX_REMEDIATION_RETRY_APPLY = /pdppLocalCollectorRetryDeadLettersCommand\(\{ \.\.\.scope, apply: true \}\)/;
const OUTBOX_REMEDIATION_STEPS_TESTID = /data-testid="diagnostics-outbox-remediation-steps"/;
const OUTBOX_REMEDIATION_COPY_BUTTON = /CopyButton/;
const OUTBOX_REMEDIATION_NO_BASE_URL = /diagnostics-outbox-remediation-command[\s\S]{0,400}--base-url/;
const OUTBOX_REMEDIATION_NO_DEVICE_TOKEN = /diagnostics-outbox-remediation-command[\s\S]{0,400}--device-token/;
const PAGE_PASSES_CONNECTION_ID = /connectionId=\{connectorInstanceId \?\? connectionId\}/;
const OUTBOX_REMEDIATION_SCALE_TESTID = /data-testid="diagnostics-outbox-remediation-scale"/;
const OUTBOX_REMEDIATION_PASSES_PROGRESS = /summarizeOutboxStallRemediation\(connectionHealth, localDeviceProgress\)/;
// Cause-specific remediation: the panel must PREFER the server-owned verdict
// remediation (cause-correct commands) over the hard-coded dead-letter ritual,
// mapping verdictRemediation.commands → the rendered steps. This is what fixes
// the owner-reported "retry-dead-letters returned matched: 0" dead end for the
// state_read_failed cause (whose commands carry only the re-run step).
const REMEDIATION_DERIVES_FROM_VERDICT = /required_actions\.find\(\(action\) => action\.remediation\)\?\.remediation/;
const REMEDIATION_PREFERS_VERDICT_COMMANDS = /verdictRemediation\s*\?\s*verdictRemediation\.commands\.map/;
const REMEDIATION_THREADS_VERDICT_TO_PANEL = /verdictRemediation=\{verdictRemediation\}/;
// The legacy dead-letter/doctor run-note must be gated OFF when a cause-specific
// verdict remediation is present — otherwise it reintroduces the very confusion
// (doctor / dead-letter / backlog) the cause-correct commands fix.
const RUN_NOTE_GATED_ON_LEGACY_FALLBACK =
  /verdictRemediation \? null : \([\s\S]{0,800}diagnostics-outbox-remediation-run-note/;
// The verdict command template is substituted with known non-secret values, not
// rendered literally — so the owner never copies a command with literal <…>.
const REMEDIATION_SUBSTITUTES_TEMPLATE = /substituteCommandTemplate\(command\.command_template/;
// Fail-closed: an unresolved command (null) renders a non-copyable "unavailable"
// line instead of a broken command with a CopyButton.
const REMEDIATION_FAILS_CLOSED =
  /step\.command === null \?[\s\S]{0,300}diagnostics-outbox-remediation-command-unavailable/;
const REMEDIATION_OWNER_EXPLANATION_HELPER = /function outboxCauseExplanation/;
const REMEDIATION_COMMAND_CAPTION_HELPER = /function remediationCommandCaption/;
const REMEDIATION_FAILED_UPLOAD_COPY = /saved records[\s\S]{0,120}did not upload to this server/;
const REMEDIATION_DASHBOARD_CANNOT_FIX_REMOTE_COPY = /dashboard cannot fix that host-local queue remotely/;
const REMEDIATION_RECOVER_DRY_RUN_CAPTION = /Dry run: shows what this recovery would do on that host/;
const REMEDIATION_RECOVER_PROFILE_CAPTION =
  /Uses the enrolled local profile to recover saved work and run the collector once/;
const REMEDIATION_THREADS_SOURCE_INSTANCE_ID = /sourceInstanceId=\{recoverySourceId\}/;
const REMEDIATION_SUBSTITUTES_SOURCE_INSTANCE_ID = /sourceInstanceId,/;
const RECOVERY_SOURCE_ID_HELPER = /function recoverySourceInstanceId/;
const RECOVERY_SOURCE_FILTERS_BY_CONNECTOR_INSTANCE = /source\.connector_instance_id === connectionId/;
const PAGE_PASSES_LOCAL_DEVICE_PROGRESS = /localDeviceProgress=\{overview\.localDeviceProgress \?\? null\}/;
const NEVER_INGESTED_COPY = /never ingested/;
const NO_LAST_SUCCESS_TESTID = /data-testid="diagnostics-no-last-success"/;
// The filter has been split across multiple lines so the connector_instance_id
// guard is readable. Match the connector_id predicate without locking the
// surrounding whitespace.
const PAGE_FILTERS_BY_CONNECTOR = /s\.connector_id === connectorId/;
const PAGE_REQUESTS_SCOPED_SOURCE_INSTANCES =
  /listDeviceExporterSourceInstances\(\{\s*connector_instance_id: connectorInstanceId \?\? undefined\s*\}\)/;
const PAGE_MAPS_LOCAL_DEVICE_PROGRESS = /localDeviceProgress: summary\.local_device_progress \?\? null/;
const PAGE_ALL_SETTLED = /Promise\.allSettled/;
const PAGE_SCHEDULE_ERROR_BINDING = /scheduleError = errorMessage/;
const PAGE_SOURCES_ERROR_BINDING = /sourceInstancesError = errorMessage/;
const PAGE_MOUNTS_DIAGNOSTICS = /<ConnectionDiagnostics/;
const PAGE_PASSES_RENDERED_VERDICT = /renderedVerdict=\{connectionRenderedVerdict\}/;
const PAGE_MAPS_RENDERED_VERDICT = /connectionRenderedVerdict: summary\.rendered_verdict \?\? null/;

const RENDERED_VERDICT_TESTID = /data-testid="rendered-verdict"/;
const RENDERED_VERDICT_CHANNEL_TESTID = /data-testid="rendered-verdict-channel"/;
const RENDERED_VERDICT_FORWARD_TESTID = /data-testid="rendered-verdict-forward"/;
const RENDERED_VERDICT_PROGRESS_TESTID = /data-testid="rendered-verdict-progress"/;
const DIAGNOSTICS_OPENS_FOR_DEVICE_LOCAL_RECOVERY = /open=\{opensForDeviceLocalRecovery \|\| undefined\}/;
const DIAGNOSTICS_DEVICE_LOCAL_RECOVERY_PREDICATE =
  /required_actions\.some\(\(action\) => action\.remediation\?\.target\.kind === "local_device"\)/;
const RENDERED_VERDICT_PRIMARY_ACTION_TESTID = /data-testid="rendered-verdict-primary-action"/;
const RENDERED_VERDICT_USES_FIRST_PRIMARY_ACTION = /const primaryAction = verdict\.required_actions\[0\] \?\? null/;
const RENDERED_VERDICT_VOCABULARY = /RENDERED_VERDICT_VOCABULARY/;
const PROJECTED_STATE_ACCEPTS_RENDERED_VERDICT = /renderedVerdict: RefRenderedVerdict \| null/;
const PROJECTED_STATE_PREFERS_RENDERED_VERDICT = /renderedVerdict \?/;
const SUPPRESSED_EVIDENCE_COMPONENT = /function SuppressedEvidenceDiagnostics/;
const SUPPRESSED_EVIDENCE_TESTID = /data-testid="diagnostics-suppressed-evidence"/;
const SUPPRESSED_EVIDENCE_READS_VERDICT_DETAIL = /renderedVerdict\?\.detail\.suppressed/;
const SUPPRESSED_EVIDENCE_DETAIL_FIELD_ATTR = /data-detail-field=\{signal\.detail_field\}/;

const AXES_TESTID = /data-testid="diagnostics-axes"/;
const AXIS_CHIPS_HELPER = /summarizeAxisChips/;
const AXIS_CHIPS_USE_TONE_CLASS = /diagnosticsAxisChipClass\(c\.tone\)/;
const AXIS_CHIP_SUCCESS_CLASS = /function diagnosticsAxisChipClass[\s\S]*emerald-500/;
const AXIS_CHIP_WARNING_CLASS = /function diagnosticsAxisChipClass[\s\S]*var\(--warning\)/;
const AXIS_CHIP_DANGER_CLASS = /function diagnosticsAxisChipClass[\s\S]*destructive/;
const REDUNDANT_OUTBOX_LINE_TESTID = /data-testid="diagnostics-outbox"/;

const COLLECTION_RATE_BLOCK_TITLE = /title="Collection rate"/;
const COLLECTION_RATE_HELPER = /formatCollectionRateReadout/;
const COLLECTION_RATE_TESTID = /data-testid="diagnostics-collection-rate"/;
const COLLECTION_RATE_UNKNOWN_TESTID = /data-testid="diagnostics-collection-rate-unknown"/;
const COLLECTION_RATE_UNAVAILABLE_COPY = /Collection rate unavailable/;
const REDUNDANT_OUTBOX_HELPER = /summarizeOutboxForRow/;

const FORWARD_DISPOSITION_TESTID = /data-testid="diagnostics-forward-disposition"/;
const FORWARD_DISPOSITION_HELPER = /formatForwardDisposition\(connectionHealth\.forward_disposition\)/;
const FORWARD_DISPOSITION_GUARDED = /forwardDisposition \? \(/;
const FORWARD_DISPOSITION_TONE_CLASS = /forwardDispositionTextClass\(forwardDisposition\.tone\)/;
const FORWARD_DISPOSITION_NEXT_RUN_COPY = /Next run:/;

test("connection-diagnostics renders the outbox axis as a colored chip, the source of truth", async () => {
  // The axis chip (data-axis-tone + label) is the single owner-visible
  // surface for Outbox · active/stalled/unknown color and label. The
  // remediation panel below handles the stalled case in full.
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, AXES_TESTID);
  assert.match(src, AXIS_CHIPS_HELPER);
});

test("connector detail page threads rendered_verdict into diagnostics", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, PAGE_MAPS_RENDERED_VERDICT);
  assert.match(src, PAGE_PASSES_RENDERED_VERDICT);
});

test("connection-diagnostics renders the server-owned rendered verdict summary", async () => {
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, RENDERED_VERDICT_TESTID);
  assert.match(src, RENDERED_VERDICT_CHANNEL_TESTID);
  assert.match(src, RENDERED_VERDICT_FORWARD_TESTID);
  assert.match(src, RENDERED_VERDICT_PROGRESS_TESTID);
  assert.match(src, RENDERED_VERDICT_PRIMARY_ACTION_TESTID);
  assert.match(src, RENDERED_VERDICT_USES_FIRST_PRIMARY_ACTION);
  assert.match(src, RENDERED_VERDICT_VOCABULARY);
});

test("projected-state diagnostics prefer rendered verdict for the headline badge when available", async () => {
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, PROJECTED_STATE_ACCEPTS_RENDERED_VERDICT);
  assert.match(src, PROJECTED_STATE_PREFERS_RENDERED_VERDICT);
});

test("connection-diagnostics renders suppressed verdict evidence only in the detail panel", async () => {
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, SUPPRESSED_EVIDENCE_COMPONENT);
  assert.match(src, SUPPRESSED_EVIDENCE_TESTID);
  assert.match(src, SUPPRESSED_EVIDENCE_READS_VERDICT_DETAIL);
  assert.match(src, SUPPRESSED_EVIDENCE_DETAIL_FIELD_ATTR);
});

test("connection-diagnostics applies the axis tone to visible chip classes", async () => {
  // `data-axis-tone` is useful for tests, but the owner-visible fix depends on
  // using that tone in the actual class list. This keeps active/success,
  // warning, and danger axes materially distinct on the detail page.
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, AXIS_CHIPS_USE_TONE_CLASS);
  assert.match(src, AXIS_CHIP_SUCCESS_CLASS);
  assert.match(src, AXIS_CHIP_WARNING_CLASS);
  assert.match(src, AXIS_CHIP_DANGER_CLASS);
});

test("connection-diagnostics does not render a redundant plain-text outbox line", async () => {
  // The plain-text `summarizeOutboxForRow` line duplicated the axis chip's
  // label but in a flat muted tone — rendering danger ("stalled") in neutral
  // grey and reintroducing the "Outbox unknown" noise the axis-chip gate
  // (outboxAxisIsApplicable) suppresses for non-local connections. The axis
  // chip is the source of truth; the redundant line is gone.
  const src = await readFile(DIAG_FILE, "utf8");
  assert.doesNotMatch(src, REDUNDANT_OUTBOX_LINE_TESTID);
  assert.doesNotMatch(src, REDUNDANT_OUTBOX_HELPER);
});

test("connection-diagnostics surfaces the forward disposition via the shared formatter, guarded for absence", async () => {
  // The connection-level forward disposition answers "what will the next run
  // do?". It must come from the shared `formatForwardDisposition` helper (not
  // re-derived in the component), be tone-coloured by the helper's tone, and be
  // guarded so a reference predating the field renders nothing rather than an
  // invented disposition.
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, FORWARD_DISPOSITION_HELPER);
  assert.match(src, FORWARD_DISPOSITION_GUARDED);
  assert.match(src, FORWARD_DISPOSITION_TESTID);
  assert.match(src, FORWARD_DISPOSITION_TONE_CLASS);
  assert.match(src, FORWARD_DISPOSITION_NEXT_RUN_COPY);
});

test("connection-diagnostics renders an unavailable branch when connection_health is null", async () => {
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, PROJECTION_MISSING_TESTID);
  assert.match(src, PROJECTION_UNAVAILABLE_COPY);
});

test("connection-diagnostics surfaces unknown_reasons via formatProjectionFreshness, not by inventing language", async () => {
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, PROJECTION_FRESHNESS_HELPER);
  assert.match(src, PROJECTION_UNRELIABLE_TESTID);
});

test("connection-diagnostics surfaces typed conditions from the shared projection", async () => {
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, DOMINANT_CONDITION_HELPER);
  assert.match(src, DOMINANT_CONDITION_TESTID);
  assert.match(src, CONDITIONS_TESTID);
  assert.match(src, CONDITIONS_USE_SUPPORTING_IDS);
  assert.match(src, CONDITIONS_BY_ID);
});

test("connection-diagnostics has explicit error branches for schedule and source-instance fetches", async () => {
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, SCHEDULE_ERROR_TESTID);
  assert.match(src, SCHEDULE_UNAVAILABLE_COPY);
  assert.match(src, SOURCES_ERROR_TESTID);
  assert.match(src, SOURCES_UNAVAILABLE_COPY);
});

test("connection-diagnostics surfaces scheduler backoff and ineligibility from summarizeSchedule", async () => {
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, SUMMARIZE_SCHEDULE_HELPER);
  assert.match(src, BACKOFF_TESTID);
  assert.match(src, INELIGIBILITY_TESTID);
});

test("connection-diagnostics renders 'never ingested' for sources without last_ingest_at", async () => {
  // Required by 6.5: do not substitute a polished/empty timestamp for
  // missing evidence.
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, SOURCE_NO_INGEST_TESTID);
  assert.match(src, NEVER_INGESTED_COPY);
});

test("connection-diagnostics renders per-source runtime and backlog evidence", async () => {
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, SOURCE_HEARTBEAT_STATUS);
  assert.match(src, SOURCE_RECORDS_PENDING);
  assert.match(src, SOURCE_OUTBOX_STATE_TESTID);
  assert.match(src, SOURCE_OUTBOX_STATE_HELPER);
  assert.match(src, SOURCE_LOCAL_GAPS_TESTID);
  assert.match(src, SOURCE_LOCAL_GAPS_MISSING_TESTID);
});

test("connection-diagnostics renders visible stalled-outbox remediation copy and a copy-pasteable doctor command", async () => {
  // The brief's core deliverable: when the outbox is stalled (or a
  // clear_backlog condition is dominant), the operator must see the
  // remediation label as readable text — not hover-only — plus a
  // deterministic local command to run on the host.
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, OUTBOX_REMEDIATION_HELPER);
  assert.match(src, OUTBOX_REMEDIATION_TESTID);
  assert.match(src, OUTBOX_REMEDIATION_LABEL_TESTID);
  assert.match(src, OUTBOX_REMEDIATION_COMMAND_TESTID);
  assert.match(src, OUTBOX_REMEDIATION_DOCTOR_COMMAND);
  assert.match(src, OUTBOX_REMEDIATION_COPY_BUTTON);
});

test("stalled-outbox remediation surfaces the actual recovery command, not just doctor", async () => {
  // The owner-reported gap: "Check the collector host" told the operator to run
  // `doctor` (which only diagnoses) but never named `retry-dead-letters`, the
  // command that actually requeues the stuck rows. The panel now renders the
  // documented three-step flow: diagnose → preview the requeue → apply it.
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, OUTBOX_REMEDIATION_STEPS_TESTID);
  // Both the dry-run preview and the --apply recovery command are present.
  assert.match(src, OUTBOX_REMEDIATION_RETRY_COMMAND);
  assert.match(src, OUTBOX_REMEDIATION_RETRY_APPLY);
});

test("stalled-outbox remediation PREFERS the server's cause-specific verdict commands over the hard-coded dead-letter ritual", async () => {
  // The owner-reported dead end: the panel showed the 3-step dead-letter ritual
  // (doctor → preview → requeue) even when the cause was a state-read block with
  // NO dead letters, so `retry-dead-letters` returned "matched: 0, nothing to do."
  // The fix: render `rendered_verdict.required_actions[].remediation.commands`,
  // which the runtime makes cause-correct (state_read_failed → re-run only). The
  // legacy steps remain ONLY as a fallback for references that omit remediation.
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, REMEDIATION_DERIVES_FROM_VERDICT);
  assert.match(src, REMEDIATION_PREFERS_VERDICT_COMMANDS);
  assert.match(src, REMEDIATION_THREADS_VERDICT_TO_PANEL);
  // The dead-letter run-note is suppressed under a cause-specific verdict remediation.
  assert.match(src, RUN_NOTE_GATED_ON_LEGACY_FALLBACK);
  // Verdict command templates are substituted (not rendered literally) and fail closed.
  assert.match(src, REMEDIATION_SUBSTITUTES_TEMPLATE);
  assert.match(src, REMEDIATION_FAILS_CLOSED);
  assert.match(src, REMEDIATION_THREADS_SOURCE_INSTANCE_ID);
  assert.match(src, REMEDIATION_SUBSTITUTES_SOURCE_INSTANCE_ID);
});

test("cause-specific collector recovery explains the host-local problem in owner language", async () => {
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, REMEDIATION_OWNER_EXPLANATION_HELPER);
  assert.match(src, REMEDIATION_COMMAND_CAPTION_HELPER);
  assert.match(src, REMEDIATION_FAILED_UPLOAD_COPY);
  assert.match(src, REMEDIATION_DASHBOARD_CANNOT_FIX_REMOTE_COPY);
  assert.match(src, REMEDIATION_RECOVER_DRY_RUN_CAPTION);
  assert.match(src, REMEDIATION_RECOVER_PROFILE_CAPTION);
});

test("device-local recovery resolves a source-instance id before rendering copyable commands", async () => {
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, RECOVERY_SOURCE_ID_HELPER);
  assert.match(src, RECOVERY_SOURCE_FILTERS_BY_CONNECTOR_INSTANCE);
  assert.match(src, REMEDIATION_THREADS_SOURCE_INSTANCE_ID);
});

test("device-local recovery opens Diagnostics so commands are immediately visible", async () => {
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, DIAGNOSTICS_DEVICE_LOCAL_RECOVERY_PREDICATE);
  assert.match(src, DIAGNOSTICS_OPENS_FOR_DEVICE_LOCAL_RECOVERY);
});

test("connection-diagnostics remediation command carries no base-url, token, or filesystem path", async () => {
  // The command is rendered remotely; it must not leak device-local internals.
  // The builder enforces this, but assert the component does not re-introduce
  // them inline around the command.
  const src = await readFile(DIAG_FILE, "utf8");
  // The doctor command is sourced from the helper, not hand-assembled with
  // a base URL or token. Guard against a regression that inlines secrets.
  assert.doesNotMatch(src, OUTBOX_REMEDIATION_NO_BASE_URL);
  assert.doesNotMatch(src, OUTBOX_REMEDIATION_NO_DEVICE_TOKEN);
});

test("connector detail page passes the connection identity to diagnostics for command scoping", async () => {
  const page = await readFile(PAGE_FILE, "utf8");
  assert.match(page, PAGE_PASSES_CONNECTION_ID);
});

test("connection-diagnostics renders a count-backed scale line gated on the stalled remediation", async () => {
  // The count rollup must be sourced from local_device_progress via the
  // remediation helper and rendered only inside the stalled-remediation panel,
  // so a quiet connection never shows counts.
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, OUTBOX_REMEDIATION_SCALE_TESTID);
  assert.match(src, OUTBOX_REMEDIATION_PASSES_PROGRESS);
});

test("connector detail page threads local-device progress into diagnostics for count-backed scale", async () => {
  const page = await readFile(PAGE_FILE, "utf8");
  assert.match(page, PAGE_PASSES_LOCAL_DEVICE_PROGRESS);
});

test("connection-diagnostics renders an explicit no-last-success line when projection has no last_success_at", async () => {
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, NO_LAST_SUCCESS_TESTID);
});

test("connection-diagnostics scopes source instances to the current connector via the page filter", async () => {
  // Defense-in-depth: ensure the page passes only the connector's
  // own source instances. Verified in the page wiring rather than
  // here, but the test lives with the diagnostics tests so they're
  // discoverable together.
  const page = await readFile(PAGE_FILE, "utf8");
  assert.match(page, PAGE_FILTERS_BY_CONNECTOR);
  assert.match(page, PAGE_REQUESTS_SCOPED_SOURCE_INSTANCES);
});

test("connector detail page preserves local-device progress on its overview projection", async () => {
  const page = await readFile(PAGE_FILE, "utf8");
  assert.match(page, PAGE_MAPS_LOCAL_DEVICE_PROGRESS);
});

test("connector detail page uses Promise.allSettled so one failing fetch does not zero the others", async () => {
  const page = await readFile(PAGE_FILE, "utf8");
  assert.match(page, PAGE_ALL_SETTLED);
  // Each branch must have a fulfilled-or-error split, not a single try
  // that drops all three on the first reject.
  assert.match(page, PAGE_SCHEDULE_ERROR_BINDING);
  assert.match(page, PAGE_SOURCES_ERROR_BINDING);
});

test("connector detail page mounts <ConnectionDiagnostics>", async () => {
  const page = await readFile(PAGE_FILE, "utf8");
  assert.match(page, PAGE_MOUNTS_DIAGNOSTICS);
});

// Multi-device clarity: when the connection has bound source instances,
// the page header must surface the device label(s) so two filesystem-class
// instances of the same connector are visually distinguishable, and it
// must mention any pending records still on devices.

const PAGE_DERIVES_DEVICE_LABELS = /summarizeSourceInstancesForHeader/;
const PAGE_RENDERS_DEVICE_LABELS_TESTID = /data-testid="records-device-labels"/;
const PAGE_DERIVES_PENDING_ON_DEVICES = /summarizeSourceInstancesForHeader[\s\S]{0,200}pendingOnDevices/;
const PAGE_RENDERS_PENDING_ON_DEVICES = /pending on devices/;

test("connector detail page surfaces device labels for bound source instances", async () => {
  const page = await readFile(PAGE_FILE, "utf8");
  assert.match(page, PAGE_DERIVES_DEVICE_LABELS);
  assert.match(page, PAGE_RENDERS_DEVICE_LABELS_TESTID);
});

test("connector detail page surfaces pending-on-devices delta when source instances report queued work", async () => {
  const page = await readFile(PAGE_FILE, "utf8");
  assert.match(page, PAGE_DERIVES_PENDING_ON_DEVICES);
  assert.match(page, PAGE_RENDERS_PENDING_ON_DEVICES);
});

// Local-collector recovery (connection-lifecycle objective #2): a stalled
// outbox is host-local — the dashboard cannot drain it remotely. "Check the
// collector host" is only actionable when the panel names *which* host, the
// pending/dead-letter scale, and surfaces the last error inline rather than
// hiding it in a title an owner who did not set up the collector won't open.

const REMEDIATION_THREADS_HOST_LABELS =
  /OutboxStallRemediationPanel[\s\S]{0,220}hostLabels=\{boundHostLabels\(recoverySourceInstances\)\}/;
const REMEDIATION_HOST_TESTID = /data-testid="diagnostics-outbox-remediation-host"/;
const REMEDIATION_NAMES_BOUND_DEVICE = /Bound device/;
const BOUND_HOST_LABELS_PREFERS_DISPLAY_NAME = /source\.display_name \?\? source\.local_binding_name/;
const SOURCE_ERROR_RENDERS_MESSAGE = /Last error: \{formatSourceLastError\(source\.last_error\)\}/;
const SOURCE_ERROR_FORMATTER_PICKS_MESSAGE = /pick\("message"\) \?\? pick\("reason"\)/;
const BOUND_HOST_LABELS_NO_DEVICE_ID = /device_id/;
const SOURCE_ERROR_PRESERVES_TITLE = /title=\{JSON\.stringify\(source\.last_error\)\}/;

test("stalled-outbox remediation panel is threaded the bound host label(s)", async () => {
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, REMEDIATION_THREADS_HOST_LABELS);
  assert.match(src, REMEDIATION_HOST_TESTID);
  assert.match(src, REMEDIATION_NAMES_BOUND_DEVICE);
});

test("bound host labels prefer the owner-meaningful display name over the opaque device id", async () => {
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, BOUND_HOST_LABELS_PREFERS_DISPLAY_NAME);
  // The label derivation must NOT fall back to device_id — an opaque id is
  // not an owner-facing "host" name. (boundHostLabels stops at local_binding_name.)
  const helperBody = src.slice(src.indexOf("function boundHostLabels"));
  const helperSlice = helperBody.slice(0, helperBody.indexOf("\n}"));
  assert.doesNotMatch(helperSlice, BOUND_HOST_LABELS_NO_DEVICE_ID);
});

test("source last_error renders an inline human message, not just a hidden title", async () => {
  const src = await readFile(DIAG_FILE, "utf8");
  assert.match(src, SOURCE_ERROR_RENDERS_MESSAGE);
  assert.match(src, SOURCE_ERROR_FORMATTER_PICKS_MESSAGE);
  // The full object is still preserved in the title for deeper inspection.
  assert.match(src, SOURCE_ERROR_PRESERVES_TITLE);
});

test("diagnostics renders a Collection rate block that degrades to an explicit unknown", async () => {
  const src = await readFile(DIAG_FILE, "utf8");
  // The block exists and derives its readout through the pure formatter.
  assert.match(src, COLLECTION_RATE_BLOCK_TITLE);
  assert.match(src, COLLECTION_RATE_HELPER);
  // Honest-by-default: a populated readout and an explicit unavailable branch.
  assert.match(src, COLLECTION_RATE_TESTID);
  assert.match(src, COLLECTION_RATE_UNKNOWN_TESTID);
  assert.match(src, COLLECTION_RATE_UNAVAILABLE_COPY);
});
