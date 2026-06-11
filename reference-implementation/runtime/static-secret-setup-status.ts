/**
 * Connection setup-status projection.
 *
 * A static-secret connection is born as an invisible `draft` connector instance
 * (see add-static-secret-owner-session-connect-path Decision 1): a real row
 * excluded from every connection read surface until its first successful ingest
 * flips it to `active`. That invisibility is correct for the *connection* read
 * surfaces — a not-yet-ingested draft is not a working connection — but it left
 * the owner with no durable view of an in-flight setup after submit (the
 * "invisible draft black hole" in the owner-journey realignment plan, Phase 2 /
 * design Decision 12).
 *
 * This module is the pure projection that turns the durable state a draft (or
 * freshly-activated) connection already carries into one owner-facing
 * setup-lifecycle view. It introduces NO new durable storage and NO parallel
 * onboarding enum: `setup_state` is projected onto the canonical
 * `ConnectionHealthState` taxonomy the rest of the dashboard already uses, so a
 * setup card and a Sources card cannot drift.
 *
 * The function is pure: no I/O, no clock reads. The caller (the owner-session
 * setup-status route) collects the durable evidence and passes it in. The output
 * carries only non-secret identifiers and metadata — never a provider secret,
 * uploaded artifact contents, owner/browser cookie, or grant-scoped bearer.
 */

import type { ConnectionHealthState } from "./connection-health.ts";

// Owner-facing setup lifecycle states. Each maps 1:1 onto a canonical
// `ConnectionHealthState` (see `SETUP_STATE_HEALTH` below) so the dashboard can
// reuse its existing pill vocabulary instead of inventing a setup-only pill.
//
//   awaiting_credential  draft, no credential captured yet        -> idle
//   first_sync_running   credential captured, a run is in flight  -> idle (+ syncing activity)
//   first_sync_pending   credential captured, no run yet / queued -> idle
//   first_sync_failed    last run failed, still a draft           -> needs_attention
//   active               first ingest accepted records           -> healthy
//   paused               owner-paused connection                  -> idle
//   revoked              owner-revoked connection                 -> idle
//
// `unknown` is the honest fallback for any instance status the lifecycle does
// not model.
export type StaticSecretSetupState =
  | "active"
  | "awaiting_credential"
  | "first_sync_failed"
  | "first_sync_pending"
  | "first_sync_running"
  | "paused"
  | "revoked"
  | "unknown";

const SETUP_STATE_HEALTH: Record<StaticSecretSetupState, ConnectionHealthState> = {
  active: "healthy",
  awaiting_credential: "idle",
  first_sync_failed: "needs_attention",
  first_sync_pending: "idle",
  first_sync_running: "idle",
  paused: "idle",
  revoked: "idle",
  unknown: "unknown",
};

// A non-secret view of the connection's credential. Mirrors the metadata the
// owner-session capture route already returns; never carries the secret itself.
export interface SetupStatusCredentialMetadata {
  readonly capturedAt?: string | null;
  readonly credentialKind?: string | null;
  readonly present: boolean;
}

export type ConnectionSetupKind = "manual_upload" | "static_secret" | "unknown";

export interface SetupStatusMaterialMetadata {
  readonly capturedAt?: string | null;
  readonly kind: ConnectionSetupKind;
  readonly label: string;
  readonly present: boolean;
}

// A non-secret view of a run. `status` is the spine run status
// (started/in_progress/succeeded/failed/...). `failureReason` is the terminal
// failure reason when the run failed.
export interface SetupStatusRun {
  readonly failureReason?: string | null;
  readonly finishedAt?: string | null;
  readonly runId: string | null;
  readonly startedAt?: string | null;
  readonly status: string | null;
}

export interface SetupStatusInstance {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly createdAt: string | null;
  readonly displayName: string | null;
  // The non-secret setup fields captured at draft creation (e.g. account email).
  // Used only to surface the account identity; never carries the secret field.
  readonly setupFields?: Readonly<Record<string, unknown>> | null;
  // `draft` | `active` | `paused` | `revoked`.
  readonly status: string;
  readonly updatedAt: string | null;
}

export interface ProjectConnectionSetupStatusInput {
  // The currently in-flight run for this connection, if any
  // (`controller_active_runs` keyed on connector_instance_id).
  readonly activeRun: SetupStatusRun | null;
  readonly credential: SetupStatusCredentialMetadata | null;
  // The identity field name (a non-secret manifest setup field marked
  // `identity: true`), used to pull the account label out of `setupFields`.
  readonly identityFieldName?: string | null;
  readonly instance: SetupStatusInstance;
  // The most recent run for this connection (terminal or otherwise), if known.
  // Used to surface a failed first sync after the run leaves the active table.
  readonly lastRun: SetupStatusRun | null;
  readonly setupKind?: ConnectionSetupKind;
  readonly setupMaterial?: SetupStatusMaterialMetadata | null;
}

export interface ConnectionSetupStatus {
  // The owner-entered account identity (e.g. mailbox), when known. Non-secret.
  readonly account_identity: string | null;
  readonly connection_id: string;
  readonly connector_id: string;
  readonly created_at: string | null;
  // Back-compat static-secret metadata. Manual/upload setup surfaces should use
  // `setup_material`; this remains for existing callers that still show the
  // credential lifecycle.
  readonly credential: {
    readonly present: boolean;
    readonly credential_kind: string | null;
    readonly captured_at: string | null;
  };
  readonly display_name: string | null;
  // The canonical health state this setup_state projects onto.
  readonly health_state: ConnectionHealthState;
  // The actionable failure + remediation when the first sync failed. Non-secret.
  readonly last_error: {
    readonly reason: string;
    readonly remediation: string;
  } | null;
  readonly object: "connection_setup_status";
  // True while the connection is not yet a working connection (draft) and the
  // owner still has a setup action to complete or await.
  readonly pending: boolean;
  // The current/last run, for the owner to follow progress or read a failure.
  readonly run: {
    readonly run_id: string | null;
    readonly status: string | null;
    readonly started_at: string | null;
    readonly finished_at: string | null;
  } | null;
  // True while a first sync run is in flight.
  readonly running: boolean;
  readonly setup_kind: ConnectionSetupKind;
  readonly setup_material: {
    readonly captured_at: string | null;
    readonly kind: ConnectionSetupKind;
    readonly label: string;
    readonly present: boolean;
  };
  // The owner-facing setup lifecycle label.
  readonly setup_state: StaticSecretSetupState;
  // The real connector-instance status (draft/active/paused/revoked).
  readonly status: string;
  readonly updated_at: string | null;
}

const TERMINAL_FAILURE_STATUSES = new Set(["failed", "errored", "error", "cancelled", "canceled", "aborted"]);
const RUNNING_STATUSES = new Set(["started", "in_progress", "running", "pending"]);

function runIsFailure(run: SetupStatusRun | null): boolean {
  return run != null && typeof run.status === "string" && TERMINAL_FAILURE_STATUSES.has(run.status);
}

function runIsRunning(run: SetupStatusRun | null): boolean {
  return run != null && typeof run.status === "string" && RUNNING_STATUSES.has(run.status);
}

export type ProjectStaticSecretSetupStatusInput = ProjectConnectionSetupStatusInput;
export type StaticSecretSetupStatus = ConnectionSetupStatus;

function accountIdentity(input: ProjectConnectionSetupStatusInput): string | null {
  const fields = input.instance.setupFields;
  const name = input.identityFieldName;
  if (!(fields && name)) {
    return null;
  }
  const value = fields[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Failure remediation copy is owner-safe and operator-voiced: it names the
// recovery step for a failed first sync without leaking the secret or the
// provider error verbatim.
function remediationForReason(reason: string, setupKind: ConnectionSetupKind): string {
  if (setupKind === "manual_upload") {
    return "Choose a valid import file and start the first import again.";
  }
  const lower = reason.toLowerCase();
  if (lower.includes("auth") || lower.includes("credential") || lower.includes("password") || lower.includes("login")) {
    return "Re-enter the provider credential and start the first sync again.";
  }
  return "Start the first sync again. If it keeps failing, re-enter the provider credential.";
}

function deriveSetupState(
  input: ProjectConnectionSetupStatusInput,
  hasSetupMaterial: boolean,
  running: boolean
): StaticSecretSetupState {
  const status = input.instance.status;
  if (status === "active") {
    return "active";
  }
  if (status === "paused") {
    return "paused";
  }
  if (status === "revoked") {
    return "revoked";
  }
  if (status !== "draft") {
    return "unknown";
  }
  // Draft lifecycle.
  if (!hasSetupMaterial) {
    return "awaiting_credential";
  }
  if (running) {
    return "first_sync_running";
  }
  // No in-flight run. A terminal failure on the last run is a failed first sync.
  if (runIsFailure(input.lastRun)) {
    return "first_sync_failed";
  }
  // Credential captured, run queued or just-submitted but not yet running and
  // not yet failed: the first sync is pending.
  return "first_sync_pending";
}

function defaultSetupMaterial(
  setupKind: ConnectionSetupKind,
  credential: SetupStatusCredentialMetadata | null
): SetupStatusMaterialMetadata {
  if (setupKind === "manual_upload") {
    return { kind: "manual_upload", label: "Import file", present: true, capturedAt: null };
  }
  if (setupKind === "static_secret") {
    return {
      kind: "static_secret",
      label: "Provider credential",
      present: credential?.present === true,
      capturedAt: credential?.capturedAt ?? null,
    };
  }
  return { kind: "unknown", label: "Setup material", present: false, capturedAt: null };
}

export function projectConnectionSetupStatus(input: ProjectConnectionSetupStatusInput): ConnectionSetupStatus {
  const setupKind = input.setupKind ?? "static_secret";
  const material = input.setupMaterial ?? defaultSetupMaterial(setupKind, input.credential);
  const hasSetupMaterial = material.present === true;
  // A run is "running" when the active-run table holds it OR the last-run
  // summary still reports a non-terminal status (covers the window between
  // submit and the active-run row landing).
  const running = runIsRunning(input.activeRun) || (input.activeRun == null && runIsRunning(input.lastRun));
  const setupState = deriveSetupState(input, hasSetupMaterial, running);
  const run = input.activeRun ?? input.lastRun ?? null;

  const failed = setupState === "first_sync_failed";
  const failureReason =
    (failed ? (run?.failureReason ?? input.lastRun?.failureReason) : null) || (failed ? "first_sync_failed" : null);
  const lastError = failureReason
    ? { reason: failureReason, remediation: remediationForReason(failureReason, setupKind) }
    : null;

  return {
    object: "connection_setup_status",
    connection_id: input.instance.connectorInstanceId,
    connector_id: input.instance.connectorId,
    display_name: input.instance.displayName,
    account_identity: accountIdentity(input),
    status: input.instance.status,
    setup_state: setupState,
    setup_kind: setupKind,
    setup_material: {
      kind: material.kind,
      label: material.label,
      present: material.present,
      captured_at: material.capturedAt ?? null,
    },
    health_state: SETUP_STATE_HEALTH[setupState],
    pending: input.instance.status === "draft",
    running,
    credential: {
      present: input.credential?.present === true,
      credential_kind: input.credential?.credentialKind ?? null,
      captured_at: input.credential?.capturedAt ?? null,
    },
    run: run
      ? {
          run_id: run.runId,
          status: run.status,
          started_at: run.startedAt ?? null,
          finished_at: run.finishedAt ?? null,
        }
      : null,
    last_error: lastError,
    created_at: input.instance.createdAt,
    updated_at: input.instance.updatedAt,
  };
}

export function projectStaticSecretSetupStatus(input: ProjectStaticSecretSetupStatusInput): StaticSecretSetupStatus {
  return projectConnectionSetupStatus({ ...input, setupKind: input.setupKind ?? "static_secret" });
}
