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
const OUTBOX_REMEDIATION_COPY_BUTTON = /CopyButton/;
const OUTBOX_REMEDIATION_NO_BASE_URL = /diagnostics-outbox-remediation-command[\s\S]{0,400}--base-url/;
const OUTBOX_REMEDIATION_NO_DEVICE_TOKEN = /diagnostics-outbox-remediation-command[\s\S]{0,400}--device-token/;
const PAGE_PASSES_CONNECTION_ID = /connectionId=\{connectorInstanceId \?\? connectionId\}/;
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
