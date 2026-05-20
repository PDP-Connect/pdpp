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
const NEVER_INGESTED_COPY = /never ingested/;
const NO_LAST_SUCCESS_TESTID = /data-testid="diagnostics-no-last-success"/;
const PAGE_FILTERS_BY_CONNECTOR = /\.filter\(\(s\) => s\.connector_id === connectorId\)/;
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
