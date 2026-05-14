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
import {
  type BrowserSurface,
  type BrowserSurfaceAllocator,
  type BrowserSurfaceLease,
  type BrowserSurfaceLeaseManager,
  type BrowserSurfaceProjection,
  projectBrowserSurfaceLease,
} from "@pdpp/remote-surface/leases";
import { browserSurfaceLeaseEnv } from "./browser-surface-leases.ts";
import { type BrowserSurfaceLeaseStore } from "../server/stores/browser-surface-lease-store.ts";
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
  readonly pending_run_id?: string;
  readonly browser_surface_lease_id?: string;
  readonly browser_surface_profile_key?: string;
  readonly browser_surface_status?: BrowserSurfaceProjection["browser_surface_status"];
  readonly browser_surface_wait_reason?: BrowserSurfaceProjection["browser_surface_wait_reason"];
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
  readonly pending_run_id?: string;
  readonly browser_surface_lease_id?: string;
  readonly browser_surface_profile_key?: string;
  readonly browser_surface_status?: BrowserSurfaceProjection["browser_surface_status"];
  readonly browser_surface_wait_reason?: BrowserSurfaceProjection["browser_surface_wait_reason"];
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
  priorityClass?: "owner_interactive" | "scheduled_refresh";
  rsUrl?: string;
  runId?: string;
  scenarioId?: string;
  traceContext?: SpineTraceContext;
}

export interface RunNowResult {
  readonly browser_surface?: BrowserSurfaceProjection;
  readonly run_id: string;
  readonly status?: "started" | BrowserSurfaceProjection["browser_surface_status"];
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
  registerNonce(args: { runId: string; nonce: string }): void;
  clearNonce(args: { runId: string }): void;
}

export interface ControllerOptions {
  asPublicUrl?: string;
  connectorPathResolver?: ConnectorPathResolver;
  logger?: ControllerLogger;
  ownerClientId?: string;
  ownerSubjectId?: string;
  rsUrl?: string;
  runtime?: unknown;
  /**
   * Mutable runtime-context bag the surrounding server populates after
   * its listeners are bound. The controller reads `rsUrl` and the new
   * `referenceBaseUrl` lazily so it picks up the realized values once
   * the AS server has actually allocated its port.
   */
  runtimeContext?: { rsUrl?: string; referenceBaseUrl?: string };
  scheduler?: unknown;
  browserSurfaceAllocator?: BrowserSurfaceAllocator;
  browserSurfaceLeaseManager?: BrowserSurfaceLeaseManager;
  browserSurfaceReadinessTimeoutMs?: number;
  browserSurfaceLeaseStore?: BrowserSurfaceLeaseStore;
  runConnectorImpl?: RunConnectorFn;
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
  clearNeedsHuman(connectorId: string): void;
  deleteSchedule(connectorId: string): Promise<boolean>;
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
  cleanupIdleBrowserSurfaces(): Promise<BrowserSurfaceProjection[]>;
  expireBrowserSurfaceWaits(): Promise<BrowserSurfaceProjection[]>;
  getActiveRun(connectorId: string): ActiveRun | null;
  getPendingInteraction(runId: string): PendingInteractionProjection | null;
  getSchedule(connectorId: string): Promise<ScheduleApi | null>;
  listSchedules(): Promise<ScheduleApi[]>;
  markNeedsHuman(connectorId: string): void;
  promoteBrowserSurfaceLeasesAfterBoot(): Promise<void>;
  reconcileBrowserSurfaceLeasesAfterBoot(): Promise<void>;
  respondToInteraction(runId: string, input?: RunInteractionResponseInput): RunInteractionAck;
  listBrowserSurfaceRunProjections(): BrowserSurfaceRunProjection[];
  runNow(connectorId: string, options?: RunNowOptions): Promise<RunNowResult>;
  setScheduleEnabled(connectorId: string, enabled: boolean): Promise<ScheduleApi | null>;
  upsertSchedule(connectorId: string, input: ConnectorSchedulePatch): Promise<ScheduleUpsertResult>;
}

export interface DrainSummary {
  readonly drained: number;
  readonly timedOut: number;
  /** Wall-clock milliseconds spent in drainActiveRuns. */
  readonly elapsedMs: number;
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
  timeoutMs: number,
): Promise<DrainSummary> {
  const startMs = Date.now();
  const snapshot = Array.from(pending.values());
  if (snapshot.length === 0) {
    return { drained: 0, timedOut: 0, elapsedMs: 0 };
  }
  let timeoutHandle: NodeJS.Timeout | null = null;
  const deadline = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
    if (timeoutHandle.unref) timeoutHandle.unref();
  });
  const allSettled = Promise.allSettled(snapshot).then(() => "settled" as const);
  const outcome = await Promise.race([allSettled, deadline]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
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

function readBrowserSurfaceProfileKey(
  connectorId: string,
  manifest: ConnectorManifest | null | undefined,
): string {
  const caps = manifest && typeof manifest === "object" ? (manifest as { capabilities?: unknown }).capabilities : null;
  const browserSurface =
    caps && typeof caps === "object" ? (caps as { browser_surface?: unknown }).browser_surface : null;
  const profileKey =
    browserSurface && typeof browserSurface === "object"
      ? (browserSurface as { profile_key?: unknown }).profile_key
      : null;
  return typeof profileKey === "string" && profileKey.trim() ? profileKey.trim() : connectorId;
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

function getRuntimeProjection(
  connectorId: string,
  browserSurfaceLeaseManager?: BrowserSurfaceLeaseManager,
): RuntimeProjection {
  const active = activeRuns.get(connectorId) || null;
  const pendingBrowserSurfaceLease = browserSurfaceLeaseManager
    ?.listLeases()
    .find(
      (lease) =>
        lease.connector_id === connectorId &&
        (lease.status === "waiting_for_browser_surface" || lease.status === "deferred")
    );
  const browserSurfaceProjection = pendingBrowserSurfaceLease
    ? projectBrowserSurfaceLease(pendingBrowserSurfaceLease)
    : null;
  if (!active) {
    return {
      active_run_id: null,
      ...(browserSurfaceProjection ?? {}),
      last_started_at: null,
      last_finished_at: null,
      last_error_code: null,
      last_successful_at: null,
      human_attention_needed: needsHumanAttention.has(connectorId),
    };
  }
  return {
    active_run_id: active.run_id,
    ...(browserSurfaceProjection ?? {}),
    last_started_at: active.started_at,
    last_finished_at: null,
    last_error_code: null,
    last_successful_at: null,
    human_attention_needed: needsHumanAttention.has(connectorId),
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
  if (explicit) return explicit;
  const referenceOrigin = process.env.PDPP_REFERENCE_ORIGIN?.trim();
  if (referenceOrigin) return referenceOrigin;
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
async function fireNtfy(
  args: {
    interaction: RuntimeInteraction;
    connectorDisplayName: string;
    runId: string;
    log: ControllerLogger;
  }
): Promise<void> {
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
    const tags =
      interaction.kind === "manual_action"
        ? ["construction"]
        : interaction.kind === "credentials" || interaction.kind === "otp"
          ? ["key"]
          : ["construction"];
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

function brokerInteraction(
  runId: string,
  connectorId: string,
  interaction: RuntimeInteraction,
  notifyArgs?: { connectorDisplayName: string; log: ControllerLogger }
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
      void fireNtfy({
        interaction,
        connectorDisplayName: notifyArgs.connectorDisplayName,
        runId,
        log: notifyArgs.log,
      });
    }
  });
}

export function __resetControllerInteractionStateForTests(): void {
  activeRunInteractions.clear();
  activeRuns.clear();
  activeRunPromises.clear();
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
  const browserSurfaceAllocator = opts.browserSurfaceAllocator;
  const browserSurfaceLeaseManager = opts.browserSurfaceLeaseManager;
  const browserSurfaceReadinessTimeoutMs = opts.browserSurfaceReadinessTimeoutMs;
  const browserSurfaceLeaseStore = opts.browserSurfaceLeaseStore;
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
      await clearPersistedActiveRun(row.connector_id, row.run_id);
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
    lease: BrowserSurfaceLease,
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

  async function persistBrowserSurfaceLeaseMutation(lease: BrowserSurfaceLease, surface?: BrowserSurface): Promise<void> {
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
    traceContext: SpineTraceContext,
  ): Promise<{ lease: BrowserSurfaceLease; surface?: BrowserSurface }> {
    await emitBrowserSurfaceLeaseEvent("run.browser_surface_starting", connectorId, runId, traceContext, lease);
    if (!browserSurfaceLeaseManager) {
      return { lease };
    }

    let current = lease;
    while (current.status === "starting_surface") {
      const allocator =
        browserSurfaceAllocator ??
        ({
          ensureSurface: async () => {
            throw new Error("browser surface allocator is not configured");
          },
          getSurfaceStatus: async () => null,
          stopSurface: async () => null,
          listSurfaces: async () => [],
        } satisfies BrowserSurfaceAllocator);
      const readyResult = await browserSurfaceLeaseManager.ensureStartingSurfaceReady({
        leaseId: current.lease_id,
        allocator,
        ...(browserSurfaceReadinessTimeoutMs !== undefined
          ? { readinessTimeoutMs: browserSurfaceReadinessTimeoutMs }
          : {}),
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
    lease: BrowserSurfaceLease,
  ): Promise<{ lease: BrowserSurfaceLease; surface?: BrowserSurface; reclaimed: boolean }> {
    if (!browserSurfaceLeaseManager || !browserSurfaceAllocator) {
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
      reclaimed.promoted.surface_id ? browserSurfaceLeaseManager.getSurface(reclaimed.promoted.surface_id) : undefined,
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
    void runNow(lease.connector_id, {
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
            deferredResult.lease,
          );
          await persistBrowserSurfaceLeaseMutation(deferredResult.lease, deferredResult.surface);
        } catch {}
      }
      if (deferredResult?.promoted) {
        await persistAndPromoteBrowserSurfaceLeases([deferredResult.promoted], `${reason} promotion failure`);
      }
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] browser-surface lease ${lease.lease_id} promotion failed after ${reason}: ${message}`);
    });
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
    reason: string,
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
      cancelResult.lease,
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
      "browser-surface timeout",
    );
    return deferred.map((lease) => projectBrowserSurfaceLease(lease));
  }

  async function cleanupIdleBrowserSurfaces(): Promise<BrowserSurfaceProjection[]> {
    if (!browserSurfaceLeaseManager || !browserSurfaceAllocator) {
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

  async function reconcileBrowserSurfaceLeasesAfterBoot(): Promise<void> {
    await startupControllerRunReconciliation;
    if (!browserSurfaceLeaseManager) {
      return;
    }
    const activeRunIds = new Set((await listPersistedActiveRuns()).map((row) => row.run_id));
    const reconciled = browserSurfaceLeaseManager.reconcileAfterRestart({ activeRunIds, promoteQueued: false });
    for (const lease of reconciled.released) {
      await emitBrowserSurfaceLeaseEvent(
        "run.browser_surface_released",
        lease.connector_id,
        lease.run_id,
        createTraceContext(),
        lease
      );
      await persistBrowserSurfaceLeaseMutation(lease, lease.surface_id ? browserSurfaceLeaseManager.getSurface(lease.surface_id) : undefined);
    }
    for (const lease of reconciled.expired) {
      await emitBrowserSurfaceLeaseEvent("run.browser_surface_expired", lease.connector_id, lease.run_id, createTraceContext(), lease);
      await persistBrowserSurfaceLeaseMutation(lease);
    }
    for (const lease of reconciled.deferred) {
      await emitBrowserSurfaceLeaseEvent("run.browser_surface_deferred", lease.connector_id, lease.run_id, createTraceContext(), lease);
      await persistBrowserSurfaceLeaseMutation(lease);
    }
    for (const lease of reconciled.surfaceFailed) {
      await emitBrowserSurfaceLeaseEvent("run.browser_surface_failed", lease.connector_id, lease.run_id, createTraceContext(), lease);
      await persistBrowserSurfaceLeaseMutation(lease, lease.surface_id ? browserSurfaceLeaseManager.getSurface(lease.surface_id) : undefined);
    }
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

  async function listSchedules(): Promise<ScheduleApi[]> {
    const schedules = await schedulerStore.listSchedules();
    const apis = await Promise.all(
      schedules.map(async (schedule) => {
        const policy = await getConnectorRefreshPolicy(schedule.connector_id);
        return scheduleToApi(schedule, getRuntimeProjection(schedule.connector_id, browserSurfaceLeaseManager), policy);
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
    return scheduleToApi(schedule, getRuntimeProjection(connectorId, browserSurfaceLeaseManager), policy);
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
    const schedule = scheduleToApi(
      await getScheduleRecord(connectorId),
      getRuntimeProjection(connectorId, browserSurfaceLeaseManager),
      policy
    );
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
    return scheduleToApi(
      await getScheduleRecord(connectorId),
      getRuntimeProjection(connectorId, browserSurfaceLeaseManager),
      policy
    );
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

    const manifest: ConnectorManifest | null | undefined =
      options.manifest ?? (await getConnectorManifest(connectorId));
    if (!manifest) {
      throw new ControllerError(`Unknown connector: ${connectorId}`, "not_found");
    }
    const managedBrowserSurfaceRun = browserSurfaceLeaseManager?.isManagedConnector(connectorId) ?? false;
    if (existing) {
      throw new ControllerError(`Connector already has an active run: ${existing.run_id}`, "run_already_active", {
        runId: existing.run_id,
      });
    }

    const connectorPath = await Promise.resolve(resolveConnectorPath(connectorId, manifest, options));
    if (!connectorPath) {
      throw new ControllerError(`No runnable connector implementation is available for ${connectorId}`, "not_found");
    }

    const traceContext =
      options.traceContext ??
      (options.scenarioId ? createTraceContext({ scenarioId: options.scenarioId }) : createTraceContext());
    const runId = options.runId || `run_${Date.now()}`;
    const startedAt = nowIso();
    let browserSurfaceLease: BrowserSurfaceLease | null = null;
    let browserSurfaceEnv: Record<string, string> | null = null;

    if (managedBrowserSurfaceRun && browserSurfaceLeaseManager) {
      const profileKey = readBrowserSurfaceProfileKey(connectorId, manifest);
      const priorityClass = options.priorityClass ?? "owner_interactive";
      const leaseResult = browserSurfaceLeaseManager.acquire({
        connectorId,
        runId,
        profileKey,
        priorityClass,
      });
      browserSurfaceLease = leaseResult.lease;
      await persistBrowserSurfaceLeaseMutation(leaseResult.lease, leaseResult.surface);
      if (leaseResult.duplicateOf && leaseResult.lease.run_id !== runId) {
        throw new ControllerError(
          `Connector already has a pending browser-surface run: ${leaseResult.lease.run_id}`,
          "run_browser_surface_queued",
          { runId: leaseResult.lease.run_id }
        );
      }
      await emitBrowserSurfaceLeaseEvent("run.browser_surface_requested", connectorId, runId, traceContext, leaseResult.lease);

      if (leaseResult.lease.status === "waiting_for_browser_surface") {
        const reclaimedResult = await reclaimCapacityAndPromoteLease(leaseResult.lease);
        if (reclaimedResult.lease.run_id === runId && reclaimedResult.lease.status !== "waiting_for_browser_surface") {
          browserSurfaceLease = reclaimedResult.lease;
          if (reclaimedResult.lease.status === "starting_surface") {
            const readyResult = await waitForStartingBrowserSurface(reclaimedResult.lease, connectorId, runId, traceContext);
            browserSurfaceLease = readyResult.lease;
            if (readyResult.lease.status === "surface_failed") {
              pendingBrowserSurfaceLaunches.delete(runId);
              await emitBrowserSurfaceLeaseEvent("run.browser_surface_failed", connectorId, runId, traceContext, readyResult.lease);
              return {
                run_id: runId,
                trace_id: traceContext.trace_id,
                status: readyResult.lease.status,
                browser_surface: projectBrowserSurfaceLease(readyResult.lease),
              };
            }
            const readySurface = readyResult.surface ?? (
              readyResult.lease.surface_id ? browserSurfaceLeaseManager.getSurface(readyResult.lease.surface_id) : undefined
            );
            if (readyResult.lease.status === "leased" && readySurface) {
              pendingBrowserSurfaceLaunches.delete(readyResult.lease.run_id);
              await emitBrowserSurfaceLeaseEvent("run.browser_surface_leased", connectorId, runId, traceContext, readyResult.lease);
              browserSurfaceEnv = browserSurfaceLeaseEnv(readyResult.lease, readySurface);
            } else {
              await emitBrowserSurfaceLeaseEvent("run.browser_surface_deferred", connectorId, runId, traceContext, readyResult.lease);
              return {
                run_id: runId,
                trace_id: traceContext.trace_id,
                status: "deferred",
                browser_surface: projectBrowserSurfaceLease(readyResult.lease),
              };
            }
          } else if (reclaimedResult.lease.status === "leased" && reclaimedResult.surface) {
            pendingBrowserSurfaceLaunches.delete(reclaimedResult.lease.run_id);
            await emitBrowserSurfaceLeaseEvent("run.browser_surface_starting", connectorId, runId, traceContext, reclaimedResult.lease);
            await emitBrowserSurfaceLeaseEvent("run.browser_surface_leased", connectorId, runId, traceContext, reclaimedResult.lease);
            browserSurfaceEnv = browserSurfaceLeaseEnv(reclaimedResult.lease, reclaimedResult.surface);
          }
        }
      }

      browserSurfaceLease = browserSurfaceLeaseManager.getLease(browserSurfaceLease?.lease_id ?? "") ?? browserSurfaceLease;

      if (browserSurfaceLease?.status === "waiting_for_browser_surface") {
        pendingBrowserSurfaceLaunches.set(runId, {
          manifest,
          priorityClass,
          runId,
          traceContext,
          ...(options.ownerToken ? { ownerToken: options.ownerToken } : {}),
          ...(options.rsUrl ? { rsUrl: options.rsUrl } : {}),
        });
        await emitBrowserSurfaceLeaseEvent("run.browser_surface_queued", connectorId, runId, traceContext, browserSurfaceLease);
        return {
          run_id: runId,
          trace_id: traceContext.trace_id,
          status: browserSurfaceLease.status,
          browser_surface: projectBrowserSurfaceLease(browserSurfaceLease),
        };
      }

      if (browserSurfaceEnv) {
        // Capacity-pressure reclaim may have already promoted and readied this lease.
      } else if (browserSurfaceLease?.status === "deferred") {
        pendingBrowserSurfaceLaunches.delete(runId);
        await emitBrowserSurfaceLeaseEvent("run.browser_surface_deferred", connectorId, runId, traceContext, browserSurfaceLease);
        return {
          run_id: runId,
          trace_id: traceContext.trace_id,
          status: browserSurfaceLease.status,
          browser_surface: projectBrowserSurfaceLease(browserSurfaceLease),
        };
      } else if (browserSurfaceLease?.status === "starting_surface") {
        const readyResult = await waitForStartingBrowserSurface(browserSurfaceLease, connectorId, runId, traceContext);
        browserSurfaceLease = readyResult.lease;
        if (readyResult.lease.status === "surface_failed") {
          pendingBrowserSurfaceLaunches.delete(runId);
          await emitBrowserSurfaceLeaseEvent("run.browser_surface_failed", connectorId, runId, traceContext, readyResult.lease);
          return {
            run_id: runId,
            trace_id: traceContext.trace_id,
            status: readyResult.lease.status,
            browser_surface: projectBrowserSurfaceLease(readyResult.lease),
          };
        }
        if (readyResult.lease.status === "leased" && readyResult.surface) {
          pendingBrowserSurfaceLaunches.delete(readyResult.lease.run_id);
          await emitBrowserSurfaceLeaseEvent("run.browser_surface_leased", connectorId, runId, traceContext, readyResult.lease);
          browserSurfaceEnv = browserSurfaceLeaseEnv(readyResult.lease, readyResult.surface);
        } else {
          await emitBrowserSurfaceLeaseEvent("run.browser_surface_deferred", connectorId, runId, traceContext, readyResult.lease);
          return {
            run_id: runId,
            trace_id: traceContext.trace_id,
            status: "deferred",
            browser_surface: projectBrowserSurfaceLease(readyResult.lease),
          };
        }
      } else if (browserSurfaceLease?.status === "leased" && browserSurfaceLease.surface_id) {
        const leasedSurface = browserSurfaceLeaseManager.getSurface(browserSurfaceLease.surface_id);
        if (!leasedSurface) {
          await emitBrowserSurfaceLeaseEvent("run.browser_surface_deferred", connectorId, runId, traceContext, browserSurfaceLease);
          return {
            run_id: runId,
            trace_id: traceContext.trace_id,
            status: "deferred",
            browser_surface: projectBrowserSurfaceLease(browserSurfaceLease),
          };
        }
        pendingBrowserSurfaceLaunches.delete(browserSurfaceLease.run_id);
        await emitBrowserSurfaceLeaseEvent("run.browser_surface_starting", connectorId, runId, traceContext, browserSurfaceLease);
        await emitBrowserSurfaceLeaseEvent("run.browser_surface_leased", connectorId, runId, traceContext, browserSurfaceLease);
        browserSurfaceEnv = browserSurfaceLeaseEnv(browserSurfaceLease, leasedSurface);
      } else {
        const terminalLease = browserSurfaceLease ?? leaseResult.lease;
        await emitBrowserSurfaceLeaseEvent("run.browser_surface_deferred", connectorId, runId, traceContext, terminalLease);
        return {
          run_id: runId,
          trace_id: traceContext.trace_id,
          status: "deferred",
          browser_surface: projectBrowserSurfaceLease(terminalLease),
        };
      }
    }

    const syncState = (await getSyncState(connectorId)) as { state?: unknown } | null;
    const rawState = syncState?.state;
    const state: Record<string, unknown> | null =
      rawState && typeof rawState === "object" && !Array.isArray(rawState) && Object.keys(rawState).length
        ? (rawState as Record<string, unknown>)
        : null;
    const collectionMode: "full_refresh" | "incremental" = state ? "incremental" : "full_refresh";
    const ownerToken = options.ownerToken || (await issueRuntimeOwnerToken());

    // Manual run initiated by the owner: clear any pending human-attention flag
    // so the scheduler can resume automatic runs after this interaction resolves.
    needsHumanAttention.delete(connectorId);

    let streamingNonce: string | null = null;
    try {
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
      activeRunTraceContexts.set(runId, traceContext);
      activeRunInteractions.set(runId, {
        connector_id: connectorId,
        pending: null,
      });

      // Mode-A streaming-target registration: mint a per-run shared secret
      // before spawning the connector child. The hook stores its hash; the
      // raw nonce flows to the child via env (see runConnector below) and
      // is presented as a Bearer credential when the child registers its
      // CDP page-target wsUrl. 32 bytes of CSPRNG entropy yields a 64-char
      // hex token — enough that brute force across the run's lifetime is
      // not a credible threat. Hooks may be unset (older deployments,
      // tests that don't exercise streaming); when unset, no nonce is
      // minted, the env vars are not threaded, and Mode-A streaming
      // gracefully no-ops.
      streamingNonce = opts.streamingTargetNonceHooks ? randomBytes(32).toString("hex") : null;
      if (streamingNonce && opts.streamingTargetNonceHooks) {
        try {
          opts.streamingTargetNonceHooks.registerNonce({ runId, nonce: streamingNonce });
        } catch (err) {
          // Don't fail the run if the registry rejects (e.g. duplicate runId).
          // Streaming will simply be unavailable for this run.
          const message = err instanceof Error ? err.message : String(err);
          log.warn?.(`[controller] streaming nonce register failed for ${runId}: ${message}`);
        }
      }
    } catch (err) {
      if (browserSurfaceLease) {
        await releaseBrowserSurfaceLease(browserSurfaceLease, connectorId, runId, traceContext, "pre-spawn failure");
      }
      throw err;
    }

    const connectorDisplayName = readManifestDisplayName(manifest) ?? connectorId;
    const interactionHandler = (interaction: unknown) =>
      brokerInteraction(runId, connectorId, interaction as RuntimeInteraction, {
        connectorDisplayName,
        log,
      });

    // runNow returns the run handle immediately; the actual connector
    // execution resolves later and clears activeRuns in the finally.
    // Callers poll the projection via getActiveRun / listSchedules.
    //
    // The Promise itself is tracked in `activeRunPromises` so the
    // graceful-shutdown path (`drainActiveRuns`) can await in-flight
    // children before the parent process exits — critical for
    // Chromium release() to complete and prevent stale singleton-lock
    // files (see polyfill-connectors/src/profile-lock.ts).
    const runPromise = Promise.resolve()
      .then(() =>
        runConnectorImpl({
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
          // Mode-A streaming registration env. Both fields must be present for
          // runConnector to thread them into the spawn env; either omitted is
          // a graceful no-op.
          streamingRegistrationToken: streamingNonce,
          referenceBaseUrl: currentReferenceBaseUrl(),
          browserSurfaceEnv,
        })
      )
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error?.(`[controller] manual run failed for ${connectorId}: ${message}`);
      })
      .finally(async () => {
        activeRuns.delete(connectorId);
        activeRunPromises.delete(runId);
        activeRunTraceContexts.delete(runId);
        clearPersistedActiveRun(connectorId, runId).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          log.warn?.(`[controller] failed to clear active run ${runId} for ${connectorId}: ${message}`);
        });
        // Clear the per-run streaming nonce. Idempotent at the registry
        // level, so the conditional here is just to avoid a needless call
        // when streaming hooks weren't wired up at all.
        if (opts.streamingTargetNonceHooks) {
          try {
            opts.streamingTargetNonceHooks.clearNonce({ runId });
          } catch {
            /* registry shutdown raced run end — safe to ignore */
          }
        }
        if (browserSurfaceLease) {
          try {
            await releaseBrowserSurfaceLease(browserSurfaceLease, connectorId, runId, traceContext, `${runId} release`);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warn?.(`[controller] failed to persist browser-surface lease release for ${runId}: ${message}`);
          }
        }
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
    activeRunPromises.set(runId, runPromise);

    return { run_id: runId, trace_id: traceContext.trace_id, status: "started" };
  }

  // ─── Graceful-shutdown drain ────────────────────────────────────────────
  //
  // Await all in-flight run promises with a hard deadline. The parent's
  // SIGTERM handler in server/index.js calls this before process.exit.
  // Returns the count drained, the count timed out, and elapsed wall-clock
  // time so the caller can log a useful summary.
  async function drainActiveRuns(timeoutMs: number): Promise<DrainSummary> {
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
