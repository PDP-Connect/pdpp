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

export interface RuntimeRunConnectorOptions {
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
  rsUrl?: string;
  runId?: string;
  scenarioId?: string;
  scope?: Record<string, unknown> | null;
  state?: Record<string, unknown> | null;
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
