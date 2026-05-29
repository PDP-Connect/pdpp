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

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BrowserSurface,
  type BrowserSurfaceAllocator,
  type BrowserSurfaceLease,
  type BrowserSurfaceLeaseManager,
  type BrowserSurfaceProjection,
  projectBrowserSurfaceLease,
} from "@opendatalabs/remote-surface/leases";
import { getOne, referenceQueries } from "../lib/db.ts";
import { createTraceContext, emitSpineEvent, type SpineTraceContext } from "../lib/spine.ts";
import {
  approveOwnerDeviceAuthorization,
  getConnectorManifest,
  initiateOwnerDeviceAuthorization,
} from "../server/auth.js";
import { canonicalConnectorKey, canonicalConnectorKeyFromManifest } from "../server/connector-key.js";
import { isPostgresStorageBackend, postgresQuery } from "../server/postgres-storage.js";
import { getSyncState } from "../server/records.js";
import type { BrowserSurfaceLeaseStore } from "../server/stores/browser-surface-lease-store.ts";
import {
  type ActiveRunRecord,
  getDefaultSchedulerStore,
  type ScheduleRecord,
  type SchedulerLastRunTimeRecord,
  type SchedulerRunHistoryRecord,
  type SchedulerStore,
} from "../server/stores/scheduler-store.ts";
import { browserSurfaceLeaseEnv } from "./browser-surface-leases.ts";
import { readBrowserSurfaceProfileKey } from "./browser-surface-profile-key.ts";
import type { BrowserSurfaceReadinessProbe, BrowserSurfaceReadinessProbeResult } from "./browser-surface-readiness.ts";
import { runConnector } from "./index.js";
import {
  automaticIneligibilityReason,
  automationModeCopy,
  projectRunAutomationPolicy,
  type RunAutomationMode,
  type RunTriggerKind,
} from "./run-automation-policy.ts";
import type { RunRecord } from "./scheduler.ts";
import { type BackoffDecision, computeNextRunWithBackoff } from "./scheduler-backoff.ts";

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

// Shared no-op allocator used when no real BrowserSurfaceAllocator is wired.
// ensureSurface throws because the runtime should never silently allocate
// without a configured backend; the other methods report "nothing here".
const UNCONFIGURED_BROWSER_SURFACE_ALLOCATOR: BrowserSurfaceAllocator = {
  ensureSurface: () => Promise.reject(new Error("browser surface allocator is not configured")),
  getSurfaceStatus: () => Promise.resolve(null),
  stopSurface: () => Promise.resolve(null),
  listSurfaces: () => Promise.resolve([]),
};

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
  readonly browser_surface_lease_id?: string;
  readonly browser_surface_profile_key?: string;
  readonly browser_surface_status?: BrowserSurfaceProjection["browser_surface_status"];
  readonly browser_surface_wait_reason?: BrowserSurfaceProjection["browser_surface_wait_reason"];
  readonly human_attention_needed: boolean;
  readonly last_error_code: string | null;
  readonly last_finished_at: string | null;
  readonly last_started_at: string | null;
  readonly last_successful_at: string | null;
  readonly pending_run_id?: string;
}

export interface SchedulerBackoffApi {
  readonly backoff_applied: boolean;
  readonly consecutive_failures: number;
  readonly next_run_at: string | null;
  readonly reason_class: string | null;
  readonly recommended_health_state: "blocked" | "cooling_off" | null;
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

export function getScheduleIneligibilityReason(policy: RefreshPolicy | null): string | null {
  return automaticIneligibilityReason(policy);
}

export interface ScheduleApi {
  readonly active_run_id: string | null;
  readonly automation_mode: RunAutomationMode;
  readonly automation_summary: string;
  readonly browser_surface_lease_id?: string;
  readonly browser_surface_profile_key?: string;
  readonly browser_surface_status?: BrowserSurfaceProjection["browser_surface_status"];
  readonly browser_surface_wait_reason?: BrowserSurfaceProjection["browser_surface_wait_reason"];
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly created_at: string;
  readonly effective_mode: "automatic" | "manual" | "paused";
  readonly enabled: boolean;
  readonly human_attention_needed: boolean;
  /**
   * Reason the persisted schedule is not eligible for automatic background
   * refresh under the connector's *current* manifest policy. Computed from
   * `recommended_policy` via the same gate the scheduler uses to skip stale
   * unsafe rows. `null` means the persisted `enabled` flag is the authority:
   * if `enabled=true` the schedule actually runs; if `enabled=false` it is
   * paused as operator intent. Set when `enabled=true` but the manifest has
   * since changed to `manual` / `paused` / `background_safe: false` — the row
   * persists as operator intent, but the runtime will not start automatic runs
   * for it. Resuming is rejected with this same reason.
   */
  readonly ineligibility_reason: string | null;
  readonly interval_seconds: number;
  readonly jitter_seconds: number;
  readonly last_error_code: string | null;
  readonly last_finished_at: string | null;
  readonly last_started_at: string | null;
  readonly last_successful_at: string | null;
  readonly minimum_interval_warning: string | null;
  readonly next_due_at: string | null;
  readonly notification_posture: "action_required" | "informational" | "none";
  readonly object: "schedule";
  readonly pending_run_id?: string;
  readonly recommended_policy: RefreshPolicy | null;
  readonly scheduler_backoff: SchedulerBackoffApi | null;
  readonly trigger_kind: "scheduled";
  readonly updated_at: string;
}

export interface ActiveRun {
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly run_id: string;
  readonly started_at: string;
  readonly trace_id: string;
}

export interface RunNowOptions {
  connectorInstanceId?: string;
  manifest?: ConnectorManifest;
  ownerToken?: string;
  priorityClass?: "owner_interactive" | "scheduled_refresh";
  rsUrl?: string;
  runId?: string;
  scenarioId?: string;
  traceContext?: SpineTraceContext;
  triggerKind?: Extract<RunTriggerKind, "manual" | "webhook">;
}

export interface ConnectorInstanceOptions {
  connectorInstanceId?: string;
}

export interface RunNowResult {
  readonly automation_mode?: RunAutomationMode;
  readonly automation_summary?: string;
  readonly browser_surface?: BrowserSurfaceProjection;
  readonly run_id: string;
  readonly status?: "started" | BrowserSurfaceProjection["browser_surface_status"];
  readonly trace_id: string;
  readonly trigger_kind?: RunTriggerKind;
}

function runAutomationMetadata(
  policy: RefreshPolicy | null,
  triggerKind: Extract<RunTriggerKind, "manual" | "webhook">
): Pick<RunNowResult, "automation_mode" | "automation_summary" | "trigger_kind"> {
  const projection = projectRunAutomationPolicy({
    triggerKind,
    refreshPolicy: policy,
  });
  return {
    automation_mode: projection.automation_mode,
    automation_summary: automationModeCopy(projection.automation_mode),
    trigger_kind: projection.trigger_kind,
  };
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

export interface BrowserSurfaceRunProjection extends BrowserSurfaceProjection {
  readonly connector_id: string;
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

type RunConnectorFn = typeof runConnector;

/**
 * Hooks the controller calls to manage the per-run streaming-target
 * registration nonce that bridges Mode A (in-process runtime). The
 * controller mints a random nonce at spawn, hands it to the registry to
 * be hash-stored, threads the raw value to the connector child via env,
 * and clears it when the run ends. Decoupled from the registry's
 * concrete shape so this module does not import the registry directly.
 */
export interface RunTargetNonceHooks {
  clearNonce(args: { runId: string }): void;
  registerNonce(args: { runId: string; nonce: string }): void;
}

export interface ControllerOptions {
  asPublicUrl?: string;
  browserSurfaceAllocator?: BrowserSurfaceAllocator;
  browserSurfaceLeaseManager?: BrowserSurfaceLeaseManager;
  browserSurfaceLeaseStore?: BrowserSurfaceLeaseStore;
  /**
   * Optional preflight readiness probe. Production wiring installs a default
   * HTTP-based probe once the lease manager and allocator both report a
   * surface is "leased + ready", but BEFORE the connector child is spawned.
   * Failure terminates the run with `surface_failed` and a typed probe code
   * in the spine timeline, so a single failed live run yields enough evidence
   * to fix the surface before re-asking the owner for an OTP. When unset or
   * set to `null`, the gate is disabled.
   */
  browserSurfaceReadinessProbe?: BrowserSurfaceReadinessProbe | null;
  browserSurfaceReadinessTimeoutMs?: number;
  connectorPathResolver?: ConnectorPathResolver;
  logger?: ControllerLogger;
  ownerClientId?: string;
  ownerSubjectId?: string;
  rsUrl?: string;
  runConnectorImpl?: RunConnectorFn;
  runtime?: unknown;
  /**
   * Mutable runtime-context bag the surrounding server populates after
   * its listeners are bound. The controller reads `rsUrl` and the new
   * `referenceBaseUrl` lazily so it picks up the realized values once
   * the AS server has actually allocated its port.
   */
  runtimeContext?: { rsUrl?: string; referenceBaseUrl?: string };
  scheduler?: unknown;
  // Optional store override; defaults to the configured storage-backed singleton.
  // Tests use this to substitute fakes without touching module-scoped state.
  schedulerStore?: SchedulerStore;
  /**
   * Optional Mode-A streaming-target nonce hooks. When present, the
   * controller mints a per-run nonce at `runNow` time, registers its
   * hash with the registry, and threads the raw nonce to the connector
   * child via `PDPP_STREAMING_REGISTRATION_TOKEN`. When absent (older
   * deployments, tests that do not exercise streaming), Mode-A
   * registration is a no-op and Mode-B continues to work via its own
   * device-exporter authority. See:
   *   reference-implementation/server/streaming/run-target-registry.js
   */
  streamingTargetNonceHooks?: RunTargetNonceHooks;
}

export interface Controller {
  cancelBrowserSurfaceRun(runId: string): Promise<BrowserSurfaceProjection | null>;
  cleanupIdleBrowserSurfaces(): Promise<BrowserSurfaceProjection[]>;
  clearNeedsHuman(connectorId: string, options?: ConnectorInstanceOptions): void;
  deleteSchedule(connectorId: string, options?: ConnectorInstanceOptions): Promise<boolean>;
  /**
   * Graceful-shutdown drain: await all in-flight `runConnector` promises,
   * bounded by `timeoutMs`. Returns a summary of which runs finished
   * cleanly vs. which timed out.
   *
   * Intended caller: the parent process's SIGTERM handler in
   * `server/index.js`. Ensures connector children have time to release
   * their Chromium contexts (Layer A `shutdown-hook.ts` in
   * `polyfill-connectors/src`) before the parent exits and closes their
   * stdio pipes. See the layered SLVP design:
   *   - Layer A (subprocess SIGTERM hook): awaits release on signal.
   *   - Layer B (this method): controller waits for children before exit.
   *   - Layer C (`profile-lock.ts`): startup cleanup of any residue from
   *     paths A/B couldn't intercept (SIGKILL, OOM, power loss).
   */
  drainActiveRuns(timeoutMs: number): Promise<DrainSummary>;
  expireBrowserSurfaceWaits(): Promise<BrowserSurfaceProjection[]>;
  getActiveRun(connectorId: string, options?: ConnectorInstanceOptions): ActiveRun | null;
  getPendingInteraction(runId: string): PendingInteractionProjection | null;
  getSchedule(connectorId: string, options?: ConnectorInstanceOptions): Promise<ScheduleApi | null>;
  isNeedsHuman(connectorId: string, options?: ConnectorInstanceOptions): boolean;
  issueRuntimeOwnerToken(): Promise<string>;
  listBrowserSurfaceRunProjections(): BrowserSurfaceRunProjection[];
  listSchedules(): Promise<ScheduleApi[]>;
  markNeedsHuman(connectorId: string, options?: ConnectorInstanceOptions): void;
  promoteBrowserSurfaceLeasesAfterBoot(): Promise<void>;
  reconcileBrowserSurfaceLeasesAfterBoot(): Promise<void>;
  respondToInteraction(runId: string, input?: RunInteractionResponseInput): RunInteractionAck;
  runNow(connectorId: string, options?: RunNowOptions): Promise<RunNowResult>;
  setScheduleEnabled(
    connectorId: string,
    enabled: boolean,
    options?: ConnectorInstanceOptions
  ): Promise<ScheduleApi | null>;
  upsertSchedule(
    connectorId: string,
    input: ConnectorSchedulePatch,
    options?: ConnectorInstanceOptions
  ): Promise<ScheduleUpsertResult>;
}

export interface DrainSummary {
  readonly drained: number;
  /** Wall-clock milliseconds spent in drainActiveRuns. */
  readonly elapsedMs: number;
  readonly timedOut: number;
}

interface RuntimeInteraction {
  readonly kind: string;
  /** Human-readable description of the interaction; surfaced in ntfy push body. */
  readonly message?: string;
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
// In-flight connector-run Promises, keyed by run_id. Settled (success or
// failure) when the connector child process has exited and the controller's
// per-run cleanup (`activeRuns.delete`, spine emit, etc.) has finished.
//
// Populated alongside `activeRuns.set` and cleared in the same `finally`
// chain. Used exclusively by `drainActiveRuns` (graceful-shutdown path)
// to await in-flight cleanup before the parent process exits. See
// docs/run-reconciliation-design-brief.md for the broader controller-
// shutdown discipline this complements.
const activeRunPromises = new Map<string, Promise<unknown>>();
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

function buildRunSource(connectorId: string): { kind: "connector"; id: string } {
  return { kind: "connector", id: connectorId };
}

function runtimeKey(connectorId: string, connectorInstanceId?: string | null): string {
  return connectorInstanceId || connectorId;
}

/**
 * Graceful-shutdown drain primitive — exported for direct unit testing.
 *
 * Await every Promise in `pending` (snapshotted at call time) until either
 * (a) all settle, or (b) `timeoutMs` elapses. After the deadline, returns
 * counts based on which keys remain in the *live* map — promises that
 * settled during the race were removed by their own `finally` chains.
 *
 * The Promise.race is bounded; the timeout's setTimeout is `.unref()`'d
 * so the test runner doesn't keep the event loop alive after the test
 * finishes (a hard-to-spot test hang otherwise).
 *
 * See `Controller.drainActiveRuns` and
 * docs/run-reconciliation-design-brief.md for the layered SLVP design.
 */
export async function drainPromisesWithDeadline(
  pending: Map<string, Promise<unknown>>,
  timeoutMs: number
): Promise<DrainSummary> {
  const startMs = Date.now();
  const snapshot = Array.from(pending.values());
  if (snapshot.length === 0) {
    return { drained: 0, timedOut: 0, elapsedMs: 0 };
  }
  let timeoutHandle: NodeJS.Timeout | null = null;
  const deadline = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
    if (timeoutHandle.unref) {
      timeoutHandle.unref();
    }
  });
  const allSettled = Promise.allSettled(snapshot).then(() => "settled" as const);
  const outcome = await Promise.race([allSettled, deadline]);
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }
  const elapsedMs = Date.now() - startMs;
  if (outcome === "settled") {
    return { drained: snapshot.length, timedOut: 0, elapsedMs };
  }
  const stillPending = pending.size;
  return {
    drained: snapshot.length - stillPending,
    timedOut: stillPending,
    elapsedMs,
  };
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

function addConnectorLookupKey(keys: string[], key: unknown): void {
  if (typeof key !== "string") {
    return;
  }
  const trimmed = key.trim();
  if (trimmed && !keys.includes(trimmed)) {
    keys.push(trimmed);
  }
}

function connectorLookupKeys(connectorId: string, manifest?: ConnectorManifest | null): string[] {
  const keys: string[] = [];
  addConnectorLookupKey(keys, connectorId);
  addConnectorLookupKey(keys, canonicalConnectorKey(connectorId));
  if (manifest && typeof manifest === "object") {
    addConnectorLookupKey(keys, (manifest as { connector_id?: unknown }).connector_id);
    addConnectorLookupKey(keys, (manifest as { manifest_uri?: unknown }).manifest_uri);
    addConnectorLookupKey(keys, canonicalConnectorKeyFromManifest(manifest));
  }
  return keys;
}

function setManifestLookupAliases<T>(
  entries: Map<string, T>,
  connectorId: string,
  manifest: ConnectorManifest,
  value: T
): void {
  for (const key of connectorLookupKeys(connectorId, manifest)) {
    entries.set(key, value);
  }
}

function getFirstByConnectorLookupKey<T>(entries: ReadonlyMap<string, T>, keys: readonly string[]): T | null {
  for (const key of keys) {
    const value = entries.get(key);
    if (value !== undefined) {
      return value;
    }
  }
  return null;
}

/**
 * Read the operator-facing display name from a connector manifest, if
 * present. Falls back to the manifest's `name` field, then to null. The
 * caller is responsible for substituting `connector_id` when this returns
 * null.
 */
function readManifestDisplayName(manifest: ConnectorManifest | null | undefined): string | null {
  if (!manifest || typeof manifest !== "object") {
    return null;
  }
  const display = (manifest as { display_name?: unknown }).display_name;
  if (typeof display === "string" && display.trim()) {
    return display.trim();
  }
  const name = (manifest as { name?: unknown }).name;
  if (typeof name === "string" && name.trim()) {
    return name.trim();
  }
  return null;
}

function readManifestRefreshPolicy(manifest: ConnectorManifest | null | undefined): RefreshPolicy | null {
  if (!manifest || typeof manifest !== "object") {
    return null;
  }
  const capabilities = (manifest as { capabilities?: unknown }).capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return null;
  }
  const policy = (capabilities as { refresh_policy?: unknown }).refresh_policy;
  return policy && typeof policy === "object" && !Array.isArray(policy) ? (policy as RefreshPolicy) : null;
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
      if (!manifest || typeof manifest !== "object") {
        continue;
      }
      const connectorId = (manifest as { connector_id?: unknown } | null)?.connector_id;
      if (typeof connectorId !== "string" || !connectorId.trim()) {
        continue;
      }
      const fp = fingerprintManifest(manifest);
      if (fp) {
        setManifestLookupAliases(entries, connectorId.trim(), manifest, fp);
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
      if (!manifest || typeof manifest !== "object") {
        continue;
      }
      const connectorId = (manifest as { connector_id?: unknown } | null)?.connector_id;
      if (typeof connectorId !== "string" || !connectorId.trim()) {
        continue;
      }
      const trimmedId = connectorId.trim();
      setManifestLookupAliases(paths, trimmedId, manifest, connectorPath);
      const fp = fingerprintManifest(manifest);
      if (fp) {
        setManifestLookupAliases(fingerprints, trimmedId, manifest, fp);
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
  const lookupKeys = connectorLookupKeys(connectorId, manifest ?? null);
  const polyfillPath = getFirstByConnectorLookupKey(polyfillPaths, lookupKeys);
  const referenceFingerprint = getFirstByConnectorLookupKey(referenceFingerprints, lookupKeys);
  const polyfillFingerprint = getFirstByConnectorLookupKey(polyfillFingerprints, lookupKeys);
  const hasReferenceFixture = referenceFingerprint !== null;

  const activeFingerprint = fingerprintManifest(manifest ?? null);
  if (activeFingerprint) {
    if (polyfillPath && fingerprintsEqual(activeFingerprint, polyfillFingerprint)) {
      return polyfillPath;
    }
    if (hasReferenceFixture && fingerprintsEqual(activeFingerprint, referenceFingerprint)) {
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

/**
 * Per-connector projection of the durable scheduler history + last-run-time
 * tables. Built once per `listSchedules()` (or `getSchedule()`) call by
 * `loadScheduleHistoryIndex` and threaded into `getRuntimeProjection` so a
 * persisted schedule whose in-memory active-run row has already cleared
 * still surfaces honest last-run facts to the dashboard and `scheduler-
 * doctor`. The index is purely additive: when the controller knows the
 * connector is currently running, the in-memory active-run row still wins.
 */
interface ScheduleHistoryFacts {
  /** Latest durable last-run timestamp, from history or `scheduler_last_run_times`. */
  readonly lastRunTimeMs: number | null;
  /** Error/skip code for the most recent terminal row, when that row was not successful. */
  readonly latestErrorCode: string | null;
  readonly latestFinishedAt: string | null;
  /** Most recent run that actually started (status in {succeeded, failed}). */
  readonly latestStartedAt: string | null;
  readonly latestStatus: "failed" | "skipped" | "succeeded" | null;
  /** Most recent `succeeded` record's `completedAt`. */
  readonly latestSuccessfulAt: string | null;
  /** Recent durable scheduler history for this connector instance, oldest to newest. */
  readonly recentRuns: readonly SchedulerRunHistoryRecord[];
}

type ScheduleHistoryIndex = ReadonlyMap<string, ScheduleHistoryFacts>;

interface MutableScheduleHistoryFacts {
  lastRunTimeMs: number | null;
  latestErrorCode: string | null;
  latestFinishedAt: string | null;
  latestStartedAt: string | null;
  latestStatus: "failed" | "skipped" | "succeeded" | null;
  latestSuccessfulAt: string | null;
  recentRuns: SchedulerRunHistoryRecord[];
}

const EMPTY_SCHEDULE_HISTORY_FACTS: ScheduleHistoryFacts = {
  latestStartedAt: null,
  latestFinishedAt: null,
  latestStatus: null,
  latestSuccessfulAt: null,
  latestErrorCode: null,
  lastRunTimeMs: null,
  recentRuns: [],
};

const SAFE_SCHEDULER_ERROR_PREFIXES = new Set([
  "automation_policy_blocked",
  "not_ready",
  "schedule.back_off.cleared",
  "schedule.back_off.started",
  "schedule.gave_up",
  "scheduler_backoff_applied",
]);

function schedulerErrorCodeFromRecord(row: SchedulerRunHistoryRecord): string | null {
  if (row.terminalReason) {
    return row.terminalReason;
  }
  if (row.failureReason) {
    return row.failureReason;
  }
  if (!row.error) {
    return null;
  }
  const prefix = row.error.includes(":") ? row.error.slice(0, row.error.indexOf(":")) : row.error;
  if (SAFE_SCHEDULER_ERROR_PREFIXES.has(prefix)) {
    return prefix;
  }
  return "scheduler_error";
}

type EnsureScheduleFacts = (connectorKey: string) => MutableScheduleHistoryFacts;

function ensureScheduleHistoryFacts(
  facts: Map<string, MutableScheduleHistoryFacts>,
  connectorKey: string
): MutableScheduleHistoryFacts {
  let entry = facts.get(connectorKey);
  if (!entry) {
    entry = {
      latestStartedAt: null,
      latestFinishedAt: null,
      latestStatus: null,
      latestSuccessfulAt: null,
      latestErrorCode: null,
      lastRunTimeMs: null,
      recentRuns: [],
    };
    facts.set(connectorKey, entry);
  }
  return entry;
}

// Hydrate `latestFinishedAt` from the `scheduler_last_run_times` table first
// so a connector that has rolled out of the bounded history window still has
// a non-null `last_finished_at`. History rows will overwrite with a more
// precise per-status anchor when they exist.
function hydrateScheduleHistoryFromLastRunTimes(
  lastRunTimes: readonly SchedulerLastRunTimeRecord[],
  ensure: EnsureScheduleFacts
): void {
  for (const row of lastRunTimes) {
    if (!Number.isFinite(row.last_run_time_ms)) {
      continue;
    }
    const entry = ensure(row.connector_instance_id || row.connector_id);
    if (!entry.latestFinishedAt) {
      entry.latestFinishedAt = new Date(row.last_run_time_ms).toISOString();
    }
    entry.lastRunTimeMs =
      entry.lastRunTimeMs === null ? row.last_run_time_ms : Math.max(entry.lastRunTimeMs, row.last_run_time_ms);
  }
}

function bucketRecentRunsByConnector(history: readonly SchedulerRunHistoryRecord[], ensure: EnsureScheduleFacts): void {
  for (const row of history) {
    if (!row || typeof row.connectorId !== "string") {
      continue;
    }
    ensure(row.connectorInstanceId || row.connectorId).recentRuns.push(row);
  }
}

// Walk newest to oldest. The store's chronological order means the last
// array element is the newest record overall; iterating in reverse keeps
// "first sighting wins" semantics for both `latest{Started,Successful}At`
// so we never overwrite a newer fact with an older one.
function deriveLatestScheduleFacts(history: readonly SchedulerRunHistoryRecord[], ensure: EnsureScheduleFacts): void {
  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i];
    if (!row || typeof row.connectorId !== "string") {
      continue;
    }
    applyHistoryRowToScheduleFacts(ensure(row.connectorInstanceId || row.connectorId), row);
  }
}

function applyHistoryRowToScheduleFacts(entry: MutableScheduleHistoryFacts, row: SchedulerRunHistoryRecord): void {
  if (entry.latestStatus === null) {
    entry.latestStatus = row.status;
    if (row.status === "failed" || row.status === "skipped") {
      entry.latestErrorCode = schedulerErrorCodeFromRecord(row);
    }
  }
  if (!entry.latestFinishedAt || row.completedAt > entry.latestFinishedAt) {
    entry.latestFinishedAt = row.completedAt;
  }
  // Only `succeeded`/`failed` records correspond to a run that actually
  // started. `skipped` records carry a `startedAt` for bookkeeping but the
  // connector child never spawned, so we hold `last_started_at` back. This
  // is what lets the dashboard and the doctor probe distinguish "ran but is
  // currently idle" from "currently being skipped (not_ready / needs_human /
  // disabled grant)".
  if (
    entry.latestStartedAt === null &&
    (row.status === "succeeded" || row.status === "failed") &&
    typeof row.startedAt === "string"
  ) {
    entry.latestStartedAt = row.startedAt;
  }
  if (entry.latestSuccessfulAt === null && row.status === "succeeded") {
    entry.latestSuccessfulAt = row.completedAt;
  }
}

function getRuntimeProjection(
  connectorId: string,
  connectorInstanceId: string,
  browserSurfaceLeaseManager?: BrowserSurfaceLeaseManager,
  historyIndex?: ScheduleHistoryIndex
): RuntimeProjection {
  const key = runtimeKey(connectorId, connectorInstanceId);
  const active = activeRuns.get(key) || null;
  const pendingBrowserSurfaceLease = browserSurfaceLeaseManager
    ?.listLeases()
    .find(
      (lease) =>
        lease.connector_id === connectorId &&
        (lease.surface_subject_id === connectorInstanceId ||
          (!lease.surface_subject_id && connectorInstanceId === connectorId)) &&
        (lease.status === "waiting_for_browser_surface" || lease.status === "deferred")
    );
  const browserSurfaceProjection = pendingBrowserSurfaceLease
    ? projectBrowserSurfaceLease(pendingBrowserSurfaceLease)
    : null;
  const historyFacts = historyIndex?.get(key) ?? EMPTY_SCHEDULE_HISTORY_FACTS;
  if (!active) {
    return {
      active_run_id: null,
      ...(browserSurfaceProjection ?? {}),
      // No active run: durable scheduler history is the source of truth
      // for whether this connector has *ever* run. When history is empty,
      // every field stays null, preserving the "never_ran" classification
      // for genuinely never-fired schedules.
      last_started_at: historyFacts.latestStartedAt,
      last_finished_at: historyFacts.latestFinishedAt,
      last_error_code: historyFacts.latestErrorCode,
      last_successful_at: historyFacts.latestSuccessfulAt,
      human_attention_needed: needsHumanAttention.has(key),
    };
  }
  return {
    active_run_id: active.run_id,
    ...(browserSurfaceProjection ?? {}),
    // In-memory active-run row wins for `last_started_at` (so a freshly
    // dispatched run shows immediately, before history is appended), but
    // we still surface the most recent succeeded/finished facts from
    // durable history so a restart mid-run doesn't lose context.
    last_started_at: active.started_at,
    last_finished_at: historyFacts.latestFinishedAt,
    last_error_code: historyFacts.latestErrorCode,
    last_successful_at: historyFacts.latestSuccessfulAt,
    human_attention_needed: needsHumanAttention.has(key),
  };
}

/**
 * Resolve the operator-facing web base URL the click action of a ntfy
 * push should land on. Mirrors `interaction-handler.ts:resolveWebBaseUrl`
 * exactly: prefer `PDPP_WEB_BASE_URL` (operator's explicit override),
 * fall back to `PDPP_REFERENCE_ORIGIN` (the reference's own composed
 * origin), finally `http://localhost:3000` (dev default — same as the
 * polyfill connectors use). The brief explicitly accepted a small
 * duplication here over a workspace dependency.
 */
function resolveWebBaseUrl(): string {
  const explicit = process.env.PDPP_WEB_BASE_URL?.trim();
  if (explicit) {
    return explicit;
  }
  const referenceOrigin = process.env.PDPP_REFERENCE_ORIGIN?.trim();
  if (referenceOrigin) {
    return referenceOrigin;
  }
  return "http://localhost:3000";
}

/**
 * Lazy import of the ntfy adapter. Two reasons it's lazy:
 *   1. The polyfill-connectors package is loaded by the reference server
 *      at import time anyway, but doing the import here means tests that
 *      don't reach an interaction never pay the cost.
 *   2. If notify() ever throws synchronously (e.g. malformed env), the
 *      lazy boundary keeps that out of the controller's hot path.
 */
async function fireNtfy(args: {
  interaction: RuntimeInteraction;
  connectorDisplayName: string;
  runId: string;
  log: ControllerLogger;
}): Promise<void> {
  try {
    const { notify } = await import("../../packages/polyfill-connectors/src/ntfy.ts");
    const { interaction, connectorDisplayName, runId } = args;
    const message = typeof interaction.message === "string" ? interaction.message : "";
    const webBaseUrl = resolveWebBaseUrl();
    const encodedRunId = encodeURIComponent(runId);
    const encodedInteractionId = encodeURIComponent(interaction.request_id || "");
    const clickUrl =
      interaction.kind === "manual_action"
        ? `${webBaseUrl}/dashboard/runs/${encodedRunId}/stream?interaction_id=${encodedInteractionId}`
        : `${webBaseUrl}/dashboard/runs/${encodedRunId}`;
    const tags = interaction.kind === "credentials" || interaction.kind === "otp" ? ["key"] : ["construction"];
    await notify({
      title: `PDPP ${connectorDisplayName}: ${interaction.kind} needed`,
      message,
      priority: "high",
      tags,
      clickUrl,
    });
  } catch (err) {
    // ntfy is best-effort. A failure here MUST NOT block or fail the
    // interaction handling — log and continue.
    const message = err instanceof Error ? err.message : String(err);
    args.log.warn?.(`[controller] ntfy fire for run ${args.runId} failed: ${message}`);
  }
}

async function buildAttentionOutcomeRecorder(args: { runId: string; requestId: string | null }) {
  const requestId = args.requestId;
  if (!requestId) {
    return null;
  }
  const runId = args.runId;
  // Lazy import keeps the runtime startup graph small; this module is only
  // loaded when an interaction actually fires push delivery.
  const { getDefaultConnectorAttentionStore } = await import("../server/stores/connector-attention-store.js");
  const store = getDefaultConnectorAttentionStore() as {
    recordNotificationOutcomeById?: (input: {
      attentionId: string;
      outcome: string;
      reason: string | null;
      now: string;
    }) => Promise<unknown>;
  };
  if (typeof store.recordNotificationOutcomeById !== "function") {
    return null;
  }
  const recordNotificationOutcomeById = store.recordNotificationOutcomeById;
  return async ({ state, reason }: { state: string; reason: string | null }) => {
    await recordNotificationOutcomeById({
      attentionId: `att_${runId}_${requestId}`,
      outcome: state,
      reason: reason || null,
      now: new Date().toISOString(),
    });
  };
}

async function fireWebPush(args: {
  interaction: RuntimeInteraction;
  connectorDisplayName: string;
  ownerSubjectId: string;
  runId: string;
  log: ControllerLogger;
}): Promise<void> {
  try {
    const { fanoutPendingInteractionWebPush } = await import("../server/web-push-notifications.js");
    const requestId =
      typeof (args.interaction as { request_id?: unknown }).request_id === "string"
        ? (args.interaction as { request_id: string }).request_id
        : null;
    const recordOutcome = await buildAttentionOutcomeRecorder({ runId: args.runId, requestId });
    await fanoutPendingInteractionWebPush({
      interaction: args.interaction,
      connectorDisplayName: args.connectorDisplayName,
      ownerSubjectId: args.ownerSubjectId,
      runId: args.runId,
      log: args.log as Console,
      ...(recordOutcome ? { recordOutcome } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    args.log.warn?.(`[controller] web push fire for run ${args.runId} failed: ${message}`);
  }
}

async function fireAssistanceWebPush(args: {
  assistance: Record<string, unknown>;
  connectorDisplayName: string;
  ownerSubjectId: string;
  runId: string;
  log: ControllerLogger;
}): Promise<void> {
  try {
    const { fanoutAssistanceWebPush } = await import("../server/web-push-notifications.js");
    const requestId =
      typeof args.assistance.assistance_request_id === "string"
        ? (args.assistance.assistance_request_id as string)
        : null;
    const recordOutcome = await buildAttentionOutcomeRecorder({ runId: args.runId, requestId });
    await fanoutAssistanceWebPush({
      assistance: args.assistance,
      connectorDisplayName: args.connectorDisplayName,
      ownerSubjectId: args.ownerSubjectId,
      runId: args.runId,
      log: args.log as Console,
      ...(recordOutcome ? { recordOutcome } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    args.log.warn?.(`[controller] web push assistance fire for run ${args.runId} failed: ${message}`);
  }
}

function detachControllerTask(task: Promise<unknown>): void {
  task.catch(() => {
    // Best-effort controller fanout tasks log internally before settling.
  });
}

// Decide whether a manual-run progress message should fan out a nonblocking
// owner-assistance Web Push. Mirrors `shouldFanoutAssistanceProgress` in the
// server module so we can filter without paying the dynamic-import cost on
// every progress tick.
export function shouldFanoutAssistanceProgressMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const m = message as Record<string, unknown>;
  if (m.type !== "ASSISTANCE") {
    return false;
  }
  if (m.response_contract !== "none") {
    return false;
  }
  if (typeof m.owner_action !== "string" || m.owner_action === "none") {
    return false;
  }
  return m.progress_posture === "running" || m.progress_posture === "blocked";
}

function brokerInteraction(
  runId: string,
  connectorId: string,
  interaction: RuntimeInteraction,
  notifyArgs?: { connectorDisplayName: string; log: ControllerLogger; ownerSubjectId: string }
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

    // Fire-and-forget ntfy push. Keyed off NEW pending interactions only —
    // the early-return above handles the "already pending" case before this
    // line runs. Failure of `fireNtfy` is internally swallowed to keep
    // interaction handling unaffected; we discard the promise on purpose.
    if (notifyArgs) {
      detachControllerTask(
        fireNtfy({
          interaction,
          connectorDisplayName: notifyArgs.connectorDisplayName,
          runId,
          log: notifyArgs.log,
        })
      );
      detachControllerTask(
        fireWebPush({
          interaction,
          connectorDisplayName: notifyArgs.connectorDisplayName,
          ownerSubjectId: notifyArgs.ownerSubjectId,
          runId,
          log: notifyArgs.log,
        })
      );
    }
  });
}

export function __resetControllerInteractionStateForTests(): void {
  activeRunInteractions.clear();
  activeRuns.clear();
  activeRunPromises.clear();
  needsHumanAttention.clear();
}

export function isNeedsHumanAttention(connectorId: string, options: ConnectorInstanceOptions = {}): boolean {
  return needsHumanAttention.has(runtimeKey(connectorId, options.connectorInstanceId));
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

function computeNextDueAt(schedule: Schedule, lastFinishedAt: string | null): string | null {
  if (!lastFinishedAt) {
    return null;
  }
  const lastMs = Date.parse(lastFinishedAt);
  if (!Number.isFinite(lastMs)) {
    return null;
  }
  const intervalMs = Math.max(1, schedule.interval_seconds) * 1000;
  return new Date(lastMs + intervalMs).toISOString();
}

function toBackoffRunRecord(record: SchedulerRunHistoryRecord): RunRecord {
  const runRecord = {
    attempt: record.attempt,
    checkpointSummary: record.checkpointSummary,
    completedAt: record.completedAt,
    connectorError: record.connectorError ?? null,
    connectorId: record.connectorId,
    connectorInstanceId: record.connectorInstanceId ?? null,
    failureReason: record.failureReason ?? null,
    knownGaps: record.knownGaps,
    recordsEmitted: record.recordsEmitted,
    reportedRecordsEmitted: record.reportedRecordsEmitted ?? null,
    runId: record.runId ?? null,
    source: {
      id: typeof record.source.id === "string" ? record.source.id : record.connectorId,
      kind: "connector" as const,
    },
    startedAt: record.startedAt,
    status: record.status,
    terminalReason: (record.terminalReason ?? null) as Exclude<RunRecord["terminalReason"], undefined>,
    traceId: record.traceId ?? null,
  };
  return record.error === undefined ? runRecord : { ...runRecord, error: record.error };
}

function buildSchedulerBackoffApi(
  schedule: Schedule,
  facts: ScheduleHistoryFacts,
  ineligibilityReason: string | null
): SchedulerBackoffApi | null {
  if (!schedule.enabled || ineligibilityReason) {
    return null;
  }
  const lastRunTimeMs =
    facts.lastRunTimeMs ??
    (facts.latestFinishedAt && Number.isFinite(Date.parse(facts.latestFinishedAt))
      ? Date.parse(facts.latestFinishedAt)
      : null);
  if (lastRunTimeMs === null) {
    return null;
  }
  const decision: BackoffDecision = computeNextRunWithBackoff(
    facts.recentRuns.map(toBackoffRunRecord),
    Math.max(1, schedule.interval_seconds) * 1000,
    lastRunTimeMs
  );
  return {
    backoff_applied: decision.backoffApplied,
    consecutive_failures: decision.consecutiveFailures,
    next_run_at: decision.nextRunAt,
    reason_class: decision.reasonClass,
    recommended_health_state: decision.recommendedHealthState,
  };
}

function scheduleToApi(
  schedule: Schedule | null,
  runtimeProjection: RuntimeProjection | null = null,
  policy: RefreshPolicy | null = null,
  historyFacts: ScheduleHistoryFacts = EMPTY_SCHEDULE_HISTORY_FACTS
): ScheduleApi | null {
  if (!schedule) {
    return null;
  }
  const effectiveMode = computeEffectiveMode(schedule, runtimeProjection);
  const humanAttentionNeeded = runtimeProjection?.human_attention_needed ?? false;
  const automationPolicy = projectRunAutomationPolicy({
    triggerKind: "scheduled",
    refreshPolicy: policy,
    humanAttentionNeeded,
  });
  const minimumIntervalWarning = buildMinimumIntervalWarning(schedule.interval_seconds, policy);
  // If the row is enabled but the connector's current manifest policy makes
  // automatic runs ineligible, surface the same reason the controller uses
  // when rejecting create/resume and the scheduler uses when skipping. This
  // keeps persisted operator intent visible while making it explicit that
  // the row will not actually run under the current policy.
  const ineligibilityReason = schedule.enabled ? getScheduleIneligibilityReason(policy) : null;
  // Projected next-due timestamp: `last_finished_at + interval_seconds`.
  // The runtime scheduler computes the real dispatch instant from its own
  // back-off state machine, which can push next-due further out under a
  // failing streak; this projection is the floor under those decisions and
  // is honest about "we ran X seconds ago, the row is not yet due to fire
  // again". `null` only when there is no persisted last-run anchor at all,
  // which the doctor / dashboard read as "never_ran".
  //
  // When `ineligibilityReason` is set, the scheduler manager filters this
  // connector out of the runnable set: no automatic run will fire under
  // the current manifest policy. Suppressing `next_due_at` here keeps the
  // schedule envelope honest (operators are not told a row will fire at
  // some future timestamp that the runtime has no intention of honoring),
  // and pairs with `last_error_code` suppression below: the gate is the
  // current authoritative status, not whatever historical failure code
  // happens to sit at the top of the persisted history.
  const lastFinishedAt = runtimeProjection?.last_finished_at || null;
  const nextDueAt = schedule.enabled && !ineligibilityReason ? computeNextDueAt(schedule, lastFinishedAt) : null;
  const schedulerBackoff = buildSchedulerBackoffApi(schedule, historyFacts, ineligibilityReason);
  // Historical run timestamps (`last_started_at`, `last_finished_at`,
  // `last_successful_at`) remain truthful audit anchors and stay surfaced
  // even for a gated row -- they describe what already happened, not
  // what is about to happen. `last_error_code`, however, advertises a
  // *current* failure mode to the dashboard amber chip and the doctor
  // JSON. Once a manifest gate has taken over as the active reason the
  // row will not run, the prior `schedule.gave_up` / `not_ready` /
  // backoff code is stale operator-misleading state: it implies the
  // scheduler is still actively failing this connector when in fact it
  // has been administratively benched. Suppress it for ineligible rows.
  const lastErrorCode = ineligibilityReason ? null : runtimeProjection?.last_error_code || null;
  return {
    object: "schedule",
    connector_id: schedule.connector_id,
    connector_instance_id: schedule.connector_instance_id,
    automation_mode: automationPolicy.automation_mode,
    automation_summary: automationModeCopy(automationPolicy.automation_mode),
    interval_seconds: schedule.interval_seconds,
    jitter_seconds: schedule.jitter_seconds,
    enabled: schedule.enabled,
    created_at: schedule.created_at,
    updated_at: schedule.updated_at,
    next_due_at: nextDueAt,
    notification_posture: automationPolicy.notification_posture,
    active_run_id: runtimeProjection?.active_run_id || null,
    ...(runtimeProjection?.browser_surface_status
      ? {
          browser_surface_status: runtimeProjection.browser_surface_status,
          pending_run_id: runtimeProjection.pending_run_id,
          browser_surface_lease_id: runtimeProjection.browser_surface_lease_id,
          browser_surface_profile_key: runtimeProjection.browser_surface_profile_key,
          ...(runtimeProjection.browser_surface_wait_reason
            ? { browser_surface_wait_reason: runtimeProjection.browser_surface_wait_reason }
            : {}),
        }
      : {}),
    last_started_at: runtimeProjection?.last_started_at || null,
    last_finished_at: runtimeProjection?.last_finished_at || null,
    last_error_code: lastErrorCode,
    last_successful_at: runtimeProjection?.last_successful_at || null,
    effective_mode: effectiveMode,
    human_attention_needed: humanAttentionNeeded,
    ineligibility_reason: ineligibilityReason,
    recommended_policy: policy,
    scheduler_backoff: schedulerBackoff,
    minimum_interval_warning: minimumIntervalWarning,
    trigger_kind: "scheduled",
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
  const browserSurfaceAllocator = opts.browserSurfaceAllocator;
  const browserSurfaceLeaseManager = opts.browserSurfaceLeaseManager;
  const browserSurfaceReadinessTimeoutMs = opts.browserSurfaceReadinessTimeoutMs;
  const browserSurfaceLeaseStore = opts.browserSurfaceLeaseStore;
  // Default is `null` — disabled unless explicitly wired. The production
  // path (`resolveNekoBrowserSurfaceControllerOptions` in server/index.js)
  // installs the default HTTP probe; tests opt in only when they exercise
  // probe behavior. This keeps the readiness gate from running against
  // a fake n.eko url in every controller test.
  const browserSurfaceReadinessProbe: BrowserSurfaceReadinessProbe | null =
    opts.browserSurfaceReadinessProbe === undefined ? null : opts.browserSurfaceReadinessProbe;
  const runConnectorImpl = opts.runConnectorImpl || runConnector;
  const pendingBrowserSurfaceLaunches = new Map<string, RunNowOptions>();
  const activeRunTraceContexts = new Map<string, SpineTraceContext>();

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

  async function clearPersistedActiveRun(connectorInstanceId: string, runId: string): Promise<void> {
    await schedulerStore.deleteActiveRun(connectorInstanceId, runId);
  }

  async function runAlreadyTerminal(runId: string): Promise<boolean> {
    if (isPostgresStorageBackend()) {
      const { rows } = await postgresQuery(
        `
        SELECT 1 AS present
        FROM spine_events
        WHERE run_id = $1
          AND event_type IN ('run.completed', 'run.failed', 'run.cancelled', 'run.abandoned')
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
      await clearPersistedActiveRun(row.connector_instance_id ?? row.connector_id, row.run_id);
    }

    for (const row of rows) {
      log.warn?.(`[controller] reconciled abandoned controller-managed run ${row.run_id} for ${row.connector_id}`);
    }
  }

  const startupControllerRunReconciliation = reconcileAbandonedControllerRuns().catch((err) => {
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

  /**
   * Resolve the AS base URL the spawned connector child should PUT its
   * streaming-target registration to. Read lazily because the surrounding
   * server populates `runtimeContext.referenceBaseUrl` AFTER its listener
   * has actually allocated a port (the same pattern `runtimeContext.rsUrl`
   * uses).
   *
   * IMPORTANT: this URL is for SERVER-TO-SERVER traffic between the
   * connector child and the AS Fastify listener (both on the same host
   * in Mode A). It is NOT the browser-facing public URL. In composed
   * deployments the two differ — the public URL points at a Next.js
   * webapp that does not proxy
   * `/admin/runs/:runId/interactions/:interactionId/streaming-target`,
   * so passing the public URL here surfaces as a silent registration
   * 404 and `companion_start_failed` later. The server populates
   * `runtimeContext.referenceBaseUrl` with the AS loopback URL for
   * exactly this reason; we no longer fall back to `opts.asPublicUrl`
   * or `PDPP_REFERENCE_ORIGIN` (both are public/browser-facing URLs).
   *
   * Returns `null` when the context URL is not yet populated so
   * `runConnector` skips the env block entirely.
   */
  function currentReferenceBaseUrl(): string | null {
    const contextUrl = opts.runtimeContext?.referenceBaseUrl;
    if (typeof contextUrl === "string" && contextUrl) {
      return contextUrl;
    }
    return null;
  }

  async function issueRuntimeOwnerToken(): Promise<string> {
    const device = await initiateOwnerDeviceAuthorization(ownerClientId, {
      baseUrl: opts.asPublicUrl || process.env.AS_PUBLIC_URL || undefined,
    });
    const approved = await approveOwnerDeviceAuthorization(device.user_code, ownerSubjectId);
    return approved.access_token;
  }

  async function emitBrowserSurfaceLeaseEvent(
    eventType: string,
    connectorId: string,
    runId: string,
    traceContext: SpineTraceContext,
    lease: BrowserSurfaceLease
  ): Promise<void> {
    // Ordering-sensitive callers await this; emit failures remain warning-only.
    try {
      await emitSpineEvent({
        event_type: eventType,
        trace_id: traceContext.trace_id,
        scenario_id: traceContext.scenario_id,
        actor_type: "runtime",
        actor_id: connectorId,
        object_type: "run",
        object_id: runId,
        status: lease.status,
        run_id: runId,
        data: {
          source: buildRunSource(connectorId),
          browser_surface: projectBrowserSurfaceLease(lease),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] failed to emit ${eventType} for ${runId}: ${message}`);
    }
  }

  async function persistBrowserSurfaceLeaseMutation(
    lease: BrowserSurfaceLease,
    surface?: BrowserSurface
  ): Promise<void> {
    if (!browserSurfaceLeaseStore) {
      return;
    }
    await browserSurfaceLeaseStore.withLeaseTransaction(async (store) => {
      if (surface) {
        await store.upsertSurface(surface);
      }
      await store.upsertLease(lease);
    });
  }

  async function waitForStartingBrowserSurface(
    lease: BrowserSurfaceLease,
    connectorId: string,
    runId: string,
    traceContext: SpineTraceContext
  ): Promise<{ lease: BrowserSurfaceLease; surface?: BrowserSurface }> {
    await emitBrowserSurfaceLeaseEvent("run.browser_surface_starting", connectorId, runId, traceContext, lease);
    if (!browserSurfaceLeaseManager) {
      return { lease };
    }

    let current = lease;
    const allocator = browserSurfaceAllocator ?? UNCONFIGURED_BROWSER_SURFACE_ALLOCATOR;
    while (current.status === "starting_surface") {
      const readyResult = await browserSurfaceLeaseManager.ensureStartingSurfaceReady({
        leaseId: current.lease_id,
        allocator,
        ...(browserSurfaceReadinessTimeoutMs === undefined
          ? {}
          : { readinessTimeoutMs: browserSurfaceReadinessTimeoutMs }),
      });
      current = readyResult.lease;
      await persistBrowserSurfaceLeaseMutation(readyResult.lease, readyResult.surface);
      if (current.status !== "starting_surface") {
        return readyResult;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const surface = current.surface_id ? browserSurfaceLeaseManager.getSurface(current.surface_id) : undefined;
    return { lease: current, ...(surface ? { surface } : {}) };
  }

  async function reclaimCapacityAndPromoteLease(
    lease: BrowserSurfaceLease
  ): Promise<{ lease: BrowserSurfaceLease; surface?: BrowserSurface; reclaimed: boolean }> {
    if (!(browserSurfaceLeaseManager && browserSurfaceAllocator)) {
      return { lease, reclaimed: false };
    }
    const reclaimable = browserSurfaceLeaseManager.planCapacityPressureReclaim(lease.lease_id);
    if (!reclaimable) {
      return { lease, reclaimed: false };
    }
    try {
      await browserSurfaceAllocator.stopSurface({
        surfaceId: reclaimable.surface_id,
        reason: "capacity_pressure",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] browser-surface capacity reclaim for ${lease.run_id} failed: ${message}`);
      return { lease, reclaimed: false };
    }

    const reclaimed = browserSurfaceLeaseManager.completeCapacityPressureReclaim(reclaimable.surface_id);
    if (reclaimed.stopped) {
      await persistBrowserSurfaceLeaseMutation(lease, reclaimed.stopped);
    }
    if (!reclaimed.promoted) {
      return { lease, reclaimed: Boolean(reclaimed.stopped) };
    }
    await persistBrowserSurfaceLeaseMutation(
      reclaimed.promoted,
      reclaimed.promoted.surface_id ? browserSurfaceLeaseManager.getSurface(reclaimed.promoted.surface_id) : undefined
    );
    const surface = reclaimed.promoted.surface_id
      ? browserSurfaceLeaseManager.getSurface(reclaimed.promoted.surface_id)
      : undefined;
    return {
      lease: reclaimed.promoted,
      ...(surface ? { surface } : {}),
      reclaimed: true,
    };
  }

  function promoteBrowserSurfaceLease(lease: BrowserSurfaceLease, reason: string): void {
    const promotedOptions = pendingBrowserSurfaceLaunches.get(lease.run_id) ?? {};
    pendingBrowserSurfaceLaunches.delete(lease.run_id);
    detachControllerTask(
      runNow(lease.connector_id, {
        ...promotedOptions,
        runId: lease.run_id,
        priorityClass: lease.priority_class,
      }).catch(async (err) => {
        const deferredResult = browserSurfaceLeaseManager?.deferLeasedRun({
          leaseId: lease.lease_id,
          fencingToken: lease.fencing_token,
        });
        if (deferredResult?.lease) {
          try {
            await emitBrowserSurfaceLeaseEvent(
              "run.browser_surface_deferred",
              deferredResult.lease.connector_id,
              deferredResult.lease.run_id,
              createTraceContext(),
              deferredResult.lease
            );
            await persistBrowserSurfaceLeaseMutation(deferredResult.lease, deferredResult.surface);
          } catch {
            // Deferred-lease emit/persist is best-effort; the outer warn below
            // already captures the original promotion failure.
          }
        }
        if (deferredResult?.promoted) {
          await persistAndPromoteBrowserSurfaceLeases([deferredResult.promoted], `${reason} promotion failure`);
        }
        const message = err instanceof Error ? err.message : String(err);
        log.warn?.(`[controller] browser-surface lease ${lease.lease_id} promotion failed after ${reason}: ${message}`);
      })
    );
  }

  async function persistAndPromoteBrowserSurfaceLeases(leases: BrowserSurfaceLease[], reason: string): Promise<void> {
    if (!browserSurfaceLeaseManager) {
      return;
    }
    for (const lease of leases) {
      await persistBrowserSurfaceLeaseMutation(
        lease,
        lease.surface_id ? browserSurfaceLeaseManager.getSurface(lease.surface_id) : undefined
      );
      promoteBrowserSurfaceLease(lease, reason);
    }
  }

  async function releaseBrowserSurfaceLease(
    lease: BrowserSurfaceLease,
    connectorId: string,
    runId: string,
    traceContext: SpineTraceContext,
    reason: string
  ): Promise<void> {
    const releaseResult = browserSurfaceLeaseManager?.release({
      leaseId: lease.lease_id,
      fencingToken: lease.fencing_token,
    });
    if (releaseResult?.lease) {
      await emitBrowserSurfaceLeaseEvent(
        "run.browser_surface_released",
        connectorId,
        runId,
        traceContext,
        releaseResult.lease
      );
      await persistBrowserSurfaceLeaseMutation(releaseResult.lease, releaseResult.surface);
    }
    if (releaseResult?.promoted) {
      await persistAndPromoteBrowserSurfaceLeases([releaseResult.promoted], reason);
    }
  }

  /**
   * Run the preflight readiness probe against a leased surface. On success,
   * emits `run.browser_surface_ready` and returns. On failure, emits
   * `run.browser_surface_probe_failed` with the typed probe code and
   * detail in the event data, releases the lease, and returns the typed
   * probe result so the caller can short-circuit the run before the
   * connector child is spawned.
   *
   * This is the gate that prevents the "ask the human for an OTP and
   * THEN discover the CDP socket was already dead" failure mode.
   */
  async function performBrowserSurfaceReadinessProbe(
    lease: BrowserSurfaceLease,
    surface: BrowserSurface | null
  ): Promise<BrowserSurfaceReadinessProbeResult> {
    if (!surface) {
      return {
        ok: false,
        code: "browser_surface_not_ready",
        detail: `lease ${lease.lease_id} references missing surface ${lease.surface_id || "(none)"}`,
      };
    }
    if (!browserSurfaceReadinessProbe) {
      return { ok: true, pageTargetCount: 0 };
    }
    try {
      return await browserSurfaceReadinessProbe.probe(surface);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        code: "browser_surface_cdp_unreachable",
        detail: `readiness probe threw: ${message}`,
      };
    }
  }

  async function emitBrowserSurfaceReadyEvent(
    lease: BrowserSurfaceLease,
    connectorId: string,
    runId: string,
    traceContext: SpineTraceContext,
    result: Extract<BrowserSurfaceReadinessProbeResult, { ok: true }>
  ): Promise<void> {
    try {
      await emitSpineEvent({
        event_type: "run.browser_surface_ready",
        trace_id: traceContext.trace_id,
        scenario_id: traceContext.scenario_id,
        actor_type: "runtime",
        actor_id: connectorId,
        object_type: "run",
        object_id: runId,
        status: lease.status,
        run_id: runId,
        data: {
          source: buildRunSource(connectorId),
          browser_surface: projectBrowserSurfaceLease(lease),
          browser_surface_probe: {
            ok: true,
            page_target_count: result.pageTargetCount,
            ...(result.browserVersion ? { browser_version: result.browserVersion } : {}),
          },
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] failed to emit run.browser_surface_ready for ${runId}: ${message}`);
    }
  }

  async function emitBrowserSurfaceProbeFailedEvent(
    lease: BrowserSurfaceLease,
    connectorId: string,
    runId: string,
    traceContext: SpineTraceContext,
    result: Extract<BrowserSurfaceReadinessProbeResult, { ok: false }>
  ): Promise<void> {
    try {
      await emitSpineEvent({
        event_type: "run.browser_surface_probe_failed",
        trace_id: traceContext.trace_id,
        scenario_id: traceContext.scenario_id,
        actor_type: "runtime",
        actor_id: connectorId,
        object_type: "run",
        object_id: runId,
        status: "surface_failed",
        run_id: runId,
        data: {
          source: buildRunSource(connectorId),
          browser_surface: projectBrowserSurfaceLease(lease),
          browser_surface_probe: {
            ok: false,
            code: result.code,
            detail: result.detail,
          },
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] failed to emit run.browser_surface_probe_failed for ${runId}: ${message}`);
    }
  }

  async function runBrowserSurfaceReadinessGate(
    lease: BrowserSurfaceLease,
    surface: BrowserSurface | null,
    connectorId: string,
    runId: string,
    traceContext: SpineTraceContext
  ): Promise<BrowserSurfaceReadinessProbeResult> {
    if (!browserSurfaceReadinessProbe) {
      return { ok: true, pageTargetCount: 0 };
    }
    const result = await performBrowserSurfaceReadinessProbe(lease, surface);
    if (result.ok) {
      await emitBrowserSurfaceReadyEvent(lease, connectorId, runId, traceContext, result);
      return result;
    }
    log.warn?.(
      `[controller] browser-surface readiness probe failed for ${runId} (${connectorId}): ${result.code}: ${result.detail}`
    );
    await emitBrowserSurfaceProbeFailedEvent(lease, connectorId, runId, traceContext, result);
    // Probe failure means the in-memory surface entry is lying about
    // readiness. Evict it before releasing the lease so the next acquire
    // does not immediately re-lease the same dead surface and burn another
    // human OTP cycle. When a dynamic allocator is configured, also stop
    // the underlying container so the next acquire creates a fresh one.
    await invalidateBrowserSurfaceAfterProbeFailure(lease, result.code);
    await releaseBrowserSurfaceLease(lease, connectorId, runId, traceContext, `readiness probe failed: ${result.code}`);
    return result;
  }
  async function persistInvalidatedBrowserSurface(invalidatedSurface: BrowserSurface): Promise<void> {
    if (!browserSurfaceLeaseStore) {
      return;
    }
    try {
      await browserSurfaceLeaseStore.withLeaseTransaction(async (store) => {
        await store.upsertSurface({
          ...invalidatedSurface,
          health: "unhealthy",
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] persistence after surface invalidation failed: ${message}`);
    }
  }

  async function stopAllocatorSurfaceAfterProbeFailure(surfaceId: string, probeCode: string): Promise<void> {
    if (!browserSurfaceAllocator) {
      return;
    }
    try {
      await browserSurfaceAllocator.stopSurface({
        surfaceId,
        reason: "surface_failed",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] allocator stopSurface(${surfaceId}) after probe ${probeCode} failed: ${message}`);
    }
  }

  async function invalidateBrowserSurfaceAfterProbeFailure(
    lease: BrowserSurfaceLease,
    probeCode: string
  ): Promise<void> {
    if (!(browserSurfaceLeaseManager && lease.surface_id)) {
      return;
    }
    const surfaceId = lease.surface_id;
    // Drop the in-memory surface so #findReadyIdleSurface cannot reuse it.
    // Lease release happens separately so the lease projection stays correct;
    // we explicitly do not mark this lease surface_failed here.
    const invalidated = browserSurfaceLeaseManager.invalidateSurface(surfaceId, {
      releaseLease: false,
    });
    if (invalidated.surface) {
      await persistInvalidatedBrowserSurface(invalidated.surface);
    }
    await stopAllocatorSurfaceAfterProbeFailure(surfaceId, probeCode);
  }

  async function cancelBrowserSurfaceRun(runId: string): Promise<BrowserSurfaceProjection | null> {
    if (!browserSurfaceLeaseManager) {
      return null;
    }
    const cancelResult = browserSurfaceLeaseManager.cancelAndPump(runId);
    if (!cancelResult.lease) {
      return null;
    }
    pendingBrowserSurfaceLaunches.delete(runId);
    await emitBrowserSurfaceLeaseEvent(
      "run.browser_surface_cancelled",
      cancelResult.lease.connector_id,
      cancelResult.lease.run_id,
      createTraceContext(),
      cancelResult.lease
    );
    await persistBrowserSurfaceLeaseMutation(cancelResult.lease, cancelResult.surface);
    if (cancelResult.promoted) {
      await persistAndPromoteBrowserSurfaceLeases([cancelResult.promoted], "browser-surface cancellation");
    }
    return projectBrowserSurfaceLease(cancelResult.lease);
  }

  async function expireBrowserSurfaceWaits(): Promise<BrowserSurfaceProjection[]> {
    if (!browserSurfaceLeaseManager) {
      return [];
    }
    const deferred = browserSurfaceLeaseManager.expireWaitingLeases();
    for (const lease of deferred) {
      pendingBrowserSurfaceLaunches.delete(lease.run_id);
      await emitBrowserSurfaceLeaseEvent(
        "run.browser_surface_deferred",
        lease.connector_id,
        lease.run_id,
        createTraceContext(),
        lease
      );
      await persistBrowserSurfaceLeaseMutation(lease);
    }
    await persistAndPromoteBrowserSurfaceLeases(
      browserSurfaceLeaseManager.pumpQueuedLeases(),
      "browser-surface timeout"
    );
    return deferred.map((lease) => projectBrowserSurfaceLease(lease));
  }

  async function cleanupIdleBrowserSurfaces(): Promise<BrowserSurfaceProjection[]> {
    if (!(browserSurfaceLeaseManager && browserSurfaceAllocator)) {
      return [];
    }
    const cleanupResult = await browserSurfaceLeaseManager.cleanupIdleSurfaces(browserSurfaceAllocator);
    if (browserSurfaceLeaseStore && cleanupResult.stopped.length > 0) {
      await browserSurfaceLeaseStore.withLeaseTransaction(async (store) => {
        for (const surface of cleanupResult.stopped) {
          await store.upsertSurface(surface);
        }
      });
    }
    await persistAndPromoteBrowserSurfaceLeases(cleanupResult.promoted, "browser-surface idle cleanup");
    return cleanupResult.promoted.map((lease) => projectBrowserSurfaceLease(lease));
  }
  async function reconcileBrowserSurfacesWithAllocatorAtBoot(): Promise<void> {
    // Before lease reconciliation, ask the allocator which dynamic surfaces
    // actually exist. A persistent surface row with health=ready from a prior
    // boot whose container has been removed must not survive into the new
    // boot's in-memory state, or the next acquire will lease a dead surface
    // and burn an owner OTP cycle.
    if (!(browserSurfaceLeaseManager && browserSurfaceAllocator)) {
      return;
    }
    try {
      const allocatorReconcile =
        await browserSurfaceLeaseManager.reconcileSurfacesWithAllocator(browserSurfaceAllocator);
      const hasPersistenceWork =
        Boolean(browserSurfaceLeaseStore) &&
        (allocatorReconcile.evicted.length > 0 || allocatorReconcile.downgraded.length > 0);
      if (hasPersistenceWork && browserSurfaceLeaseStore) {
        await browserSurfaceLeaseStore.withLeaseTransaction(async (store) => {
          for (const surface of allocatorReconcile.evicted) {
            await store.upsertSurface({ ...surface, health: "unhealthy" });
          }
          for (const surface of allocatorReconcile.downgraded) {
            await store.upsertSurface(surface);
          }
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] allocator-aware surface reconciliation failed: ${message}`);
    }
  }

  async function emitAndPersistReconciledLeases(
    leases: readonly BrowserSurfaceLease[],
    eventType: string,
    options: { readonly hydrateSurface: boolean }
  ): Promise<void> {
    if (!browserSurfaceLeaseManager) {
      return;
    }
    for (const lease of leases) {
      await emitBrowserSurfaceLeaseEvent(eventType, lease.connector_id, lease.run_id, createTraceContext(), lease);
      const surface =
        options.hydrateSurface && lease.surface_id
          ? browserSurfaceLeaseManager.getSurface(lease.surface_id)
          : undefined;
      await persistBrowserSurfaceLeaseMutation(lease, surface);
    }
  }

  async function reconcileBrowserSurfaceLeasesAfterBoot(): Promise<void> {
    await startupControllerRunReconciliation;
    if (!browserSurfaceLeaseManager) {
      return;
    }
    await reconcileBrowserSurfacesWithAllocatorAtBoot();
    const activeRunIds = new Set((await listPersistedActiveRuns()).map((row) => row.run_id));
    const reconciled = browserSurfaceLeaseManager.reconcileAfterRestart({ activeRunIds, promoteQueued: false });
    await emitAndPersistReconciledLeases(reconciled.released, "run.browser_surface_released", { hydrateSurface: true });
    await emitAndPersistReconciledLeases(reconciled.expired, "run.browser_surface_expired", { hydrateSurface: false });
    await emitAndPersistReconciledLeases(reconciled.deferred, "run.browser_surface_deferred", {
      hydrateSurface: false,
    });
    await emitAndPersistReconciledLeases(reconciled.surfaceFailed, "run.browser_surface_failed", {
      hydrateSurface: true,
    });
  }

  async function promoteBrowserSurfaceLeasesAfterBoot(): Promise<void> {
    if (!browserSurfaceLeaseManager) {
      return;
    }
    await persistAndPromoteBrowserSurfaceLeases(
      browserSurfaceLeaseManager.pumpQueuedLeases(),
      "post-listener boot reconciliation"
    );
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

  // Bounded once-per-call slice of recent run history. 500 is the same
  // upper bound the scheduler runtime uses when hydrating its in-memory
  // history projection (`scheduler.ts::hydratePersistence`), so the
  // controller's read tracks the same operator-visible window without
  // pulling unbounded rows.
  const SCHEDULE_HISTORY_PROJECTION_LIMIT = 500;
  async function loadScheduleHistoryIndex(): Promise<ScheduleHistoryIndex> {
    // One bounded read of recent run history, grouped per connector. The
    // store returns rows in chronological order (oldest to newest); we walk
    // newest-first so the first row we see for each (connector, kind)
    // wins. `listLastRunTimes` covers connectors that have a persisted
    // last-run timestamp but whose history rows have rolled off the
    // bounded window; it surfaces `last_finished_at` honestly in that
    // case so the dashboard does not regress to "never ran".
    const [history, lastRunTimes] = await Promise.all([
      Promise.resolve(schedulerStore.listRunHistory(SCHEDULE_HISTORY_PROJECTION_LIMIT)),
      Promise.resolve(schedulerStore.listLastRunTimes()),
    ]);
    const facts = new Map<string, MutableScheduleHistoryFacts>();
    const ensure = (connectorId: string) => ensureScheduleHistoryFacts(facts, connectorId);
    hydrateScheduleHistoryFromLastRunTimes(lastRunTimes, ensure);
    bucketRecentRunsByConnector(history, ensure);
    deriveLatestScheduleFacts(history, ensure);
    return facts;
  }

  async function listSchedules(): Promise<ScheduleApi[]> {
    const schedules = await schedulerStore.listSchedules();
    // Single bounded read of run history + last-run-time map, indexed once
    // per `listSchedules()` call so per-connector projection avoids N+1
    // queries. The same indexer is reused by the single-row `getSchedule`
    // path with a smaller history slice.
    const historyIndex = await loadScheduleHistoryIndex();
    const apis = await Promise.all(
      schedules.map(async (schedule) => {
        const policy = await getConnectorRefreshPolicy(schedule.connector_id);
        const runtimeProjection = getRuntimeProjection(
          schedule.connector_id,
          schedule.connector_instance_id,
          browserSurfaceLeaseManager,
          historyIndex
        );
        return scheduleToApi(schedule, runtimeProjection, policy, historyIndex.get(schedule.connector_instance_id));
      })
    );
    return apis.flatMap((api) => (api ? [api] : []));
  }

  async function getSchedule(connectorId: string, options: ConnectorInstanceOptions = {}): Promise<ScheduleApi | null> {
    connectorId = canonicalConnectorKey(connectorId) ?? connectorId;
    const connectorInstanceId = options.connectorInstanceId || connectorId;
    const directSchedule = await getScheduleRecord(connectorInstanceId);
    let schedule = directSchedule;
    if (!(schedule || options.connectorInstanceId)) {
      const matches = (await schedulerStore.listSchedules()).filter(
        (candidate) => candidate.connector_id === connectorId
      );
      if (matches.length > 1) {
        throw new ControllerError(
          `Connector '${connectorId}' has multiple schedules; provide connector_instance_id.`,
          "ambiguous_connector_instance"
        );
      }
      schedule = matches[0] ?? null;
    }
    if (!schedule) {
      return null;
    }
    const policy = await getConnectorRefreshPolicy(connectorId);
    const historyIndex = await loadScheduleHistoryIndex();
    const runtimeProjection = getRuntimeProjection(
      connectorId,
      schedule.connector_instance_id,
      browserSurfaceLeaseManager,
      historyIndex
    );
    return scheduleToApi(schedule, runtimeProjection, policy, historyIndex.get(schedule.connector_instance_id));
  }

  async function upsertSchedule(
    connectorId: string,
    input: ConnectorSchedulePatch,
    options: ConnectorInstanceOptions = {}
  ): Promise<ScheduleUpsertResult> {
    connectorId = canonicalConnectorKey(connectorId) ?? connectorId;
    const connectorInstanceId = options.connectorInstanceId || connectorId;
    const now = nowIso();
    const validated = validateScheduleInput(input);
    const policy = await getConnectorRefreshPolicy(connectorId);
    const ineligibilityReason = validated.enabled ? getScheduleIneligibilityReason(policy) : null;
    if (ineligibilityReason) {
      throw new ControllerError(ineligibilityReason, "invalid_request");
    }
    const existing = await getScheduleRecord(connectorInstanceId);
    if (existing) {
      await schedulerStore.updateSchedule(connectorInstanceId, {
        interval_seconds: validated.interval_seconds,
        jitter_seconds: validated.jitter_seconds,
        enabled: validated.enabled,
        updated_at: now,
      });
    } else {
      await schedulerStore.createSchedule({
        connector_instance_id: connectorInstanceId,
        connector_id: connectorId,
        interval_seconds: validated.interval_seconds,
        jitter_seconds: validated.jitter_seconds,
        enabled: validated.enabled,
        created_at: now,
        updated_at: now,
      });
    }
    const historyIndex = await loadScheduleHistoryIndex();
    const schedule = scheduleToApi(
      await getScheduleRecord(connectorInstanceId),
      getRuntimeProjection(connectorId, connectorInstanceId, browserSurfaceLeaseManager, historyIndex),
      policy,
      historyIndex.get(connectorInstanceId)
    );
    if (!schedule) {
      throw new ControllerError(`Schedule not found after upsert for connector: ${connectorId}`, "internal_error");
    }
    const policy_warning = buildMinimumIntervalWarning(validated.interval_seconds, policy);
    return { schedule, policy_warning };
  }

  async function setScheduleEnabled(
    connectorId: string,
    enabled: boolean,
    options: ConnectorInstanceOptions = {}
  ): Promise<ScheduleApi | null> {
    connectorId = canonicalConnectorKey(connectorId) ?? connectorId;
    const connectorInstanceId = options.connectorInstanceId || connectorId;
    const existing = await getScheduleRecord(connectorInstanceId);
    if (!existing) {
      throw new ControllerError(`Schedule not found for connector: ${connectorId}`, "not_found");
    }
    const policy = await getConnectorRefreshPolicy(connectorId);
    const ineligibilityReason = enabled ? getScheduleIneligibilityReason(policy) : null;
    if (ineligibilityReason) {
      throw new ControllerError(ineligibilityReason, "invalid_request");
    }
    await schedulerStore.setScheduleEnabled(connectorInstanceId, enabled, nowIso());
    const historyIndex = await loadScheduleHistoryIndex();
    return scheduleToApi(
      await getScheduleRecord(connectorInstanceId),
      getRuntimeProjection(connectorId, existing.connector_instance_id, browserSurfaceLeaseManager, historyIndex),
      policy
    );
  }

  function markNeedsHuman(connectorId: string, options: ConnectorInstanceOptions = {}): void {
    needsHumanAttention.add(runtimeKey(connectorId, options.connectorInstanceId));
  }

  function clearNeedsHuman(connectorId: string, options: ConnectorInstanceOptions = {}): void {
    needsHumanAttention.delete(runtimeKey(connectorId, options.connectorInstanceId));
  }

  async function deleteSchedule(connectorId: string, options: ConnectorInstanceOptions = {}): Promise<boolean> {
    connectorId = canonicalConnectorKey(connectorId) ?? connectorId;
    const connectorInstanceId = options.connectorInstanceId || connectorId;
    const existing = await getScheduleRecord(connectorInstanceId);
    if (!existing) {
      return false;
    }
    await schedulerStore.deleteSchedule(connectorInstanceId);
    return true;
  }

  function getActiveRun(connectorId: string, options: ConnectorInstanceOptions = {}): ActiveRun | null {
    return activeRuns.get(runtimeKey(connectorId, options.connectorInstanceId)) || null;
  }
  interface ManagedSurfaceContext {
    readonly automationMetadata: ReturnType<typeof runAutomationMetadata>;
    readonly connectorId: string;
    readonly connectorInstanceId: string;
    readonly manifest: ConnectorManifest;
    readonly options: RunNowOptions;
    readonly runId: string;
    readonly traceContext: SpineTraceContext;
  }

  interface ManagedSurfaceEarlyReturn {
    readonly kind: "early_return";
    readonly result: RunNowResult;
  }

  interface ManagedSurfaceReady {
    readonly env: Record<string, string> | null;
    readonly kind: "ready";
    readonly lease: BrowserSurfaceLease | null;
  }

  type ManagedSurfaceAcquireResult = ManagedSurfaceEarlyReturn | ManagedSurfaceReady;

  function buildBrowserSurfaceEarlyReturn(
    ctx: ManagedSurfaceContext,
    lease: BrowserSurfaceLease,
    status: NonNullable<RunNowResult["status"]>,
    surfaceOverride?: BrowserSurfaceProjection
  ): RunNowResult {
    return {
      run_id: ctx.runId,
      trace_id: ctx.traceContext.trace_id,
      status,
      browser_surface: surfaceOverride ?? projectBrowserSurfaceLease(lease),
      ...ctx.automationMetadata,
    };
  }

  async function tryPromoteReclaimedWaitingLease(
    ctx: ManagedSurfaceContext,
    reclaimedResult: { lease: BrowserSurfaceLease; surface?: BrowserSurface }
  ): Promise<ManagedSurfaceAcquireResult | null> {
    if (!browserSurfaceLeaseManager) {
      return null;
    }
    const { connectorId, runId, traceContext } = ctx;
    if (reclaimedResult.lease.status === "starting_surface") {
      return await handleStartingSurfaceWaitForRun(ctx, reclaimedResult.lease);
    }
    if (reclaimedResult.lease.status === "leased" && reclaimedResult.surface) {
      pendingBrowserSurfaceLaunches.delete(reclaimedResult.lease.run_id);
      await emitBrowserSurfaceLeaseEvent(
        "run.browser_surface_starting",
        connectorId,
        runId,
        traceContext,
        reclaimedResult.lease
      );
      await emitBrowserSurfaceLeaseEvent(
        "run.browser_surface_leased",
        connectorId,
        runId,
        traceContext,
        reclaimedResult.lease
      );
      return {
        kind: "ready",
        lease: reclaimedResult.lease,
        env: browserSurfaceLeaseEnv(reclaimedResult.lease, reclaimedResult.surface),
      };
    }
    return { kind: "ready", lease: reclaimedResult.lease, env: null };
  }

  async function handleStartingSurfaceWaitForRun(
    ctx: ManagedSurfaceContext,
    startingLease: BrowserSurfaceLease
  ): Promise<ManagedSurfaceAcquireResult> {
    if (!browserSurfaceLeaseManager) {
      return { kind: "ready", lease: startingLease, env: null };
    }
    const { connectorId, runId, traceContext } = ctx;
    const readyResult = await waitForStartingBrowserSurface(startingLease, connectorId, runId, traceContext);
    if (readyResult.lease.status === "surface_failed") {
      pendingBrowserSurfaceLaunches.delete(runId);
      await emitBrowserSurfaceLeaseEvent(
        "run.browser_surface_failed",
        connectorId,
        runId,
        traceContext,
        readyResult.lease
      );
      return { kind: "early_return", result: buildBrowserSurfaceEarlyReturn(ctx, readyResult.lease, "surface_failed") };
    }
    const readySurface =
      readyResult.surface ??
      (readyResult.lease.surface_id ? browserSurfaceLeaseManager.getSurface(readyResult.lease.surface_id) : undefined);
    if (readyResult.lease.status === "leased" && readySurface) {
      pendingBrowserSurfaceLaunches.delete(readyResult.lease.run_id);
      await emitBrowserSurfaceLeaseEvent(
        "run.browser_surface_leased",
        connectorId,
        runId,
        traceContext,
        readyResult.lease
      );
      return {
        kind: "ready",
        lease: readyResult.lease,
        env: browserSurfaceLeaseEnv(readyResult.lease, readySurface),
      };
    }
    await emitBrowserSurfaceLeaseEvent(
      "run.browser_surface_deferred",
      connectorId,
      runId,
      traceContext,
      readyResult.lease
    );
    return { kind: "early_return", result: buildBrowserSurfaceEarlyReturn(ctx, readyResult.lease, "deferred") };
  }

  async function handleLeasedSurfaceForRun(
    ctx: ManagedSurfaceContext,
    leasedLease: BrowserSurfaceLease
  ): Promise<ManagedSurfaceAcquireResult> {
    if (!(browserSurfaceLeaseManager && leasedLease.surface_id)) {
      return { kind: "ready", lease: leasedLease, env: null };
    }
    const { connectorId, runId, traceContext } = ctx;
    const leasedSurface = browserSurfaceLeaseManager.getSurface(leasedLease.surface_id);
    if (!leasedSurface) {
      pendingBrowserSurfaceLaunches.delete(runId);
      if (browserSurfaceReadinessProbe) {
        await runBrowserSurfaceReadinessGate(leasedLease, null, connectorId, runId, traceContext);
        const projected = projectBrowserSurfaceLease(leasedLease);
        return {
          kind: "early_return",
          result: buildBrowserSurfaceEarlyReturn(ctx, leasedLease, "surface_failed", {
            ...projected,
            browser_surface_status: "surface_failed",
          }),
        };
      }
      await emitBrowserSurfaceLeaseEvent("run.browser_surface_deferred", connectorId, runId, traceContext, leasedLease);
      return { kind: "early_return", result: buildBrowserSurfaceEarlyReturn(ctx, leasedLease, "deferred") };
    }
    pendingBrowserSurfaceLaunches.delete(leasedLease.run_id);
    await emitBrowserSurfaceLeaseEvent("run.browser_surface_starting", connectorId, runId, traceContext, leasedLease);
    await emitBrowserSurfaceLeaseEvent("run.browser_surface_leased", connectorId, runId, traceContext, leasedLease);
    return { kind: "ready", lease: leasedLease, env: browserSurfaceLeaseEnv(leasedLease, leasedSurface) };
  }

  async function dispatchCurrentLeaseState(
    ctx: ManagedSurfaceContext,
    currentLease: BrowserSurfaceLease | null,
    leaseResult: { lease: BrowserSurfaceLease },
    envFromReclaim: Record<string, string> | null
  ): Promise<ManagedSurfaceAcquireResult> {
    if (envFromReclaim) {
      // Capacity-pressure reclaim may have already promoted and readied this lease.
      return { kind: "ready", lease: currentLease, env: envFromReclaim };
    }
    const { connectorId, runId, traceContext } = ctx;
    if (currentLease?.status === "deferred") {
      pendingBrowserSurfaceLaunches.delete(runId);
      await emitBrowserSurfaceLeaseEvent(
        "run.browser_surface_deferred",
        connectorId,
        runId,
        traceContext,
        currentLease
      );
      return { kind: "early_return", result: buildBrowserSurfaceEarlyReturn(ctx, currentLease, currentLease.status) };
    }
    if (currentLease?.status === "starting_surface") {
      return await handleStartingSurfaceWaitForRun(ctx, currentLease);
    }
    if (currentLease?.status === "leased" && currentLease.surface_id) {
      return await handleLeasedSurfaceForRun(ctx, currentLease);
    }
    const terminalLease = currentLease ?? leaseResult.lease;
    await emitBrowserSurfaceLeaseEvent("run.browser_surface_deferred", connectorId, runId, traceContext, terminalLease);
    return { kind: "early_return", result: buildBrowserSurfaceEarlyReturn(ctx, terminalLease, "deferred") };
  }

  async function runBrowserSurfaceReadinessGateForLease(
    ctx: ManagedSurfaceContext,
    lease: BrowserSurfaceLease
  ): Promise<RunNowResult | null> {
    if (!(browserSurfaceLeaseManager && browserSurfaceReadinessProbe)) {
      return null;
    }
    const surfaceForProbe = lease.surface_id ? (browserSurfaceLeaseManager.getSurface(lease.surface_id) ?? null) : null;
    const probeResult = await runBrowserSurfaceReadinessGate(
      lease,
      surfaceForProbe,
      ctx.connectorId,
      ctx.runId,
      ctx.traceContext
    );
    if (probeResult.ok) {
      return null;
    }
    pendingBrowserSurfaceLaunches.delete(ctx.runId);
    const projected = projectBrowserSurfaceLease(lease);
    return buildBrowserSurfaceEarlyReturn(ctx, lease, "surface_failed", {
      ...projected,
      browser_surface_status: "surface_failed",
    });
  }

  async function acquireInitialBrowserSurfaceLease(
    ctx: ManagedSurfaceContext,
    priorityClass: NonNullable<RunNowOptions["priorityClass"]>
  ): Promise<ReturnType<BrowserSurfaceLeaseManager["acquire"]>> {
    if (!browserSurfaceLeaseManager) {
      throw new Error("browser surface lease manager required to acquire a managed surface lease");
    }
    const { connectorId, connectorInstanceId, manifest, runId, traceContext } = ctx;
    const profileKey = readBrowserSurfaceProfileKey(connectorId, connectorInstanceId, manifest);
    const surfaceSubjectId = connectorInstanceId === connectorId ? undefined : connectorInstanceId;
    const leaseResult = browserSurfaceLeaseManager.acquire({
      connectorId,
      runId,
      profileKey,
      ...(surfaceSubjectId ? { surfaceSubjectId } : {}),
      priorityClass,
    });
    await persistBrowserSurfaceLeaseMutation(leaseResult.lease, leaseResult.surface);
    if (leaseResult.duplicateOf && leaseResult.lease.run_id !== runId) {
      throw new ControllerError(
        `Connector already has a pending browser-surface run: ${leaseResult.lease.run_id}`,
        "run_browser_surface_queued",
        { runId: leaseResult.lease.run_id }
      );
    }
    await emitBrowserSurfaceLeaseEvent(
      "run.browser_surface_requested",
      connectorId,
      runId,
      traceContext,
      leaseResult.lease
    );
    return leaseResult;
  }

  interface ReclaimResolution {
    readonly earlyReturn?: ManagedSurfaceEarlyReturn;
    readonly env: Record<string, string> | null;
    readonly lease: BrowserSurfaceLease;
  }

  async function reclaimWaitingLeaseIfNeeded(
    ctx: ManagedSurfaceContext,
    initialLease: BrowserSurfaceLease
  ): Promise<ReclaimResolution> {
    if (initialLease.status !== "waiting_for_browser_surface") {
      return { env: null, lease: initialLease };
    }
    const reclaimedResult = await reclaimCapacityAndPromoteLease(initialLease);
    const reclaimed = reclaimedResult.lease;
    if (reclaimed.run_id !== ctx.runId || reclaimed.status === "waiting_for_browser_surface") {
      return { env: null, lease: initialLease };
    }
    const promoted = await tryPromoteReclaimedWaitingLease(ctx, reclaimedResult);
    if (!promoted) {
      return { env: null, lease: initialLease };
    }
    if (promoted.kind === "early_return") {
      return { earlyReturn: promoted, env: null, lease: initialLease };
    }
    return { env: promoted.env, lease: promoted.lease ?? initialLease };
  }

  function queueWaitingBrowserSurfaceLaunch(
    ctx: ManagedSurfaceContext,
    priorityClass: NonNullable<RunNowOptions["priorityClass"]>
  ): void {
    const { connectorInstanceId, manifest, runId, traceContext, options } = ctx;
    pendingBrowserSurfaceLaunches.set(runId, {
      connectorInstanceId,
      manifest,
      priorityClass,
      runId,
      traceContext,
      ...(options.ownerToken ? { ownerToken: options.ownerToken } : {}),
      ...(options.rsUrl ? { rsUrl: options.rsUrl } : {}),
    });
  }

  async function acquireManagedBrowserSurfaceForRun(ctx: ManagedSurfaceContext): Promise<ManagedSurfaceAcquireResult> {
    if (!browserSurfaceLeaseManager) {
      return { kind: "ready", lease: null, env: null };
    }
    const priorityClass = ctx.options.priorityClass ?? "owner_interactive";
    const leaseResult = await acquireInitialBrowserSurfaceLease(ctx, priorityClass);
    const reclaim = await reclaimWaitingLeaseIfNeeded(ctx, leaseResult.lease);
    if (reclaim.earlyReturn) {
      return reclaim.earlyReturn;
    }

    const refreshedLease = browserSurfaceLeaseManager.getLease(reclaim.lease.lease_id) ?? reclaim.lease;
    if (refreshedLease.status === "waiting_for_browser_surface") {
      queueWaitingBrowserSurfaceLaunch(ctx, priorityClass);
      await emitBrowserSurfaceLeaseEvent(
        "run.browser_surface_queued",
        ctx.connectorId,
        ctx.runId,
        ctx.traceContext,
        refreshedLease
      );
      return {
        kind: "early_return",
        result: buildBrowserSurfaceEarlyReturn(ctx, refreshedLease, refreshedLease.status),
      };
    }

    const dispatchResult = await dispatchCurrentLeaseState(ctx, refreshedLease, leaseResult, reclaim.env);
    if (dispatchResult.kind === "early_return") {
      return dispatchResult;
    }

    // Preflight readiness gate. The allocator + lease manager have agreed the
    // surface is "leased + ready", but that's bookkeeping — it has not proven
    // the CDP target is alive RIGHT NOW. Probe before we hand env to the
    // connector and ask the human for an OTP. On failure, emit a typed event,
    // release the lease, and return surface_failed.
    if (dispatchResult.lease && dispatchResult.env) {
      const failureResult = await runBrowserSurfaceReadinessGateForLease(ctx, dispatchResult.lease);
      if (failureResult) {
        return { kind: "early_return", result: failureResult };
      }
    }
    return dispatchResult;
  }

  function deriveCollectionState(syncState: { state?: unknown } | null): {
    readonly collectionMode: "full_refresh" | "incremental";
    readonly state: Record<string, unknown> | null;
  } {
    const rawState = syncState?.state;
    const state: Record<string, unknown> | null =
      rawState && typeof rawState === "object" && !Array.isArray(rawState) && Object.keys(rawState).length
        ? (rawState as Record<string, unknown>)
        : null;
    return { collectionMode: state ? "incremental" : "full_refresh", state };
  }

  function mintStreamingRegistrationNonce(runId: string): string | null {
    // Mode-A streaming-target registration: mint a per-run shared secret
    // before spawning the connector child. The hook stores its hash; the raw
    // nonce flows to the child via env (see runConnector below) and is
    // presented as a Bearer credential when the child registers its CDP
    // page-target wsUrl. 32 bytes of CSPRNG entropy yields a 64-char hex
    // token — enough that brute force across the run's lifetime is not a
    // credible threat. Hooks may be unset (older deployments, tests that
    // don't exercise streaming); when unset, no nonce is minted, the env
    // vars are not threaded, and Mode-A streaming gracefully no-ops.
    if (!opts.streamingTargetNonceHooks) {
      return null;
    }
    const nonce = randomBytes(32).toString("hex");
    try {
      opts.streamingTargetNonceHooks.registerNonce({ runId, nonce });
    } catch (err) {
      // Don't fail the run if the registry rejects (e.g. duplicate runId).
      // Streaming will simply be unavailable for this run.
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] streaming nonce register failed for ${runId}: ${message}`);
    }
    return nonce;
  }

  async function registerActiveRunBookkeeping(input: {
    readonly browserSurfaceLease: BrowserSurfaceLease | null;
    readonly connectorId: string;
    readonly connectorInstanceId: string;
    readonly key: string;
    readonly runId: string;
    readonly startedAt: string;
    readonly traceContext: SpineTraceContext;
  }): Promise<string | null> {
    try {
      await persistActiveRun({
        connector_instance_id: input.connectorInstanceId,
        connector_id: input.connectorId,
        run_id: input.runId,
        trace_id: input.traceContext.trace_id,
        scenario_id: input.traceContext.scenario_id,
        started_at: input.startedAt,
      });
      activeRuns.set(input.key, {
        connector_id: input.connectorId,
        connector_instance_id: input.connectorInstanceId,
        run_id: input.runId,
        trace_id: input.traceContext.trace_id,
        started_at: input.startedAt,
      });
      activeRunTraceContexts.set(input.runId, input.traceContext);
      activeRunInteractions.set(input.runId, {
        connector_id: input.connectorId,
        pending: null,
      });
      return mintStreamingRegistrationNonce(input.runId);
    } catch (err) {
      if (input.browserSurfaceLease) {
        await releaseBrowserSurfaceLease(
          input.browserSurfaceLease,
          input.connectorId,
          input.runId,
          input.traceContext,
          "pre-spawn failure"
        );
      }
      throw err;
    }
  }

  function clearStreamingNonceForRun(runId: string): void {
    // Clear the per-run streaming nonce. Idempotent at the registry level,
    // so the conditional here is just to avoid a needless call when
    // streaming hooks weren't wired up at all.
    if (!opts.streamingTargetNonceHooks) {
      return;
    }
    try {
      opts.streamingTargetNonceHooks.clearNonce({ runId });
    } catch {
      /* registry shutdown raced run end — safe to ignore */
    }
  }

  async function releaseBrowserSurfaceLeaseAfterRun(
    lease: BrowserSurfaceLease,
    connectorId: string,
    runId: string,
    traceContext: SpineTraceContext
  ): Promise<void> {
    try {
      await releaseBrowserSurfaceLease(lease, connectorId, runId, traceContext, `${runId} release`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] failed to persist browser-surface lease release for ${runId}: ${message}`);
    }
  }

  function resolveCancelledInteraction(runId: string): void {
    const leftover = activeRunInteractions.get(runId);
    activeRunInteractions.delete(runId);
    if (leftover?.pending) {
      leftover.pending.resolve({
        type: "INTERACTION_RESPONSE",
        request_id: leftover.pending.interaction_id,
        status: "cancelled",
      });
    }
  }

  async function finalizeRunCleanup(input: {
    readonly browserSurfaceLease: BrowserSurfaceLease | null;
    readonly connectorId: string;
    readonly connectorInstanceId: string;
    readonly key: string;
    readonly runId: string;
    readonly traceContext: SpineTraceContext;
  }): Promise<void> {
    activeRuns.delete(input.key);
    activeRunPromises.delete(input.runId);
    activeRunTraceContexts.delete(input.runId);
    clearPersistedActiveRun(input.connectorInstanceId, input.runId).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] failed to clear active run ${input.runId} for ${input.connectorId}: ${message}`);
    });
    clearStreamingNonceForRun(input.runId);
    if (input.browserSurfaceLease) {
      await releaseBrowserSurfaceLeaseAfterRun(
        input.browserSurfaceLease,
        input.connectorId,
        input.runId,
        input.traceContext
      );
    }
    resolveCancelledInteraction(input.runId);
  }

  async function validateRunNowPreconditions(
    connectorId: string,
    options: RunNowOptions,
    key: string
  ): Promise<{ readonly connectorPath: string; readonly manifest: ConnectorManifest }> {
    const manifest = options.manifest ?? (await getConnectorManifest(connectorId));
    if (!manifest) {
      throw new ControllerError(`Unknown connector: ${connectorId}`, "not_found");
    }
    const existing = activeRuns.get(key);
    if (existing) {
      throw new ControllerError(`Connector already has an active run: ${existing.run_id}`, "run_already_active", {
        runId: existing.run_id,
      });
    }
    const connectorPath = await Promise.resolve(resolveConnectorPath(connectorId, manifest, options));
    if (!connectorPath) {
      throw new ControllerError(`No runnable connector implementation is available for ${connectorId}`, "not_found");
    }
    return { connectorPath, manifest };
  }

  async function runNow(connectorId: string, options: RunNowOptions = {}): Promise<RunNowResult> {
    const connectorInstanceId = options.connectorInstanceId || connectorId;
    const key = runtimeKey(connectorId, connectorInstanceId);
    const { manifest, connectorPath } = await validateRunNowPreconditions(connectorId, options, key);

    const triggerKind = options.triggerKind ?? "manual";
    const automationMetadata = runAutomationMetadata(readManifestRefreshPolicy(manifest), triggerKind);
    const traceContext =
      options.traceContext ??
      (options.scenarioId ? createTraceContext({ scenarioId: options.scenarioId }) : createTraceContext());
    const runId = options.runId || `run_${Date.now()}`;
    const startedAt = nowIso();

    const acquireResult = browserSurfaceLeaseManager?.isManagedConnector(connectorId)
      ? await acquireManagedBrowserSurfaceForRun({
          automationMetadata,
          connectorId,
          connectorInstanceId,
          manifest,
          options,
          runId,
          traceContext,
        })
      : ({ kind: "ready", lease: null, env: null } as ManagedSurfaceReady);
    if (acquireResult.kind === "early_return") {
      return acquireResult.result;
    }
    const browserSurfaceLease = acquireResult.lease;
    const browserSurfaceEnv = acquireResult.env;

    const { state, collectionMode } = deriveCollectionState(
      (await getSyncState(connectorId, { connectorInstanceId })) as { state?: unknown } | null
    );
    const ownerToken = options.ownerToken || (await issueRuntimeOwnerToken());

    // Manual owner gestures clear any pending human-attention flag so the
    // scheduler can resume after the owner resolves the issue. Webhook
    // triggers are external automation and must not silently clear this gate.
    if (triggerKind === "manual") {
      needsHumanAttention.delete(key);
    }

    const streamingNonce = await registerActiveRunBookkeeping({
      browserSurfaceLease,
      connectorId,
      connectorInstanceId,
      key,
      runId,
      startedAt,
      traceContext,
    });

    const connectorDisplayName = readManifestDisplayName(manifest) ?? connectorId;
    const interactionHandler = (interaction: unknown) =>
      brokerInteraction(runId, connectorId, interaction as RuntimeInteraction, {
        connectorDisplayName,
        log,
        ownerSubjectId,
      });
    const handleAssistanceProgress = (msg: unknown) => {
      // Progress is persisted via the event spine, not this callback. The
      // one exception is nonblocking ASSISTANCE: the owner has to act
      // somewhere outside PDPP (e.g. approve a ChatGPT push in the app) and
      // we want their subscribed PWA to ring. INTERACTION pushes still flow
      // through brokerInteraction → fireWebPush.
      if (shouldFanoutAssistanceProgressMessage(msg)) {
        detachControllerTask(
          fireAssistanceWebPush({
            assistance: msg as Record<string, unknown>,
            connectorDisplayName,
            ownerSubjectId,
            runId,
            log,
          })
        );
      }
    };

    // runNow returns the run handle immediately; the actual connector
    // execution resolves later and clears activeRuns in the finally.
    // Callers poll the projection via getActiveRun / listSchedules.
    //
    // The Promise itself is tracked in `activeRunPromises` so the
    // graceful-shutdown path (`drainActiveRuns`) can await in-flight
    // children before the parent process exits — critical for Chromium
    // release() to complete and prevent stale singleton-lock files (see
    // polyfill-connectors/src/profile-lock.ts).
    const runPromise = Promise.resolve()
      .then(() =>
        runConnectorImpl({
          connectorPath,
          connectorId,
          connectorInstanceId,
          ownerToken,
          manifest,
          state,
          collectionMode,
          rsUrl: currentRsUrl(options.rsUrl),
          runId,
          traceContext,
          triggerKind,
          automationMode: automationMetadata.automation_mode ?? null,
          onInteraction: interactionHandler,
          onProgress: handleAssistanceProgress,
          // Mode-A streaming registration env. Both fields must be present
          // for runConnector to thread them into the spawn env; either
          // omitted is a graceful no-op.
          streamingRegistrationToken: streamingNonce,
          referenceBaseUrl: currentReferenceBaseUrl(),
          browserSurfaceEnv,
        })
      )
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error?.(`[controller] manual run failed for ${connectorId}: ${message}`);
      })
      .finally(() =>
        finalizeRunCleanup({
          browserSurfaceLease,
          connectorId,
          connectorInstanceId,
          key,
          runId,
          traceContext,
        })
      );
    activeRunPromises.set(runId, runPromise);

    return { run_id: runId, trace_id: traceContext.trace_id, status: "started", ...automationMetadata };
  }

  // ─── Graceful-shutdown drain ────────────────────────────────────────────
  //
  // Await all in-flight run promises with a hard deadline. The parent's
  // SIGTERM handler in server/index.js calls this before process.exit.
  // Returns the count drained, the count timed out, and elapsed wall-clock
  // time so the caller can log a useful summary.
  function drainActiveRuns(timeoutMs: number): Promise<DrainSummary> {
    return drainPromisesWithDeadline(activeRunPromises, timeoutMs);
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
    if (input.status === "cancelled" && browserSurfaceLeaseManager) {
      const lease = browserSurfaceLeaseManager
        .listLeases()
        .find((candidate) => candidate.run_id === runId && candidate.status === "leased");
      const traceContext = activeRunTraceContexts.get(runId);
      if (lease && traceContext) {
        emitBrowserSurfaceLeaseEvent("run.browser_surface_cancelled", entry.connector_id, runId, traceContext, lease);
      }
    }
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

  function listBrowserSurfaceRunProjections(): BrowserSurfaceRunProjection[] {
    if (!browserSurfaceLeaseManager) {
      return [];
    }
    return browserSurfaceLeaseManager.listLeases().map((lease) => ({
      connector_id: lease.connector_id,
      ...projectBrowserSurfaceLease(lease),
    }));
  }

  return {
    cancelBrowserSurfaceRun,
    cleanupIdleBrowserSurfaces,
    listSchedules,
    getSchedule,
    upsertSchedule,
    setScheduleEnabled,
    deleteSchedule,
    drainActiveRuns,
    expireBrowserSurfaceWaits,
    getActiveRun,
    listBrowserSurfaceRunProjections,
    promoteBrowserSurfaceLeasesAfterBoot,
    reconcileBrowserSurfaceLeasesAfterBoot,
    getPendingInteraction,
    isNeedsHuman: (connectorId: string, options: ConnectorInstanceOptions = {}) =>
      needsHumanAttention.has(runtimeKey(connectorId, options.connectorInstanceId)),
    issueRuntimeOwnerToken,
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
