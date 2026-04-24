// Runtime controller service.
//
// Owns long-lived local operator actions against the reference runtime:
//   - persisted one-per-connector schedule config (`connector_schedules` table)
//   - projections for `/_ref/schedules` reads
//   - manual `runNow(connectorId)` with per-connector active-run tracking
//     (surfaces as `POST /_ref/connectors/:connectorId/run`, including the
//     `409 run_already_active` conflict response)
//
// Full runtime orchestration (job lifecycle, connector spawn, record
// ingest, state persistence, retries) still lives in
// `runtime/index.js` / `runtime/scheduler.ts`. The controller wraps, rather
// than replaces, those concerns. Approvals and the connector inventory
// come from `server/auth.js` directly; the controller does not re-export
// them.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createTraceContext, type SpineTraceContext } from "../lib/spine.ts";
import {
  approveOwnerDeviceAuthorization,
  getConnectorManifest,
  initiateOwnerDeviceAuthorization,
} from "../server/auth.js";
import { getDb } from "../server/db.js";
import { getSyncState } from "../server/records.js";
import { runConnector } from "./index.js";

// ─── Path constants ─────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const REFERENCE_MANIFESTS_DIR = join(REFERENCE_IMPL_DIR, "manifests");
const SEED_CONNECTOR_PATH = join(REFERENCE_IMPL_DIR, "connectors", "seed", "index.js");
const POLYFILL_ROOT = join(REFERENCE_IMPL_DIR, "..", "packages", "polyfill-connectors");
const POLYFILL_MANIFESTS_DIR = join(POLYFILL_ROOT, "manifests");
const POLYFILL_CONNECTORS_DIR = join(POLYFILL_ROOT, "connectors");

// Hoisted so the regex compiles once per process, not once per manifest.
const JSON_EXTENSION_RE = /\.json$/;

// ─── Shared domain types ────────────────────────────────────────────────────

export type ConnectorManifest = Record<string, unknown>;

export interface ConnectorSchedulePatch {
  enabled?: boolean;
  interval_seconds: number;
  jitter_seconds?: number;
}

export interface ValidatedSchedulePatch {
  readonly enabled: boolean;
  readonly interval_seconds: number;
  readonly jitter_seconds: number;
}

interface ScheduleRow {
  readonly connector_id: string;
  readonly created_at: string;
  readonly enabled: 0 | 1;
  readonly interval_seconds: number;
  readonly jitter_seconds: number;
  readonly updated_at: string;
}

export interface RuntimeProjection {
  readonly active_run_id: string | null;
  readonly last_error_code: string | null;
  readonly last_finished_at: string | null;
  readonly last_started_at: string | null;
}

export interface ScheduleApi {
  readonly active_run_id: string | null;
  readonly connector_id: string;
  readonly created_at: string;
  readonly enabled: boolean;
  readonly interval_seconds: number;
  readonly jitter_seconds: number;
  readonly last_error_code: string | null;
  readonly last_finished_at: string | null;
  readonly last_started_at: string | null;
  readonly next_due_at: string | null;
  readonly object: "schedule";
  readonly updated_at: string;
}

export interface ActiveRun {
  readonly connector_id: string;
  readonly run_id: string;
  readonly started_at: string;
  readonly trace_id: string;
}

export interface RunNowOptions {
  manifest?: ConnectorManifest;
  ownerToken?: string;
  rsUrl?: string;
  runId?: string;
  scenarioId?: string;
  traceContext?: SpineTraceContext;
}

export interface RunNowResult {
  readonly run_id: string;
  readonly trace_id: string;
}

export type ConnectorPathResolver = (
  connectorId: string,
  manifest?: ConnectorManifest,
  options?: RunNowOptions
) => Promise<string | null> | string | null;

// Minimal structural interface for the better-sqlite3 handle the controller
// touches. We don't import the better-sqlite3 type here so tests can
// fabricate a small in-memory shim without bringing its type tree in.
interface PreparedStatement {
  all<T = unknown>(...params: unknown[]): T[];
  get<T = unknown>(...params: unknown[]): T | undefined;
  run(...params: unknown[]): unknown;
}

interface ControllerDatabase {
  prepare(sql: string): PreparedStatement;
}

interface ControllerLogger {
  error?: (message: string) => void;
}

export interface ControllerOptions {
  asPublicUrl?: string;
  connectorPathResolver?: ConnectorPathResolver;
  db?: ControllerDatabase;
  logger?: ControllerLogger;
  ownerClientId?: string;
  ownerSubjectId?: string;
  rsUrl?: string;
  runtime?: unknown;
  runtimeContext?: { rsUrl?: string };
  scheduler?: unknown;
}

export interface Controller {
  deleteSchedule(connectorId: string): Promise<boolean>;
  getActiveRun(connectorId: string): ActiveRun | null;
  getSchedule(connectorId: string): Promise<ScheduleApi | null>;
  listSchedules(): Promise<ScheduleApi[]>;
  runNow(connectorId: string, options?: RunNowOptions): Promise<RunNowResult>;
  setScheduleEnabled(connectorId: string, enabled: boolean): Promise<ScheduleApi | null>;
  upsertSchedule(connectorId: string, input: ConnectorSchedulePatch): Promise<ScheduleApi | null>;
}

// Controller errors carry a structured `code` the HTTP layer maps into
// RFC 7807 error responses. We expose a named class so callers can do
// typed instanceof checks instead of sniffing duck-typed properties.
export class ControllerError extends Error {
  readonly code: string;
  readonly details: readonly { param: string; message: string }[] | undefined;
  readonly runId: string | undefined;

  constructor(
    message: string,
    code: string,
    extra: { details?: readonly { param: string; message: string }[]; runId?: string } = {}
  ) {
    super(message);
    this.code = code;
    this.details = extra.details;
    this.runId = extra.runId;
    this.name = "ControllerError";
  }
}

// ─── Module-scoped state ────────────────────────────────────────────────────

const activeRuns = new Map<string, ActiveRun>();
let referenceFixtureConnectorIds: Set<string> | null = null;
let polyfillConnectorPaths: Map<string, string> | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Connector-path discovery (cached per-process) ──────────────────────────

function loadReferenceFixtureConnectorIds(): Set<string> {
  if (referenceFixtureConnectorIds) {
    return referenceFixtureConnectorIds;
  }
  const ids = new Set<string>();
  for (const file of readdirSync(REFERENCE_MANIFESTS_DIR)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    try {
      const manifest = JSON.parse(readFileSync(join(REFERENCE_MANIFESTS_DIR, file), "utf8")) as {
        connector_id?: string;
      } | null;
      const connectorId = manifest?.connector_id;
      if (typeof connectorId === "string" && connectorId.trim()) {
        ids.add(connectorId.trim());
      }
    } catch {
      // Ignore malformed local fixture manifests during runtime path discovery.
    }
  }
  referenceFixtureConnectorIds = ids;
  return ids;
}

function loadPolyfillConnectorPaths(): Map<string, string> {
  if (polyfillConnectorPaths) {
    return polyfillConnectorPaths;
  }
  const paths = new Map<string, string>();
  if (!existsSync(POLYFILL_MANIFESTS_DIR)) {
    polyfillConnectorPaths = paths;
    return paths;
  }
  for (const file of readdirSync(POLYFILL_MANIFESTS_DIR)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const connectorName = file.replace(JSON_EXTENSION_RE, "");
    const connectorPath = [
      join(POLYFILL_CONNECTORS_DIR, connectorName, "index.ts"),
      join(POLYFILL_CONNECTORS_DIR, connectorName, "index.js"),
    ].find((candidatePath) => existsSync(candidatePath));
    if (!connectorPath) {
      continue;
    }
    try {
      const manifest = JSON.parse(readFileSync(join(POLYFILL_MANIFESTS_DIR, file), "utf8")) as {
        connector_id?: string;
      } | null;
      const connectorId = manifest?.connector_id;
      if (typeof connectorId === "string" && connectorId.trim()) {
        paths.set(connectorId.trim(), connectorPath);
      }
    } catch {
      // Ignore malformed manifests when building the local connector-path map.
    }
  }
  polyfillConnectorPaths = paths;
  return paths;
}

export function resolveDefaultConnectorPath(connectorId: string): string | null {
  if (loadReferenceFixtureConnectorIds().has(connectorId)) {
    return SEED_CONNECTOR_PATH;
  }
  return loadPolyfillConnectorPaths().get(connectorId) || null;
}

// ─── Schedule helpers ───────────────────────────────────────────────────────

function getRuntimeProjection(connectorId: string): RuntimeProjection {
  const active = activeRuns.get(connectorId) || null;
  if (!active) {
    return {
      active_run_id: null,
      last_started_at: null,
      last_finished_at: null,
      last_error_code: null,
    };
  }
  return {
    active_run_id: active.run_id,
    last_started_at: active.started_at,
    last_finished_at: null,
    last_error_code: null,
  };
}

function validateScheduleInput(input: ConnectorSchedulePatch | null | undefined): ValidatedSchedulePatch {
  const errors: { param: string; message: string }[] = [];
  const interval = Number.parseInt(String(input?.interval_seconds), 10);
  if (!Number.isInteger(interval) || interval < 1) {
    errors.push({
      param: "interval_seconds",
      message: "interval_seconds must be a positive integer",
    });
  }

  let jitter = 0;
  if (input?.jitter_seconds !== undefined) {
    jitter = Number.parseInt(String(input.jitter_seconds), 10);
    if (!Number.isInteger(jitter) || jitter < 0) {
      errors.push({
        param: "jitter_seconds",
        message: "jitter_seconds must be a non-negative integer",
      });
    }
  }

  let enabled = true;
  if (input?.enabled !== undefined) {
    if (input.enabled === true || input.enabled === false) {
      enabled = input.enabled;
    } else {
      errors.push({ param: "enabled", message: "enabled must be a boolean" });
    }
  }

  if (errors.length) {
    throw new ControllerError("Invalid schedule body", "invalid_request", { details: errors });
  }
  return { interval_seconds: interval, jitter_seconds: jitter, enabled };
}

function scheduleRowToApi(
  row: ScheduleRow | null,
  runtimeProjection: RuntimeProjection | null = null
): ScheduleApi | null {
  if (!row) {
    return null;
  }
  return {
    object: "schedule",
    connector_id: row.connector_id,
    interval_seconds: row.interval_seconds,
    jitter_seconds: row.jitter_seconds,
    enabled: !!row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
    next_due_at: null,
    active_run_id: runtimeProjection?.active_run_id || null,
    last_started_at: runtimeProjection?.last_started_at || null,
    last_finished_at: runtimeProjection?.last_finished_at || null,
    last_error_code: runtimeProjection?.last_error_code || null,
  };
}

// ─── Controller factory ─────────────────────────────────────────────────────

/**
 * Create a new controller instance.
 */
export function createController(opts: ControllerOptions = {}): Controller {
  const db: ControllerDatabase = opts.db || (getDb() as ControllerDatabase);
  const log: ControllerLogger = opts.logger || console;
  const resolveConnectorPath = opts.connectorPathResolver || resolveDefaultConnectorPath;
  const ownerClientId = opts.ownerClientId || "cli_longview";
  const ownerSubjectId = opts.ownerSubjectId || "owner_local";

  // `runtime` and `scheduler` are declared in ControllerOptions as hooks
  // for a later slice that will wire runtime state into the schedule
  // projections (next_due_at, last_finished_at, last_error_code). Until
  // then we accept them in the type but don't read them here.

  function getScheduleRow(connectorId: string): ScheduleRow | null {
    const row = db
      .prepare(
        `
      SELECT connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at
      FROM connector_schedules
      WHERE connector_id = ?
    `
      )
      .get<ScheduleRow>(connectorId);
    return row ?? null;
  }

  function currentRsUrl(override: string | undefined): string {
    if (override) {
      return override;
    }
    if (typeof opts.rsUrl === "string" && opts.rsUrl) {
      return opts.rsUrl;
    }
    const contextUrl = opts.runtimeContext?.rsUrl;
    if (typeof contextUrl === "string" && contextUrl) {
      return contextUrl;
    }
    return process.env.RS_URL || "http://localhost:7663";
  }

  async function issueRuntimeOwnerToken(): Promise<string> {
    const device = await initiateOwnerDeviceAuthorization(ownerClientId, {
      baseUrl: opts.asPublicUrl || process.env.AS_PUBLIC_URL || undefined,
    });
    const approved = await approveOwnerDeviceAuthorization(device.user_code, ownerSubjectId);
    return approved.access_token;
  }

  // Schedule reads/writes are synchronous against the sqlite handle, but we
  // keep the controller surface async so future slices can add I/O (e.g.
  // mirroring to a remote control plane) without a signature break.
  // Wrapping in Promise.resolve keeps the returned type Promise<T> honestly
  // without triggering ultracite's `useAwait` (which requires `async` fns
  // to contain at least one await).
  function listSchedules(): Promise<ScheduleApi[]> {
    const rows = db
      .prepare(
        `
      SELECT connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at
      FROM connector_schedules
      ORDER BY connector_id ASC
    `
      )
      .all<ScheduleRow>();
    return Promise.resolve(
      rows.flatMap((row) => {
        const api = scheduleRowToApi(row, getRuntimeProjection(row.connector_id));
        return api ? [api] : [];
      })
    );
  }

  function getSchedule(connectorId: string): Promise<ScheduleApi | null> {
    const row = getScheduleRow(connectorId);
    return Promise.resolve(row ? scheduleRowToApi(row, getRuntimeProjection(connectorId)) : null);
  }

  function upsertSchedule(connectorId: string, input: ConnectorSchedulePatch): Promise<ScheduleApi | null> {
    const now = nowIso();
    const validated = validateScheduleInput(input);
    const existing = getScheduleRow(connectorId);
    if (existing) {
      db.prepare(
        `
        UPDATE connector_schedules
        SET interval_seconds = ?, jitter_seconds = ?, enabled = ?, updated_at = ?
        WHERE connector_id = ?
      `
      ).run(validated.interval_seconds, validated.jitter_seconds, validated.enabled ? 1 : 0, now, connectorId);
    } else {
      db.prepare(
        `
        INSERT INTO connector_schedules(connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?)
      `
      ).run(connectorId, validated.interval_seconds, validated.jitter_seconds, validated.enabled ? 1 : 0, now, now);
    }
    return Promise.resolve(scheduleRowToApi(getScheduleRow(connectorId), getRuntimeProjection(connectorId)));
  }

  function setScheduleEnabled(connectorId: string, enabled: boolean): Promise<ScheduleApi | null> {
    const existing = getScheduleRow(connectorId);
    if (!existing) {
      return Promise.reject(new ControllerError(`Schedule not found for connector: ${connectorId}`, "not_found"));
    }
    db.prepare(
      `
      UPDATE connector_schedules
      SET enabled = ?, updated_at = ?
      WHERE connector_id = ?
    `
    ).run(enabled ? 1 : 0, nowIso(), connectorId);
    return Promise.resolve(scheduleRowToApi(getScheduleRow(connectorId), getRuntimeProjection(connectorId)));
  }

  function deleteSchedule(connectorId: string): Promise<boolean> {
    const existing = getScheduleRow(connectorId);
    if (!existing) {
      return Promise.resolve(false);
    }
    db.prepare("DELETE FROM connector_schedules WHERE connector_id = ?").run(connectorId);
    return Promise.resolve(true);
  }

  function getActiveRun(connectorId: string): ActiveRun | null {
    return activeRuns.get(connectorId) || null;
  }

  async function runNow(connectorId: string, options: RunNowOptions = {}): Promise<RunNowResult> {
    const existing = activeRuns.get(connectorId);
    if (existing) {
      throw new ControllerError(`Connector already has an active run: ${existing.run_id}`, "run_already_active", {
        runId: existing.run_id,
      });
    }

    const manifest: ConnectorManifest | null | undefined =
      options.manifest ?? (await getConnectorManifest(connectorId));
    if (!manifest) {
      throw new ControllerError(`Unknown connector: ${connectorId}`, "not_found");
    }

    const connectorPath = await Promise.resolve(resolveConnectorPath(connectorId, manifest, options));
    if (!connectorPath) {
      throw new ControllerError(`No runnable connector implementation is available for ${connectorId}`, "not_found");
    }

    const syncState = (await getSyncState(connectorId)) as { state?: unknown } | null;
    const rawState = syncState?.state;
    const state: Record<string, unknown> | null =
      rawState && typeof rawState === "object" && !Array.isArray(rawState) && Object.keys(rawState).length
        ? (rawState as Record<string, unknown>)
        : null;
    const collectionMode: "full_refresh" | "incremental" = state ? "incremental" : "full_refresh";
    const ownerToken = options.ownerToken || (await issueRuntimeOwnerToken());
    const traceContext =
      options.traceContext ??
      (options.scenarioId ? createTraceContext({ scenarioId: options.scenarioId }) : createTraceContext());
    const runId = options.runId || `run_${Date.now()}`;

    activeRuns.set(connectorId, {
      connector_id: connectorId,
      run_id: runId,
      trace_id: traceContext.trace_id,
      started_at: nowIso(),
    });

    // Fire-and-forget: runNow returns the run handle immediately; the
    // actual connector execution resolves later and clears activeRuns
    // in the finally. We don't await the runtime result because callers
    // poll the projection via getActiveRun / listSchedules.
    runConnector({
      connectorPath,
      connectorId,
      ownerToken,
      manifest,
      state,
      collectionMode,
      rsUrl: currentRsUrl(options.rsUrl),
      runId,
      traceContext,
      onProgress: () => {
        // no-op; progress is persisted via the event spine, not this callback.
      },
    })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error?.(`[controller] manual run failed for ${connectorId}: ${message}`);
      })
      .finally(() => {
        activeRuns.delete(connectorId);
      });

    return { run_id: runId, trace_id: traceContext.trace_id };
  }

  return {
    listSchedules,
    getSchedule,
    upsertSchedule,
    setScheduleEnabled,
    deleteSchedule,
    getActiveRun,
    runNow,
    // Approval + connector inventory live in `auth.js`
    // (`listPendingApprovals`, `listConnectors`, `getConnectorManifest`).
    // Route handlers call those helpers directly; the controller does not
    // re-export them.
  };
}
