/**
 * Ambient declarations for the runtime entrypoint. `runtime/index.js` is
 * still JS and will migrate to TS in a later slice (tranche 3/4). Until
 * then, consuming TS modules (scheduler, controller) need an explicit
 * `runConnector` signature — TypeScript infers the JS destructuring too
 * loosely for the cross-module boundary.
 *
 * Keep in lockstep with runtime/index.js until that migration lands.
 */

export type RuntimeCollectionMode = "full_refresh" | "incremental";

export interface RuntimeTraceContext {
  readonly request_id: string;
  readonly scenario_id: string;
  readonly trace_id: string;
}

export interface RuntimeBrowserSurfaceLease {
  readonly browserSurfaceRequired?: string | null;
  readonly cdpUrl?: string | null;
  readonly id?: string | null;
  readonly leaseId?: string | null;
  readonly profileKey?: string | null;
  readonly remoteCdpUrl?: string | null;
  readonly required?: string | null;
  readonly streamBaseUrl?: string | null;
  readonly surfaceId?: string | null;
}

export interface RuntimeBrowserSurfaceEnv {
  readonly PDPP_BROWSER_SURFACE_ID?: string | null;
  readonly PDPP_BROWSER_SURFACE_LEASE_ID?: string | null;
  readonly PDPP_BROWSER_SURFACE_PROFILE_KEY?: string | null;
  readonly PDPP_BROWSER_SURFACE_REMOTE_CDP_URL?: string | null;
  readonly PDPP_BROWSER_SURFACE_REQUIRED?: string | null;
  readonly PDPP_BROWSER_SURFACE_STREAM_BASE_URL?: string | null;
}

export interface RuntimeRunConnectorOptions {
  /**
   * Managed browser-surface lease selected by the controller. When present
   * with a CDP URL, `runConnector` forwards the lease-scoped
   * `PDPP_BROWSER_SURFACE_*` env block to the connector child.
   */
  browserSurfaceLease?: RuntimeBrowserSurfaceLease | null;
  /**
   * Explicit browser-surface child env override for tests and integration
   * seams. Values here win over `browserSurfaceLease` fields.
   */
  browserSurfaceEnv?: RuntimeBrowserSurfaceEnv | null;
  collectionMode?: RuntimeCollectionMode;
  connectorId: string;
  connectorPath: string;
  grantId?: string | null;
  manifest: Record<string, unknown>;
  onInteraction?: (...args: unknown[]) => unknown;
  onProgress?: (message: unknown) => void;
  onStarted?: ((info: { run_id: string; trace_id: string }) => void) | null;
  ownerToken: string;
  persistState?: boolean;
  /**
   * Mode-A streaming-target registration: AS base URL the spawned
   * connector child should POST to. Forwarded as
   * `PDPP_REFERENCE_BASE_URL`. Both `referenceBaseUrl` and
   * `streamingRegistrationToken` are required for the spawn env block to
   * include the streaming registration vars; either omitted is a
   * graceful no-op.
   */
  referenceBaseUrl?: string | null;
  rsUrl?: string;
  runId?: string;
  scenarioId?: string;
  scope?: Record<string, unknown> | null;
  state?: Record<string, unknown> | null;
  /**
   * Mode-A streaming-target registration: per-run shared secret minted
   * by the controller. Forwarded as
   * `PDPP_STREAMING_REGISTRATION_TOKEN`. The child sends it as a Bearer
   * credential when it registers its CDP page-target wsUrl. Hashed at
   * the registry; never logged.
   */
  streamingRegistrationToken?: string | null;
  traceContext?: RuntimeTraceContext;
}

/**
 * Bounded, redacted excerpt of connector-authored stderr captured for
 * connector exits before DONE. See
 * openspec/changes/persist-connector-failure-diagnostics.
 *
 * The text is connector-authored and untrusted — owner UI MUST label it
 * as such and SHOULD render it as a collapsed/preformatted diagnostic
 * panel rather than presenting it as a runtime-verified PDPP error.
 */
export interface ConnectorStderrTailDiagnostic {
  readonly bytes_captured: number;
  readonly bytes_observed: number;
  readonly encoding: "utf-8";
  readonly object: "connector_stderr_tail";
  readonly redacted: boolean;
  readonly text: string;
  readonly truncated: boolean;
}

export interface ConnectorRunDiagnostics {
  readonly stderr_tail?: ConnectorStderrTailDiagnostic;
}

export type RuntimeFailureOrigin = "connector" | "runtime" | "transport" | "storage";

export interface RuntimeRunConnectorResult {
  checkpoint_summary?: Record<string, unknown> | null;
  connector_diagnostics?: ConnectorRunDiagnostics;
  connector_error?: { message?: string; retryable?: boolean | null } | null;
  failure_message?: string;
  failure_origin?: RuntimeFailureOrigin;
  known_gaps?: Record<string, unknown>[] | null;
  message?: string;
  records_emitted?: number;
  reported_records_emitted?: number | null;
  run_id?: string | null;
  state?: unknown;
  status: "failed" | "skipped" | "succeeded";
  terminal_reason?: string | null;
  trace_id?: string | null;
}

export function runConnector(opts: RuntimeRunConnectorOptions): Promise<RuntimeRunConnectorResult>;
