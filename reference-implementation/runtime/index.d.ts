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

export interface RuntimeRunConnectorOptions {
  collectionMode?: RuntimeCollectionMode;
  connectorId: string;
  connectorPath: string;
  grantId?: string | null;
  manifest: Record<string, unknown>;
  onInteraction?: (...args: unknown[]) => unknown;
  onProgress?: (message: unknown) => void;
  onStarted?: ((info: unknown) => void) | null;
  ownerToken: string;
  persistState?: boolean;
  rsUrl?: string;
  scope?: Record<string, unknown> | null;
  state?: Record<string, unknown> | null;
}

export interface RuntimeRunConnectorResult {
  checkpoint_summary?: Record<string, unknown> | null;
  connector_error?: { message?: string; retryable?: boolean | null } | null;
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
