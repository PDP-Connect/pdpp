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

import { getOne, referenceQueries } from "../lib/db.ts";
import { createTraceContext, emitSpineEvent, type SpineTraceContext } from "../lib/spine.ts";
import {
  approveOwnerDeviceAuthorization,
  getConnectorManifest,
  initiateOwnerDeviceAuthorization,
} from "../server/auth.js";
import { isPostgresStorageBackend, postgresQuery } from "../server/postgres-storage.js";
import { getSyncState } from "../server/records.js";
import {
  type ActiveRunRecord,
  getDefaultSchedulerStore,
  type ScheduleRecord,
  type SchedulerStore,
} from "../server/stores/scheduler-store.ts";
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

export interface ScheduleUpsertResult {
  readonly policy_warning: string | null;
  readonly schedule: ScheduleApi;
}

export interface ValidatedSchedulePatch {
  readonly enabled: boolean;
  readonly interval_seconds: number;
  readonly jitter_seconds: number;
}

// Domain record shapes are owned by the scheduler store; re-aliased here
// so the controller stays semantic ("a schedule", "a persisted active run")
// rather than touching SQLite-flavored row shapes directly.
type Schedule = ScheduleRecord;
type PersistedActiveRun = ActiveRunRecord;

interface TerminalRunRow {
  readonly present: 1;
}

export interface RuntimeProjection {
  readonly active_run_id: string | null;
  readonly human_attention_needed: boolean;
  readonly last_error_code: string | null;
  readonly last_finished_at: string | null;
  readonly last_started_at: string | null;
  readonly last_successful_at: string | null;
}

export interface RefreshPolicy {
  readonly background_safe?: boolean;
  readonly bot_detection_sensitivity?: "high" | "low" | "medium";
  readonly interaction_posture?: "credentials" | "manual_action_likely" | "none" | "otp_likely";
  readonly maximum_staleness_seconds?: number;
  readonly minimum_interval_seconds?: number;
  readonly rate_limit_sensitivity?: "high" | "low" | "medium";
  readonly rationale?: string;
  readonly recommended_interval_seconds?: number;
  readonly recommended_mode?: "automatic" | "manual" | "paused";
  readonly session_lifetime_seconds?: number;
}

export interface ScheduleApi {
  readonly active_run_id: string | null;
  readonly connector_id: string;
  readonly created_at: string;
  readonly effective_mode: "automatic" | "manual" | "paused";
  readonly enabled: boolean;
  readonly human_attention_needed: boolean;
  readonly interval_seconds: number;
  readonly jitter_seconds: number;
  readonly last_error_code: string | null;
  readonly last_finished_at: string | null;
  readonly last_started_at: string | null;
  readonly last_successful_at: string | null;
  readonly minimum_interval_warning: string | null;
  readonly next_due_at: string | null;
  readonly object: "schedule";
  readonly recommended_policy: RefreshPolicy | null;
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

export interface RunInteractionResponseInput {
  readonly data?: unknown;
  readonly interaction_id?: unknown;
  readonly status?: unknown;
}

export interface RunInteractionAck {
  readonly accepted: true;
  readonly status: "cancelled" | "success";
}

export interface PendingInteractionProjection {
  readonly connector_id: string;
  readonly interaction_id: string;
  readonly kind: string;
  readonly run_id: string;
  readonly stream: string | null;
}

export type ConnectorPathResolver = (
  connectorId: string,
  manifest?: ConnectorManifest,
  options?: RunNowOptions
) => Promise<string | null> | string | null;

interface ControllerLogger {
  error?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface ControllerOptions {
  asPublicUrl?: string;
  connectorPathResolver?: ConnectorPathResolver;
  logger?: ControllerLogger;
  ownerClientId?: string;
  ownerSubjectId?: string;
  rsUrl?: string;
  runtime?: unknown;
  runtimeContext?: { rsUrl?: string };
  scheduler?: unknown;
  // Optional store override; defaults to the configured storage-backed singleton.
  // Tests use this to substitute fakes without touching module-scoped state.
  schedulerStore?: SchedulerStore;
}

export interface Controller {
  clearNeedsHuman(connectorId: string): void;
  deleteSchedule(connectorId: string): Promise<boolean>;
  getActiveRun(connectorId: string): ActiveRun | null;
  getPendingInteraction(runId: string): PendingInteractionProjection | null;
  getSchedule(connectorId: string): Promise<ScheduleApi | null>;
  listSchedules(): Promise<ScheduleApi[]>;
  markNeedsHuman(connectorId: string): void;
  respondToInteraction(runId: string, input?: RunInteractionResponseInput): RunInteractionAck;
  runNow(connectorId: string, options?: RunNowOptions): Promise<RunNowResult>;
  setScheduleEnabled(connectorId: string, enabled: boolean): Promise<ScheduleApi | null>;
  upsertSchedule(connectorId: string, input: ConnectorSchedulePatch): Promise<ScheduleUpsertResult>;
}

interface RuntimeInteraction {
  readonly kind: string;
  readonly request_id: string;
  readonly stream?: string | null;
}

interface InteractionResponse {
  data?: Record<string, unknown>;
  readonly request_id: string;
  readonly status: "cancelled" | "success";
  readonly type: "INTERACTION_RESPONSE";
}

interface PendingInteraction {
  readonly interaction_id: string;
  readonly kind: string;
  readonly resolve: (response: InteractionResponse) => void;
  readonly stream: string | null;
}

interface ActiveRunInteraction {
  connector_id: string;
  pending: PendingInteraction | null;
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
// Keyed by run_id. Interaction broker state is intentionally in-memory:
// dashboard-submitted values satisfy the current live run only and are never
// persisted to `.env.local`, SQLite config/state, or spine event payloads.
const activeRunInteractions = new Map<string, ActiveRunInteraction>();
// Connectors where an automatic background run surfaced an unresolvable
// human-attention interaction. The scheduler checks this before launching
// new automatic attempts so high-friction connectors don't spam OTP/login
// requests in the background. Manual "run now" bypasses this flag.
const needsHumanAttention = new Set<string>();
interface ManifestFingerprint {
  readonly streams: string;
  readonly version: string;
}
let referenceFixtureFingerprints: Map<string, ManifestFingerprint> | null = null;
let polyfillManifestFingerprints: Map<string, ManifestFingerprint> | null = null;
let polyfillConnectorPaths: Map<string, string> | null = null;
const ABANDONED_CONTROLLER_RUN_REASON = "controller_restarted";

function buildRunSource(connectorId: string): { binding_kind: "connector"; connector_id: string } {
  return { binding_kind: "connector", connector_id: connectorId };
}

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Connector-path discovery (cached per-process) ──────────────────────────

// A manifest fingerprint is a cheap, stable summary used to tell the
// reference fixture manifest apart from the shipped polyfill manifest when
// they share the same `connector_id`. We compare version plus the sorted
// list of declared stream names — that is enough to distinguish the two
// github.json files today without pulling in a full JSON equality check.
function fingerprintManifest(manifest: ConnectorManifest | null | undefined): ManifestFingerprint | null {
  if (!manifest || typeof manifest !== "object") {
    return null;
  }
  const version =
    typeof (manifest as { version?: unknown }).version === "string" ? (manifest as { version: string }).version : "";
  const rawStreams = (manifest as { streams?: unknown }).streams;
  const streamNames: string[] = [];
  if (Array.isArray(rawStreams)) {
    for (const stream of rawStreams) {
      const name = (stream as { name?: unknown } | null)?.name;
      if (typeof name === "string" && name.trim()) {
        streamNames.push(name.trim());
      }
    }
  }
  streamNames.sort();
  return { version, streams: streamNames.join(",") };
}

function fingerprintsEqual(a: ManifestFingerprint | null, b: ManifestFingerprint | null): boolean {
  return !!(a && b && a.version === b.version && a.streams === b.streams);
}

function loadReferenceFixtureFingerprints(): Map<string, ManifestFingerprint> {
  if (referenceFixtureFingerprints) {
    return referenceFixtureFingerprints;
  }
  const entries = new Map<string, ManifestFingerprint>();
  for (const file of readdirSync(REFERENCE_MANIFESTS_DIR)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    try {
      const manifest = JSON.parse(
        readFileSync(join(REFERENCE_MANIFESTS_DIR, file), "utf8")
      ) as ConnectorManifest | null;
      const connectorId = (manifest as { connector_id?: unknown } | null)?.connector_id;
      if (typeof connectorId !== "string" || !connectorId.trim()) {
        continue;
      }
      const fp = fingerprintManifest(manifest);
      if (fp) {
        entries.set(connectorId.trim(), fp);
      }
    } catch {
      // Ignore malformed local fixture manifests during runtime path discovery.
    }
  }
  referenceFixtureFingerprints = entries;
  return entries;
}

function loadPolyfillConnectorPaths(): Map<string, string> {
  if (polyfillConnectorPaths) {
    return polyfillConnectorPaths;
  }
  const paths = new Map<string, string>();
  const fingerprints = new Map<string, ManifestFingerprint>();
  if (!existsSync(POLYFILL_MANIFESTS_DIR)) {
    polyfillConnectorPaths = paths;
    polyfillManifestFingerprints = fingerprints;
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
      const manifest = JSON.parse(readFileSync(join(POLYFILL_MANIFESTS_DIR, file), "utf8")) as ConnectorManifest | null;
      const connectorId = (manifest as { connector_id?: unknown } | null)?.connector_id;
      if (typeof connectorId !== "string" || !connectorId.trim()) {
        continue;
      }
      const trimmedId = connectorId.trim();
      paths.set(trimmedId, connectorPath);
      const fp = fingerprintManifest(manifest);
      if (fp) {
        fingerprints.set(trimmedId, fp);
      }
    } catch {
      // Ignore malformed manifests when building the local connector-path map.
    }
  }
  polyfillConnectorPaths = paths;
  polyfillManifestFingerprints = fingerprints;
  return paths;
}

function loadPolyfillManifestFingerprints(): Map<string, ManifestFingerprint> {
  if (!polyfillManifestFingerprints) {
    loadPolyfillConnectorPaths();
  }
  return polyfillManifestFingerprints ?? new Map<string, ManifestFingerprint>();
}

// Resolve the connector-implementation path for a controller-managed run.
//
// Why this is non-trivial: the reference fixture manifests in
// reference-implementation/manifests/ and the shipped polyfill manifests in
// packages/polyfill-connectors/manifests/ can share a `connector_id`
// (for example, GitHub). The reference fixture is served by the seed
// connector at reference-implementation/connectors/seed/index.js, while
// the shipped polyfill connector lives at
// packages/polyfill-connectors/connectors/<name>/index.ts. Silently
// preferring the seed on collision caused a protocol violation: the seed
// GitHub fixture emits a `commits` PROGRESS stream that the polyfill
// manifest does not declare.
//
// Rules applied here, in order:
//   1. When the caller passes the active manifest, compare a stable
//      fingerprint (version + sorted stream names) against the on-disk
//      reference fixture and polyfill manifests for that connector_id:
//        - match polyfill → polyfill connector path;
//        - match reference → seed connector path;
//   2. No match, or no manifest provided: prefer the shipped polyfill
//      connector when it exists. Polyfill is the deployed production
//      surface; the seed is a fixture kept for explicit reference fixture
//      manifests and tests.
//   3. Fall back to the seed connector only when the reference fixture has
//      a manifest for this connector_id. Unknown ids resolve to null.
export function resolveDefaultConnectorPath(connectorId: string, manifest?: ConnectorManifest): string | null {
  const referenceFingerprints = loadReferenceFixtureFingerprints();
  const polyfillFingerprints = loadPolyfillManifestFingerprints();
  const polyfillPaths = loadPolyfillConnectorPaths();
  const polyfillPath = polyfillPaths.get(connectorId) || null;
  const hasReferenceFixture = referenceFingerprints.has(connectorId);

  const activeFingerprint = fingerprintManifest(manifest ?? null);
  if (activeFingerprint) {
    if (polyfillPath && fingerprintsEqual(activeFingerprint, polyfillFingerprints.get(connectorId) ?? null)) {
      return polyfillPath;
    }
    if (hasReferenceFixture && fingerprintsEqual(activeFingerprint, referenceFingerprints.get(connectorId) ?? null)) {
      return SEED_CONNECTOR_PATH;
    }
  }

  if (polyfillPath) {
    return polyfillPath;
  }
  if (hasReferenceFixture) {
    return SEED_CONNECTOR_PATH;
  }
  return null;
}

// Reset cached manifest/path discovery. Tests rewrite manifest files on
// disk during setup; without a reset hook the first test's cached maps
// would mask later ones.
export function __resetControllerPathResolverCachesForTests(): void {
  referenceFixtureFingerprints = null;
  polyfillManifestFingerprints = null;
  polyfillConnectorPaths = null;
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
      last_successful_at: null,
      human_attention_needed: needsHumanAttention.has(connectorId),
    };
  }
  return {
    active_run_id: active.run_id,
    last_started_at: active.started_at,
    last_finished_at: null,
    last_error_code: null,
    last_successful_at: null,
    human_attention_needed: needsHumanAttention.has(connectorId),
  };
}

function brokerInteraction(
  runId: string,
  connectorId: string,
  interaction: RuntimeInteraction
): Promise<InteractionResponse> {
  return new Promise((resolve) => {
    const entry = activeRunInteractions.get(runId) ?? { connector_id: connectorId, pending: null };
    if (entry.pending) {
      resolve({
        type: "INTERACTION_RESPONSE",
        request_id: interaction.request_id,
        status: "cancelled",
      });
      return;
    }

    entry.connector_id = connectorId;
    entry.pending = {
      interaction_id: interaction.request_id,
      kind: interaction.kind,
      stream: interaction.stream || null,
      resolve,
    };
    activeRunInteractions.set(runId, entry);
  });
}

export function __resetControllerInteractionStateForTests(): void {
  activeRunInteractions.clear();
  activeRuns.clear();
  needsHumanAttention.clear();
}

export function isNeedsHumanAttention(connectorId: string): boolean {
  return needsHumanAttention.has(connectorId);
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

function computeEffectiveMode(
  schedule: Schedule,
  runtimeProjection: RuntimeProjection | null
): "automatic" | "manual" | "paused" {
  if (!schedule.enabled) {
    return "paused";
  }
  if (runtimeProjection?.human_attention_needed) {
    return "paused";
  }
  return "automatic";
}

function buildMinimumIntervalWarning(intervalSeconds: number, policy: RefreshPolicy | null): string | null {
  if (!policy) {
    return null;
  }
  const minimum = policy.minimum_interval_seconds;
  const recommended = policy.recommended_interval_seconds;
  if (minimum !== undefined && intervalSeconds < minimum) {
    return `Interval ${intervalSeconds}s is below the connector's minimum recommended interval of ${minimum}s. This may cause rate-limiting or platform blocks.`;
  }
  if (recommended !== undefined && intervalSeconds < recommended) {
    return `Interval ${intervalSeconds}s is below the connector's recommended interval of ${recommended}s.`;
  }
  return null;
}

function scheduleToApi(
  schedule: Schedule | null,
  runtimeProjection: RuntimeProjection | null = null,
  policy: RefreshPolicy | null = null
): ScheduleApi | null {
  if (!schedule) {
    return null;
  }
  const effectiveMode = computeEffectiveMode(schedule, runtimeProjection);
  const humanAttentionNeeded = runtimeProjection?.human_attention_needed ?? false;
  const minimumIntervalWarning = buildMinimumIntervalWarning(schedule.interval_seconds, policy);
  return {
    object: "schedule",
    connector_id: schedule.connector_id,
    interval_seconds: schedule.interval_seconds,
    jitter_seconds: schedule.jitter_seconds,
    enabled: schedule.enabled,
    created_at: schedule.created_at,
    updated_at: schedule.updated_at,
    next_due_at: null,
    active_run_id: runtimeProjection?.active_run_id || null,
    last_started_at: runtimeProjection?.last_started_at || null,
    last_finished_at: runtimeProjection?.last_finished_at || null,
    last_error_code: runtimeProjection?.last_error_code || null,
    last_successful_at: runtimeProjection?.last_successful_at || null,
    effective_mode: effectiveMode,
    human_attention_needed: humanAttentionNeeded,
    recommended_policy: policy,
    minimum_interval_warning: minimumIntervalWarning,
  };
}

// ─── Controller factory ─────────────────────────────────────────────────────

/**
 * Create a new controller instance.
 */
export function createController(opts: ControllerOptions = {}): Controller {
  const log: ControllerLogger = opts.logger || console;
  const resolveConnectorPath = opts.connectorPathResolver || resolveDefaultConnectorPath;
  const ownerClientId = opts.ownerClientId || "cli_longview";
  const ownerSubjectId = opts.ownerSubjectId || "owner_local";
  const schedulerStore = opts.schedulerStore || getDefaultSchedulerStore();

  // `runtime` and `scheduler` are declared in ControllerOptions as hooks
  // for a later slice that will wire runtime state into the schedule
  // projections (next_due_at, last_finished_at, last_error_code). Until
  // then we accept them in the type but don't read them here.

  function listPersistedActiveRuns(): Promise<readonly PersistedActiveRun[]> {
    return Promise.resolve(schedulerStore.listActiveRuns());
  }

  async function persistActiveRun(record: PersistedActiveRun): Promise<void> {
    await schedulerStore.upsertActiveRun(record);
  }

  async function clearPersistedActiveRun(connectorId: string, runId: string): Promise<void> {
    await schedulerStore.deleteActiveRun(connectorId, runId);
  }

  async function runAlreadyTerminal(runId: string): Promise<boolean> {
    if (isPostgresStorageBackend()) {
      const { rows } = await postgresQuery(
        `
        SELECT 1 AS present
        FROM spine_events
        WHERE run_id = $1
          AND event_type IN ('run.completed', 'run.failed')
        LIMIT 1
        `,
        [runId]
      );
      return Boolean(rows[0]);
    }

    const row = getOne<TerminalRunRow>(referenceQueries.spineCheckRunTerminal, [runId]);
    return Boolean(row);
  }

  async function reconcileAbandonedControllerRuns(): Promise<void> {
    const rows = await listPersistedActiveRuns();
    if (rows.length === 0) {
      return;
    }

    for (const row of rows) {
      if (!(await runAlreadyTerminal(row.run_id))) {
        try {
          await emitSpineEvent({
            event_type: "run.failed",
            trace_id: row.trace_id,
            scenario_id: row.scenario_id,
            actor_type: "runtime",
            actor_id: row.connector_id,
            object_type: "run",
            object_id: row.run_id,
            status: "failed",
            run_id: row.run_id,
            data: {
              source: buildRunSource(row.connector_id),
              reason: ABANDONED_CONTROLLER_RUN_REASON,
              failure_reason: ABANDONED_CONTROLLER_RUN_REASON,
              message: "Reference server restarted while a controller-managed run was still active.",
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn?.(`[controller] failed to emit restart reconciliation event for ${row.run_id}: ${message}`);
        }
      }
      await clearPersistedActiveRun(row.connector_id, row.run_id);
    }

    for (const row of rows) {
      log.warn?.(`[controller] reconciled abandoned controller-managed run ${row.run_id} for ${row.connector_id}`);
    }
  }

  reconcileAbandonedControllerRuns().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    log.warn?.(`[controller] failed to reconcile abandoned controller-managed runs: ${message}`);
  });

  function getScheduleRecord(connectorId: string): Promise<Schedule | null> {
    return Promise.resolve(schedulerStore.getSchedule(connectorId));
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

  async function getConnectorRefreshPolicy(connectorId: string): Promise<RefreshPolicy | null> {
    try {
      const manifest = await getConnectorManifest(connectorId);
      if (!manifest || typeof manifest !== "object") {
        return null;
      }
      const caps = (manifest as { capabilities?: unknown }).capabilities;
      if (!caps || typeof caps !== "object") {
        return null;
      }
      const policy = (caps as { refresh_policy?: unknown }).refresh_policy;
      if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
        return null;
      }
      return policy as RefreshPolicy;
    } catch {
      return null;
    }
  }

  async function listSchedules(): Promise<ScheduleApi[]> {
    const schedules = await schedulerStore.listSchedules();
    const apis = await Promise.all(
      schedules.map(async (schedule) => {
        const policy = await getConnectorRefreshPolicy(schedule.connector_id);
        return scheduleToApi(schedule, getRuntimeProjection(schedule.connector_id), policy);
      })
    );
    return apis.flatMap((api) => (api ? [api] : []));
  }

  async function getSchedule(connectorId: string): Promise<ScheduleApi | null> {
    const schedule = await getScheduleRecord(connectorId);
    if (!schedule) {
      return null;
    }
    const policy = await getConnectorRefreshPolicy(connectorId);
    return scheduleToApi(schedule, getRuntimeProjection(connectorId), policy);
  }

  async function upsertSchedule(connectorId: string, input: ConnectorSchedulePatch): Promise<ScheduleUpsertResult> {
    const now = nowIso();
    const validated = validateScheduleInput(input);
    const existing = await getScheduleRecord(connectorId);
    if (existing) {
      await schedulerStore.updateSchedule(connectorId, {
        interval_seconds: validated.interval_seconds,
        jitter_seconds: validated.jitter_seconds,
        enabled: validated.enabled,
        updated_at: now,
      });
    } else {
      await schedulerStore.createSchedule({
        connector_id: connectorId,
        interval_seconds: validated.interval_seconds,
        jitter_seconds: validated.jitter_seconds,
        enabled: validated.enabled,
        created_at: now,
        updated_at: now,
      });
    }
    const policy = await getConnectorRefreshPolicy(connectorId);
    const schedule = scheduleToApi(await getScheduleRecord(connectorId), getRuntimeProjection(connectorId), policy);
    if (!schedule) {
      throw new ControllerError(`Schedule not found after upsert for connector: ${connectorId}`, "internal_error");
    }
    const policy_warning = buildMinimumIntervalWarning(validated.interval_seconds, policy);
    return { schedule, policy_warning };
  }

  async function setScheduleEnabled(connectorId: string, enabled: boolean): Promise<ScheduleApi | null> {
    const existing = await getScheduleRecord(connectorId);
    if (!existing) {
      throw new ControllerError(`Schedule not found for connector: ${connectorId}`, "not_found");
    }
    await schedulerStore.setScheduleEnabled(connectorId, enabled, nowIso());
    const policy = await getConnectorRefreshPolicy(connectorId);
    return scheduleToApi(await getScheduleRecord(connectorId), getRuntimeProjection(connectorId), policy);
  }

  function markNeedsHuman(connectorId: string): void {
    needsHumanAttention.add(connectorId);
  }

  function clearNeedsHuman(connectorId: string): void {
    needsHumanAttention.delete(connectorId);
  }

  async function deleteSchedule(connectorId: string): Promise<boolean> {
    const existing = await getScheduleRecord(connectorId);
    if (!existing) {
      return false;
    }
    await schedulerStore.deleteSchedule(connectorId);
    return true;
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
    const startedAt = nowIso();

    // Manual run initiated by the owner: clear any pending human-attention flag
    // so the scheduler can resume automatic runs after this interaction resolves.
    needsHumanAttention.delete(connectorId);

    await persistActiveRun({
      connector_id: connectorId,
      run_id: runId,
      trace_id: traceContext.trace_id,
      scenario_id: traceContext.scenario_id,
      started_at: startedAt,
    });
    activeRuns.set(connectorId, {
      connector_id: connectorId,
      run_id: runId,
      trace_id: traceContext.trace_id,
      started_at: startedAt,
    });
    activeRunInteractions.set(runId, {
      connector_id: connectorId,
      pending: null,
    });
    const interactionHandler = (interaction: unknown) =>
      brokerInteraction(runId, connectorId, interaction as RuntimeInteraction);

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
      onInteraction: interactionHandler,
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
        clearPersistedActiveRun(connectorId, runId).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          log.warn?.(`[controller] failed to clear active run ${runId} for ${connectorId}: ${message}`);
        });
        const leftover = activeRunInteractions.get(runId);
        activeRunInteractions.delete(runId);
        if (leftover?.pending) {
          leftover.pending.resolve({
            type: "INTERACTION_RESPONSE",
            request_id: leftover.pending.interaction_id,
            status: "cancelled",
          });
        }
      });

    return { run_id: runId, trace_id: traceContext.trace_id };
  }

  function respondToInteraction(runId: string, input: RunInteractionResponseInput = {}): RunInteractionAck {
    const entry = activeRunInteractions.get(runId);
    if (!entry) {
      throw new ControllerError(`No active run with id: ${runId}`, "not_found");
    }
    if (!entry.pending) {
      throw new ControllerError(`Active run ${runId} has no pending interaction`, "no_pending_interaction");
    }

    const interactionId = input.interaction_id;
    if (typeof interactionId !== "string" || !interactionId.trim() || interactionId !== entry.pending.interaction_id) {
      throw new ControllerError(
        `Stale interaction_id for run ${runId}: expected ${entry.pending.interaction_id}`,
        "interaction_id_mismatch"
      );
    }
    if (input.status !== "success" && input.status !== "cancelled") {
      throw new ControllerError(`Invalid interaction status: ${String(input.status)}`, "invalid_status");
    }

    const response: InteractionResponse = {
      type: "INTERACTION_RESPONSE",
      request_id: interactionId,
      status: input.status,
    };
    const data = input.data;
    if (input.status === "success" && data && typeof data === "object" && !Array.isArray(data)) {
      response.data = data as Record<string, unknown>;
    }

    const pending = entry.pending;
    entry.pending = null;
    pending.resolve(response);
    return { accepted: true, status: input.status };
  }

  function getPendingInteraction(runId: string): PendingInteractionProjection | null {
    const entry = activeRunInteractions.get(runId);
    if (!entry?.pending) {
      return null;
    }
    return {
      run_id: runId,
      connector_id: entry.connector_id,
      interaction_id: entry.pending.interaction_id,
      kind: entry.pending.kind,
      stream: entry.pending.stream || null,
    };
  }

  return {
    listSchedules,
    getSchedule,
    upsertSchedule,
    setScheduleEnabled,
    deleteSchedule,
    getActiveRun,
    getPendingInteraction,
    respondToInteraction,
    runNow,
    markNeedsHuman,
    clearNeedsHuman,
    // Approval + connector inventory live in `auth.js`
    // (`listPendingApprovals`, `listConnectors`, `getConnectorManifest`).
    // Route handlers call those helpers directly; the controller does not
    // re-export them.
  };
}
