// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Proves the scheduler-doctor probe script surfaces an honest runtime
// verdict from a /_ref/schedules listing. The script is the AI-friendly
// equivalent of "did the scheduler loop pick up my Docker schedule?" —
// it must classify enabled/ineligible/never-ran without false positives.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Controller } from "../runtime/controller.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROBE_PATH = join(__dirname, "..", "scripts", "scheduler-doctor.ts");

interface ClosableServer {
  asPort: number;
  asServer: { close: (cb: () => void) => void; closeAllConnections?: () => void };
  controller: Controller;
  rsPort: number;
  rsServer: { close: (cb: () => void) => void; closeAllConnections?: () => void };
  schedulerManager?: { stop?: () => void };
}

interface ProbeResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

interface DoctorScheduleEntry {
  connector_id: string;
  ineligibility_reason?: string | null;
  kind?: string;
  last_error_code?: string | null;
  last_finished_at?: string | null;
  last_started_at?: string | null;
  next_due_at?: string | null;
  would_fire: boolean;
  [key: string]: unknown;
}

interface DoctorSummary {
  automatic: number;
  eligible_unscheduled?: number;
  enabled: number;
  has_active_run?: number;
  ineligible: number;
  manual_unscheduled?: number;
  never_ran: number;
  schedules: DoctorScheduleEntry[];
  total: number;
}

function parseSummary(stdout: string): DoctorSummary {
  return JSON.parse(stdout.trim()) as DoctorSummary;
}

function getEntry(byId: Map<string, DoctorScheduleEntry>, connectorId: string): DoctorScheduleEntry {
  const entry = byId.get(connectorId);
  assert.ok(entry, `expected a doctor summary entry for ${connectorId}`);
  return entry;
}

function startFakeAs(listing: unknown): Promise<{ server: http.Server; url: string }> {
  return startFakeAsWith({ schedules: listing });
}

function startFakeAsWith({
  schedules,
  connectors = null,
}: {
  schedules: unknown;
  connectors?: unknown;
}): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/_ref/schedules") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(schedules));
        return;
      }
      // Terminal-gate revision (2026-07-29): the doctor now page-follows the
      // bounded route (`?limit=100[&cursor=...]`), never the bare path — the
      // fake server matches by prefix instead of exact-URL, and returns one
      // complete (no `has_more`) page since these fixtures are always small.
      if (req.url?.startsWith("/_ref/connectors?") && connectors) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(connectors));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function runProbe(asUrl: string, extraEnv: Record<string, string> = {}): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const env = { ...process.env, PDPP_OWNER_PASSWORD: "", ...extraEnv };
    const child = spawn(process.execPath, [PROBE_PATH, "--as-url", asUrl, "--json"], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      resolve({ code, stderr, stdout });
    });
  });
}

test("scheduler-doctor classifies enabled, ineligible, paused, and never-ran schedules", async () => {
  const listing = {
    data: [
      {
        active_run_id: null,
        connector_id: "spotify",
        effective_mode: "automatic",
        enabled: true,
        ineligibility_reason: null,
        interval_seconds: 3600,
        last_started_at: null,
        next_due_at: "2026-05-15T10:00:00.000Z",
      },
      {
        active_run_id: null,
        connector_id: "github",
        effective_mode: "automatic",
        enabled: true,
        ineligibility_reason: "Connector refresh policy is not background-safe; automatic scheduling is disabled.",
        interval_seconds: 1800,
        last_started_at: "2026-05-14T09:00:00.000Z",
      },
      {
        active_run_id: null,
        connector_id: "reddit",
        effective_mode: "paused",
        enabled: false,
        ineligibility_reason: null,
        interval_seconds: 1800,
        last_started_at: null,
      },
      {
        active_run_id: "run_42",
        connector_id: "slack",
        effective_mode: "automatic",
        enabled: true,
        ineligibility_reason: null,
        interval_seconds: 7200,
        last_started_at: "2026-05-15T08:00:00.000Z",
        last_successful_at: "2026-05-15T08:00:30.000Z",
      },
    ],
    object: "list",
  };

  const { server, url } = await startFakeAs(listing);
  try {
    const { code, stdout, stderr } = await runProbe(url);
    assert.equal(code, 0, `probe exit code 0; stderr: ${stderr}`);
    const summary = parseSummary(stdout);
    assert.equal(summary.total, 4);
    assert.equal(summary.enabled, 3, "three schedules have enabled=true");
    assert.equal(summary.automatic, 2, "two would actually fire (spotify, slack)");
    assert.equal(summary.ineligible, 1, "one enabled-but-ineligible (github)");
    assert.equal(summary.never_ran, 1, "spotify would fire but has never started");
    assert.equal(summary.has_active_run, 1, "slack has an active run");

    const byId = new Map(summary.schedules.map((s) => [s.connector_id, s]));
    assert.equal(getEntry(byId, "spotify").would_fire, true);
    assert.equal(getEntry(byId, "github").would_fire, false, "ineligible reason blocks would_fire");
    assert.equal(getEntry(byId, "reddit").would_fire, false, "disabled blocks would_fire");
    assert.equal(getEntry(byId, "slack").would_fire, true);
  } finally {
    server.close();
  }
});

test("scheduler-doctor exits non-zero when the AS endpoint is unreachable", async () => {
  // 127.0.0.1:1 is the canonical "rejecting" loopback address for this
  // assertion: it's a privileged port with no listener, so the TCP
  // connect fails fast and the probe's error path runs deterministically.
  const { code, stderr } = await runProbe("http://127.0.0.1:1");
  assert.equal(code, 1);
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(stderr, /cannot reach/);
});

test("scheduler-doctor handles an empty schedules listing without crashing", async () => {
  const { server, url } = await startFakeAs({ data: [], object: "list" });
  try {
    const { code, stdout } = await runProbe(url);
    assert.equal(code, 0);
    const summary = parseSummary(stdout);
    assert.equal(summary.total, 0);
    assert.equal(summary.automatic, 0);
    assert.equal(summary.schedules.length, 0);
  } finally {
    server.close();
  }
});

test("scheduler-doctor surfaces NOSCHED for auto-eligible registered connectors with no persisted row", async () => {
  // Cross-references /_ref/connectors against /_ref/schedules so an
  // operator can see registered, background-safe, automatic connectors
  // that simply have no schedule row yet (e.g., notion/oura/strava in
  // SLVP Docker before the operator enrolls them). MANUAL flags rows
  // that are correctly absent because the manifest gates them.
  const schedules = { data: [], object: "list" };
  const connectors = {
    data: [
      {
        connector_id: "notion",
        refresh_policy: {
          background_safe: true,
          recommended_mode: "automatic",
        },
      },
      {
        connector_id: "amazon",
        refresh_policy: {
          background_safe: false,
          recommended_mode: "manual",
        },
      },
      {
        connector_id: "reddit",
        refresh_policy: {
          background_safe: false,
          recommended_mode: "manual",
        },
      },
    ],
    object: "list",
  };
  const { server, url } = await startFakeAsWith({ connectors, schedules });
  try {
    const { code, stdout, stderr } = await runProbe(url);
    assert.equal(code, 0, `probe failed; stderr: ${stderr}`);
    const summary = parseSummary(stdout);
    assert.equal(summary.total, 0, "no persisted schedule rows");
    assert.equal(summary.eligible_unscheduled, 1, "one auto-eligible connector lacks a schedule row");
    assert.equal(summary.manual_unscheduled, 2, "amazon and reddit are correctly unscheduled");

    const byId = new Map(summary.schedules.map((s) => [s.connector_id, s]));
    assert.equal(getEntry(byId, "notion").kind, "no_schedule_eligible");
    assert.equal(getEntry(byId, "notion").would_fire, false, "no row means no automatic fire");
    assert.equal(getEntry(byId, "notion").ineligibility_reason, null);
    assert.equal(getEntry(byId, "amazon").kind, "no_schedule_manual");
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(getEntry(byId, "amazon").ineligibility_reason ?? "", /background-safe|manual|paused/);
    assert.equal(getEntry(byId, "reddit").kind, "no_schedule_manual");
  } finally {
    server.close();
  }
});

test("scheduler-doctor does not duplicate connectors that have a persisted schedule row", async () => {
  const schedules = {
    data: [
      {
        active_run_id: null,
        connector_id: "spotify",
        effective_mode: "automatic",
        enabled: true,
        ineligibility_reason: null,
        interval_seconds: 3600,
        last_started_at: null,
        next_due_at: null,
      },
    ],
    object: "list",
  };
  const connectors = {
    data: [
      {
        connector_id: "spotify",
        refresh_policy: { background_safe: true, recommended_mode: "automatic" },
      },
    ],
    object: "list",
  };
  const { server, url } = await startFakeAsWith({ connectors, schedules });
  try {
    const { code, stdout } = await runProbe(url);
    assert.equal(code, 0);
    const summary = parseSummary(stdout);
    assert.equal(summary.total, 1);
    assert.equal(summary.eligible_unscheduled, 0, "spotify is not double-counted");
    assert.equal(summary.schedules.length, 1);
    const [persistedEntry] = summary.schedules;
    assert.ok(persistedEntry, "a persisted schedule entry was returned");
    assert.equal(persistedEntry.kind, "persisted");
  } finally {
    server.close();
  }
});

test("scheduler-doctor projects persisted history facts into existing schedule fields after restart", async () => {
  // Once `/_ref/schedules` started carrying history-derived `last_*` and
  // `next_due_at` fields, a persisted schedule whose in-memory active-run
  // row already cleared must NOT show up as `never_ran` and must NOT be
  // counted toward `would_fire` until its interval has elapsed. The
  // dashboard reads the same envelope; the doctor stays aligned with it.
  const lastFinishedAt = new Date(Date.now() - 60_000).toISOString(); // ran 1 minute ago
  const nextDueAt = new Date(Date.now() + 3_540_000).toISOString(); // due in 59 minutes
  const lastStartedAt = new Date(Date.now() - 120_000).toISOString();
  const listing = {
    data: [
      {
        active_run_id: null,
        connector_id: "gmail",
        effective_mode: "automatic",
        enabled: true,
        ineligibility_reason: null,
        interval_seconds: 3600,
        last_error_code: null,
        last_finished_at: lastFinishedAt,
        last_started_at: lastStartedAt,
        last_successful_at: lastFinishedAt,
        next_due_at: nextDueAt,
      },
    ],
    object: "list",
  };

  const { server, url } = await startFakeAs(listing);
  try {
    const { code, stdout, stderr } = await runProbe(url);
    assert.equal(code, 0, `probe failed; stderr: ${stderr}`);
    const summary = parseSummary(stdout);
    assert.equal(summary.total, 1);
    assert.equal(summary.enabled, 1);
    assert.equal(summary.never_ran, 0, "persisted history means gmail is not never_ran");
    assert.equal(summary.automatic, 0, "gmail ran 1m ago with a 1h interval; not currently inside its dispatch window");
    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const gmail = summary.schedules[0];
    assert.ok(gmail, "a schedule entry was returned");
    assert.equal(gmail.would_fire, false, "next_due_at is in the future");
    assert.equal(gmail.last_started_at, lastStartedAt);
    assert.equal(gmail.last_finished_at, lastFinishedAt);
    assert.equal(gmail.next_due_at, nextDueAt);
  } finally {
    server.close();
  }
});

test("scheduler-doctor surfaces skip-only history without flipping last_started_at", async () => {
  // A connector that the scheduler keeps skipping (not_ready / needs_human /
  // disabled grant) never spawns a child process. The controller's history
  // index records `last_finished_at` from `scheduler_last_run_times` but
  // intentionally leaves `last_started_at` null because the run never
  // started. The doctor must (a) NOT classify the schedule as `never_ran`
  // (we have evidence the scheduler is acting on it), and (b) still surface
  // the failure code if a recent attempt failed terminally. This is what
  // lets an operator tell "ran but currently idle" apart from "currently
  // being skipped".
  const lastFinishedAt = new Date(Date.now() - 60_000).toISOString();
  const nextDueAt = new Date(Date.now() + 60_000).toISOString();
  const listing = {
    data: [
      {
        active_run_id: null,
        connector_id: "amazon",
        effective_mode: "automatic",
        enabled: true,
        ineligibility_reason: null,
        interval_seconds: 1800,
        last_error_code: "not_ready: collector not paired",
        last_finished_at: lastFinishedAt,
        last_started_at: null,
        last_successful_at: null,
        next_due_at: nextDueAt,
      },
    ],
    object: "list",
  };
  const { server, url } = await startFakeAs(listing);
  try {
    const { code, stdout } = await runProbe(url);
    assert.equal(code, 0);
    const summary = parseSummary(stdout);
    assert.equal(summary.never_ran, 0, "skip-only history is still evidence of activity");
    assert.equal(summary.automatic, 0, "not currently due");
    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const amazon = summary.schedules[0];
    assert.ok(amazon, "a schedule entry was returned");
    assert.equal(amazon.last_started_at, null, "skip records do not populate last_started_at");
    assert.equal(amazon.last_finished_at, lastFinishedAt);
    assert.equal(amazon.last_error_code, "not_ready: collector not paired");
  } finally {
    server.close();
  }
});

test("scheduler-doctor only reports never_ran for genuinely never-fired schedules", async () => {
  // Distinguishes a fresh enrollment (no history, would fire on next tick)
  // from a recently-completed schedule (has history, currently idle).
  const lastFinishedAt = new Date(Date.now() - 60_000).toISOString();
  const futureDue = new Date(Date.now() + 3_540_000).toISOString();
  const listing = {
    data: [
      {
        active_run_id: null,
        connector_id: "fresh",
        effective_mode: "automatic",
        enabled: true,
        ineligibility_reason: null,
        interval_seconds: 3600,
        last_error_code: null,
        last_finished_at: null,
        last_started_at: null,
        last_successful_at: null,
        next_due_at: null,
      },
      {
        active_run_id: null,
        connector_id: "idle",
        effective_mode: "automatic",
        enabled: true,
        ineligibility_reason: null,
        interval_seconds: 3600,
        last_error_code: null,
        last_finished_at: lastFinishedAt,
        last_started_at: new Date(Date.now() - 120_000).toISOString(),
        last_successful_at: lastFinishedAt,
        next_due_at: futureDue,
      },
    ],
    object: "list",
  };
  const { server, url } = await startFakeAs(listing);
  try {
    const { code, stdout } = await runProbe(url);
    assert.equal(code, 0);
    const summary = parseSummary(stdout);
    assert.equal(summary.never_ran, 1, "only the genuinely never-fired schedule counts");
    assert.equal(summary.automatic, 1, "fresh is due now, idle is not");
    const byId = new Map(summary.schedules.map((s) => [s.connector_id, s]));
    assert.equal(getEntry(byId, "fresh").would_fire, true);
    assert.equal(getEntry(byId, "idle").would_fire, false);
  } finally {
    server.close();
  }
});

test("scheduler-doctor reads a real /_ref/schedules from a live reference server with owner-password auth", async () => {
  const { startServer } = await import("../server/index.ts");
  const { closeDb } = await import("../server/db.ts");
  const { readFileSync } = await import("node:fs");
  const REFERENCE_IMPL_DIR = join(__dirname, "..");
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8"));
  const ownerPassword = "scheduler-doctor-test-pw";

  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: ownerPassword,
    quiet: true,
    rsPort: 0,
  })) as ClosableServer;

  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    await server.controller.upsertSchedule(spotifyManifest.connector_id, {
      enabled: true,
      interval_seconds: 3600,
      jitter_seconds: 0,
    });

    const { code, stdout, stderr } = await runProbe(asUrl, { PDPP_OWNER_PASSWORD: ownerPassword });
    assert.equal(code, 0, `probe failed; stderr: ${stderr}`);
    const summary = parseSummary(stdout);
    assert.equal(summary.total, 1, "one persisted schedule");
    assert.equal(summary.enabled, 1);
    assert.equal(summary.automatic, 1, "spotify is background-safe; would_fire is true");
    const [registeredEntry] = summary.schedules;
    assert.ok(registeredEntry, "a schedule entry was returned");
    assert.equal(registeredEntry.connector_id, canonicalConnectorKey(spotifyManifest.connector_id));
  } finally {
    server.schedulerManager?.stop?.();
    server.asServer.closeAllConnections?.();
    server.rsServer.closeAllConnections?.();
    await new Promise<void>((resolve) => server.asServer.close(() => resolve()));
    await new Promise<void>((resolve) => server.rsServer.close(() => resolve()));
    closeDb();
  }
});

test("controller.listSchedules projects persisted history when no active run is present", async () => {
  // Live durable contract test: prove `ScheduleApi.last_*` and `next_due_at`
  // are sourced from `scheduler_run_history` + `scheduler_last_run_times`
  // when the in-memory active-run row is absent. This is the operator-API
  // contract: the doctor, the dashboard, and any future consumer of
  // `/_ref/schedules` rely on it. Without this, an operator who restarts
  // the reference server sees null last-run timestamps even when history
  // is intact.
  const { startServer } = await import("../server/index.ts");
  const { getDefaultSchedulerStore } = await import("../server/stores/scheduler-store.ts");
  const { closeDb } = await import("../server/db.ts");
  const { readFileSync } = await import("node:fs");
  const REFERENCE_IMPL_DIR = join(__dirname, "..");
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8"));
  // Records, schedules, and history are keyed by the canonical connector key
  // (the controller/ingest path canonicalizes the manifest's URL-shaped
  // connector_id). Store-direct seeds below must use the same canonical key,
  // and projected rows surface it. See canonicalize-connector-keys.
  const canonicalSpotifyId = canonicalConnectorKey(spotifyManifest.connector_id);
  assert.ok(canonicalSpotifyId, "spotify manifest yields a canonical connector key");
  const ownerPassword = "scheduler-doctor-test-pw-2";

  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: ownerPassword,
    quiet: true,
    rsPort: 0,
  })) as ClosableServer;

  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    await server.controller.upsertSchedule(spotifyManifest.connector_id, {
      enabled: true,
      interval_seconds: 3600,
      jitter_seconds: 0,
    });

    // Simulate a completed run by writing a succeeded history row plus
    // the matching `scheduler_last_run_times` entry the runtime would
    // have written. This is the exact state a freshly restarted server
    // sees on disk for any connector that ran successfully before the
    // last restart.
    const store = getDefaultSchedulerStore();
    const startedAt = new Date(Date.now() - 120_000).toISOString();
    const completedAt = new Date(Date.now() - 60_000).toISOString();
    const olderFailedStartedAt = new Date(Date.now() - 240_000).toISOString();
    const olderFailedCompletedAt = new Date(Date.now() - 180_000).toISOString();
    await Promise.resolve(
      store.appendRunHistory({
        attempt: 1,
        checkpointSummary: null,
        completedAt: olderFailedCompletedAt,
        connectorError: { code: "older_failure", message: "older failure" },
        connectorId: canonicalSpotifyId,
        connectorInstanceId: canonicalSpotifyId,
        failureReason: "older_failure",
        knownGaps: [],
        recordsEmitted: 0,
        reportedRecordsEmitted: 0,
        runId: "run_test_history_older_failure",
        source: { id: canonicalSpotifyId, kind: "connector" },
        startedAt: olderFailedStartedAt,
        status: "failed",
        terminalReason: "older_terminal_failure",
        traceId: "trace_test_history_older_failure",
      })
    );
    await Promise.resolve(
      store.appendRunHistory({
        attempt: 1,
        checkpointSummary: null,
        completedAt,
        connectorError: null,
        connectorId: canonicalSpotifyId,
        connectorInstanceId: canonicalSpotifyId,
        failureReason: null,
        knownGaps: [],
        recordsEmitted: 7,
        reportedRecordsEmitted: 7,
        runId: "run_test_history_projection",
        source: { id: canonicalSpotifyId, kind: "connector" },
        startedAt,
        status: "succeeded",
        terminalReason: null,
        traceId: "trace_test_history_projection",
      })
    );
    await Promise.resolve(
      store.upsertLastRunTime(canonicalSpotifyId, Date.parse(completedAt), new Date().toISOString())
    );

    const schedules = await server.controller.listSchedules();
    assert.equal(schedules.length, 1);
    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const spotify = schedules[0];
    assert.ok(spotify, "a ScheduleApi row was returned");
    assert.equal(spotify.connector_id, canonicalSpotifyId);
    assert.equal(spotify.active_run_id, null, "no in-memory active run");
    assert.equal(spotify.last_started_at, startedAt, "projected from history row");
    assert.equal(spotify.last_finished_at, completedAt, "projected from history row");
    assert.equal(spotify.last_successful_at, completedAt, "projected from history row");
    assert.equal(spotify.last_error_code, null, "newer success clears older failure code");
    assert.equal(spotify.next_due_at, new Date(Date.parse(completedAt) + 3_600_000).toISOString());

    // `getSchedule` (single-row read) must surface the same projection.
    const single = await server.controller.getSchedule(canonicalSpotifyId);
    assert.ok(single, "single-row getSchedule succeeds");
    assert.equal(single.last_started_at, startedAt);
    assert.equal(single.last_finished_at, completedAt);
    assert.equal(single.next_due_at, spotify.next_due_at);

    // End-to-end doctor probe must reflect the same facts.
    const { code, stdout, stderr } = await runProbe(asUrl, { PDPP_OWNER_PASSWORD: ownerPassword });
    assert.equal(code, 0, `probe failed; stderr: ${stderr}`);
    const summary = parseSummary(stdout);
    assert.equal(summary.never_ran, 0, "history is projected; not never_ran");
    assert.equal(summary.automatic, 0, "next_due_at is ~59min away; not currently due");
    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const probedSpotify = summary.schedules[0];
    assert.ok(probedSpotify, "a probed schedule entry was returned");
    assert.equal(probedSpotify.last_started_at, startedAt);
    assert.equal(probedSpotify.last_finished_at, completedAt);
    assert.equal(probedSpotify.next_due_at, spotify.next_due_at);
    assert.equal(probedSpotify.would_fire, false);
  } finally {
    server.schedulerManager?.stop?.();
    server.asServer.closeAllConnections?.();
    server.rsServer.closeAllConnections?.();
    await new Promise<void>((resolve) => server.asServer.close(() => resolve()));
    await new Promise<void>((resolve) => server.rsServer.close(() => resolve()));
    closeDb();
  }
});

test("controller.listSchedules suppresses stale error code and next_due_at when manifest has gated the schedule", async () => {
  // USAA-shape regression: an enabled schedule row exists from before the
  // connector's manifest was tightened to `background_safe: false`. The
  // persisted history carries `schedule.gave_up` and `not_ready` entries
  // from the doomed automatic runs the runtime attempted before the gate
  // landed. After gating:
  //   - the scheduler manager filters the row out of the runnable set;
  //   - `ineligibility_reason` reflects the current gate;
  //   - `last_error_code` MUST NOT continue to advertise the old
  //     `schedule.gave_up` / `not_ready` failure mode as if the
  //     scheduler were still actively failing the connector;
  //   - `next_due_at` MUST be null (no automatic run will fire).
  // Historical timestamps remain because they describe what already
  // happened. This is the contract the scheduler-doctor GATE verdict and
  // the dashboard "not runnable" chip both rely on.
  const { startServer } = await import("../server/index.ts");
  const { getDefaultSchedulerStore } = await import("../server/stores/scheduler-store.ts");
  const { closeDb } = await import("../server/db.ts");
  const { readFileSync } = await import("node:fs");
  const REFERENCE_IMPL_DIR = join(__dirname, "..");
  // Use the polyfill USAA manifest directly — it is the live shape the
  // manifest reconcile installs at startup, with refresh_policy
  // {recommended_mode: 'manual', background_safe: false}. Pinning the
  // test to a shipped manifest also fails closed if a future edit ever
  // relaxes USAA's policy back to automatic without owner intent. (Reddit
  // and Amazon are no longer usable here: both now declare
  // background_safe: true for owner opt-in scheduling.)
  const POLYFILL_MANIFESTS_DIR = join(REFERENCE_IMPL_DIR, "..", "packages", "polyfill-connectors", "manifests");
  const gatedManifest = JSON.parse(readFileSync(join(POLYFILL_MANIFESTS_DIR, "usaa.json"), "utf8"));
  // Schedule rows and history are keyed by the canonical connector key. The
  // store-direct seeds below bypass the controller, so they must use the
  // canonical key themselves to match what listSchedules/getSchedule read.
  // See canonicalize-connector-keys.
  const canonicalGatedId = canonicalConnectorKey(gatedManifest.connector_id);
  assert.ok(canonicalGatedId, "gated manifest yields a canonical connector key");
  const ownerPassword = "scheduler-doctor-gated-connector-pw";

  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: ownerPassword,
    quiet: true,
    rsPort: 0,
  })) as ClosableServer;

  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(gatedManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    // Insert a persisted enabled schedule row directly through the
    // store, bypassing the controller's eligibility check. This is the
    // exact shape of a row that was enabled before the manifest gate
    // landed.
    const store = getDefaultSchedulerStore();
    const now = new Date().toISOString();
    await Promise.resolve(
      store.createSchedule({
        connector_id: canonicalGatedId,
        created_at: now,
        enabled: true,
        interval_seconds: 1800,
        jitter_seconds: 0,
        updated_at: now,
      })
    );

    // Persist a history shape matching the task brief: prior `not_ready`
    // skips and a terminal `schedule.gave_up` event. The most recent row
    // is a `skipped` with the gave_up payload — exactly what the brief
    // describes ("historical schedule.gave_up from 12 terminal failures",
    // "not_ready: required browser runtime is not configured...").
    const olderFailedStartedAt = new Date(Date.now() - 600_000).toISOString();
    const olderFailedCompletedAt = new Date(Date.now() - 540_000).toISOString();
    const skipCompletedAt = new Date(Date.now() - 60_000).toISOString();
    await Promise.resolve(
      store.appendRunHistory({
        attempt: 12,
        checkpointSummary: null,
        completedAt: olderFailedCompletedAt,
        connectorError: null,
        connectorId: canonicalGatedId,
        connectorInstanceId: canonicalGatedId,
        failureReason: "browser_runtime_not_configured",
        knownGaps: [],
        recordsEmitted: 0,
        reportedRecordsEmitted: 0,
        runId: "run_test_gated_failed",
        source: { id: canonicalGatedId, kind: "connector" },
        startedAt: olderFailedStartedAt,
        status: "failed",
        terminalReason: "browser_runtime_not_configured",
        traceId: "trace_test_gated_failed",
      })
    );
    await Promise.resolve(
      store.appendRunHistory({
        attempt: 0,
        checkpointSummary: null,
        completedAt: skipCompletedAt,
        connectorError: null,
        connectorId: canonicalGatedId,
        connectorInstanceId: canonicalGatedId,
        error: 'schedule.gave_up: {"reason_class":"not_ready","final_consecutive_failures":12,"last_success_at":null}',
        failureReason: null,
        knownGaps: [],
        recordsEmitted: 0,
        reportedRecordsEmitted: null,
        runId: null,
        source: { id: canonicalGatedId, kind: "connector" },
        startedAt: skipCompletedAt,
        status: "skipped",
        terminalReason: null,
        traceId: null,
      })
    );
    await Promise.resolve(
      store.upsertLastRunTime(canonicalGatedId, Date.parse(skipCompletedAt), new Date().toISOString())
    );

    const schedules = await server.controller.listSchedules();
    assert.equal(schedules.length, 1, "gated connector schedule row is listed");
    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const gated = schedules[0];
    assert.ok(gated, "a ScheduleApi row was returned");

    assert.equal(gated.connector_id, canonicalGatedId);
    assert.equal(gated.enabled, true, "persisted operator intent is preserved");
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(gated.ineligibility_reason ?? "", /background-safe|manual/, "gated by manifest refresh_policy");

    // The core repair: under a manifest gate, the row is administratively
    // benched. The stale `schedule.gave_up` / `not_ready` error code from
    // the prior automatic regime must not continue to advertise itself
    // as the current failure mode.
    assert.equal(
      gated.last_error_code,
      null,
      "gated row does not surface stale historical error code as current state"
    );
    assert.equal(gated.next_due_at, null, "gated row will not fire automatically; next_due_at is fiction");

    // Historical anchors stay truthful — they describe events that
    // really happened, regardless of whether the row can fire again.
    assert.equal(gated.last_finished_at, skipCompletedAt);
    assert.equal(gated.last_started_at, olderFailedStartedAt, "last terminal run that actually started is preserved");
    assert.equal(gated.last_successful_at, null);

    // Single-row read must agree.
    const single = await server.controller.getSchedule(canonicalGatedId);
    assert.ok(single);
    assert.equal(single.last_error_code, null);
    assert.equal(single.next_due_at, null);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(single.ineligibility_reason ?? "", /background-safe|manual/);

    // End-to-end doctor probe: GATE, not FIRE; would_fire=false; no
    // stale last_error_code leaks through the JSON surface either.
    const { code, stdout, stderr } = await runProbe(asUrl, { PDPP_OWNER_PASSWORD: ownerPassword });
    assert.equal(code, 0, `probe failed; stderr: ${stderr}`);
    const summary = parseSummary(stdout);
    assert.equal(summary.total, 1);
    assert.equal(summary.enabled, 1);
    assert.equal(summary.ineligible, 1, "reddit is enabled-but-ineligible");
    assert.equal(summary.automatic, 0, "gated row does not fire");
    assert.equal(summary.never_ran, 0, "reddit has run history");
    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const probedReddit = summary.schedules[0];
    assert.ok(probedReddit, "a probed schedule entry was returned");
    assert.equal(probedReddit.would_fire, false);
    assert.equal(probedReddit.last_error_code, null);
    assert.equal(probedReddit.next_due_at, null);
  } finally {
    server.schedulerManager?.stop?.();
    server.asServer.closeAllConnections?.();
    server.rsServer.closeAllConnections?.();
    await new Promise<void>((resolve) => server.asServer.close(() => resolve()));
    await new Promise<void>((resolve) => server.rsServer.close(() => resolve()));
    closeDb();
  }
});

test("controller.listSchedules projects last failure code from history when no active run", async () => {
  // Companion to the success-projection test: a connector whose latest
  // history row is `failed` must surface `last_error_code` from the
  // persisted `terminal_reason` (preferred) or `failure_reason` fallback.
  // Combined with `last_finished_at`, the dashboard and the doctor can
  // both render an actionable "ran but failed N minutes ago" state.
  const { startServer } = await import("../server/index.ts");
  const { getDefaultSchedulerStore } = await import("../server/stores/scheduler-store.ts");
  const { closeDb } = await import("../server/db.ts");
  const { readFileSync } = await import("node:fs");
  const REFERENCE_IMPL_DIR = join(__dirname, "..");
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8"));
  // Store-direct history seeds must use the canonical connector key — the
  // controller projects history under it. See canonicalize-connector-keys.
  const canonicalSpotifyId = canonicalConnectorKey(spotifyManifest.connector_id);
  assert.ok(canonicalSpotifyId, "spotify manifest yields a canonical connector key");
  const ownerPassword = "scheduler-doctor-test-pw-3";

  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: ownerPassword,
    quiet: true,
    rsPort: 0,
  })) as ClosableServer;

  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    await server.controller.upsertSchedule(spotifyManifest.connector_id, {
      enabled: true,
      interval_seconds: 3600,
      jitter_seconds: 0,
    });

    const store = getDefaultSchedulerStore();
    const startedAt = new Date(Date.now() - 120_000).toISOString();
    const completedAt = new Date(Date.now() - 60_000).toISOString();
    // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
    for (let i = 0; i < 2; i++) {
      const olderStartedAt = new Date(Date.now() - (420_000 - i * 120_000)).toISOString();
      const olderCompletedAt = new Date(Date.now() - (360_000 - i * 120_000)).toISOString();
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      await Promise.resolve(
        store.appendRunHistory({
          attempt: i + 1,
          checkpointSummary: null,
          completedAt: olderCompletedAt,
          connectorError: { code: "spotify_oauth_expired", message: "access token expired" },
          connectorId: canonicalSpotifyId,
          connectorInstanceId: canonicalSpotifyId,
          failureReason: "auth_failed",
          knownGaps: [],
          recordsEmitted: 0,
          reportedRecordsEmitted: 0,
          runId: `run_test_history_failed_${i}`,
          source: { id: canonicalSpotifyId, kind: "connector" },
          startedAt: olderStartedAt,
          status: "failed",
          terminalReason: "auth_failed_terminal",
          traceId: `trace_test_history_failed_${i}`,
        })
      );
    }
    await Promise.resolve(
      store.appendRunHistory({
        attempt: 3,
        checkpointSummary: null,
        completedAt,
        connectorError: { code: "spotify_oauth_expired", message: "access token expired" },
        connectorId: canonicalSpotifyId,
        connectorInstanceId: canonicalSpotifyId,
        failureReason: "auth_failed",
        knownGaps: [],
        recordsEmitted: 0,
        reportedRecordsEmitted: 0,
        runId: "run_test_history_failed",
        source: { id: canonicalSpotifyId, kind: "connector" },
        startedAt,
        status: "failed",
        terminalReason: "auth_failed_terminal",
        traceId: "trace_test_history_failed",
      })
    );
    await Promise.resolve(
      store.upsertLastRunTime(canonicalSpotifyId, Date.parse(completedAt), new Date().toISOString())
    );

    const schedules = await server.controller.listSchedules();
    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const spotify = schedules[0];
    assert.ok(spotify, "a ScheduleApi row was returned");
    assert.equal(spotify.last_started_at, startedAt);
    assert.equal(spotify.last_finished_at, completedAt);
    assert.equal(spotify.last_successful_at, null, "no successful run on record");
    assert.equal(
      spotify.last_error_code,
      "auth_failed_terminal",
      "terminal_reason takes precedence over failure_reason"
    );
    assert.ok(spotify.scheduler_backoff, "scheduler backoff projection is present after durable failures");
    assert.equal(spotify.scheduler_backoff.backoff_applied, true);
    assert.equal(spotify.scheduler_backoff.consecutive_failures, 3);
    assert.equal(spotify.scheduler_backoff.reason_class, "terminal:auth_failed_terminal");
    assert.equal(spotify.scheduler_backoff.recommended_health_state, "cooling_off");
    assert.equal(spotify.scheduler_backoff.next_run_at, new Date(Date.parse(completedAt) + 3_600_000).toISOString());
  } finally {
    server.schedulerManager?.stop?.();
    server.asServer.closeAllConnections?.();
    server.rsServer.closeAllConnections?.();
    await new Promise<void>((resolve) => server.asServer.close(() => resolve()));
    await new Promise<void>((resolve) => server.rsServer.close(() => resolve()));
    closeDb();
  }
});

test("controller.listSchedules does not expose raw scheduler error messages as error codes", async () => {
  const { startServer } = await import("../server/index.ts");
  const { getDefaultSchedulerStore } = await import("../server/stores/scheduler-store.ts");
  const { closeDb } = await import("../server/db.ts");
  const { readFileSync } = await import("node:fs");
  const REFERENCE_IMPL_DIR = join(__dirname, "..");
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8"));
  // Store-direct history seeds must use the canonical connector key — the
  // controller projects history under it. See canonicalize-connector-keys.
  const canonicalSpotifyId = canonicalConnectorKey(spotifyManifest.connector_id);
  assert.ok(canonicalSpotifyId, "spotify manifest yields a canonical connector key");
  const ownerPassword = "scheduler-doctor-redaction-pw";
  const secret = "secret-token-should-not-leak";

  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: ownerPassword,
    quiet: true,
    rsPort: 0,
  })) as ClosableServer;

  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    await server.controller.upsertSchedule(spotifyManifest.connector_id, {
      enabled: true,
      interval_seconds: 3600,
      jitter_seconds: 0,
    });

    const completedAt = new Date(Date.now() - 60_000).toISOString();
    await Promise.resolve(
      getDefaultSchedulerStore().appendRunHistory({
        attempt: 1,
        checkpointSummary: null,
        completedAt,
        connectorError: null,
        connectorId: canonicalSpotifyId,
        connectorInstanceId: canonicalSpotifyId,
        error: `network failed with ${secret}`,
        failureReason: null,
        knownGaps: [],
        recordsEmitted: 0,
        reportedRecordsEmitted: 0,
        runId: "run_test_history_raw_error",
        source: { id: canonicalSpotifyId, kind: "connector" },
        startedAt: new Date(Date.now() - 120_000).toISOString(),
        status: "failed",
        terminalReason: null,
        traceId: "trace_test_history_raw_error",
      })
    );
    await Promise.resolve(
      getDefaultSchedulerStore().upsertLastRunTime(
        canonicalSpotifyId,
        Date.parse(completedAt),
        new Date().toISOString()
      )
    );

    const schedules = await server.controller.listSchedules();
    const [redactedSchedule] = schedules;
    assert.ok(redactedSchedule, "a ScheduleApi row was returned");
    assert.equal(redactedSchedule.last_error_code, "scheduler_error");
    assert.doesNotMatch(JSON.stringify(schedules), new RegExp(secret));

    const { code, stdout, stderr } = await runProbe(asUrl, { PDPP_OWNER_PASSWORD: ownerPassword });
    assert.equal(code, 0, `probe failed; stderr: ${stderr}`);
    assert.doesNotMatch(stdout, new RegExp(secret));
  } finally {
    server.schedulerManager?.stop?.();
    server.asServer.closeAllConnections?.();
    server.rsServer.closeAllConnections?.();
    await new Promise<void>((resolve) => server.asServer.close(() => resolve()));
    await new Promise<void>((resolve) => server.rsServer.close(() => resolve()));
    closeDb();
  }
});
