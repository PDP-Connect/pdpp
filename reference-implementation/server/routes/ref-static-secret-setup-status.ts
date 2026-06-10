// Reference-only owner-session static-secret SETUP-STATUS read.
//
// A static-secret connection is born as an invisible `draft` connector instance
// that every connection read surface hides until first ingest flips it to
// `active` (add-static-secret-owner-session-connect-path Decision 1/2). That
// invisibility is correct for the connection surfaces, but it left the owner
// with no durable view of an in-flight setup after submit — the "invisible draft
// black hole" the owner-journey realignment plan Phase 2 / design Decision 12
// calls out.
//
// This route is the durable, owner-session-only read that makes pending setup
// visible. It resolves the draft (or freshly-active) connection by
// connector_instance_id, reads the non-secret credential metadata and the
// current/last run, and projects them through the pure
// `projectStaticSecretSetupStatus` module. It introduces NO new durable storage
// and NO parallel onboarding enum: the owner-facing `setup_state` projects onto
// the canonical `ConnectionHealthState` taxonomy.
//
// It is NOT an owner-agent bearer route: `requireOwnerSession` (cookie) gates it.
// It never accepts or returns a provider secret, owner/browser cookie, or
// grant-scoped bearer.

import { projectStaticSecretSetupStatus, type SetupStatusRun } from "../../runtime/static-secret-setup-status.ts";
import { type ConnectorManifestLike, staticSecretCredentialCaptureFromManifest } from "../connection-setup-plan.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

interface RouteRequest {
  ownerSession?: { readonly sub?: string | null } | null;
  readonly params: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, unknown>>;
}

interface RouteResponse {
  json(body: unknown): unknown;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
}

interface ConnectorInstanceRow {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly createdAt?: string | null;
  readonly displayName?: string | null;
  readonly sourceBinding?: unknown;
  readonly status: string;
  readonly updatedAt?: string | null;
}

interface ConnectorInstanceStore {
  get(connectorInstanceId: string): Promise<ConnectorInstanceRow | null> | ConnectorInstanceRow | null;
  getActiveRun(
    connectorInstanceId: string
  ):
    | Promise<{ runId: string; connectorId: string; startedAt: string } | null>
    | { runId: string; connectorId: string; startedAt: string }
    | null;
}

interface CredentialMetadata {
  readonly capturedAt?: string | null;
  readonly credentialKind?: string | null;
  readonly present?: boolean;
}

interface ConnectorInstanceCredentialStore {
  getMetadata(connectorInstanceId: string): Promise<CredentialMetadata | null> | CredentialMetadata | null;
}

interface ConnectorNamespace {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
}

export interface MountRefStaticSecretSetupStatusContext {
  canonicalConnectorKey(value: string | null | undefined): string | null;
  createRequestConnectorInstanceCredentialStore(): ConnectorInstanceCredentialStore;
  createRequestConnectorInstanceStore(): ConnectorInstanceStore;
  getOwnerSubjectId(req: unknown): string;
  // Window-independent terminal status for a run by run_id: "failed" |
  // "completed" | "cancelled" | "abandoned" | null (still running / unknown).
  getRunTerminalStatus(runId: string): Promise<string | null>;
  handleError(res: unknown, err: unknown): void;
  pdppError: PdppErrorFn;
  requireOwnerSession: MiddlewareHandler;
  resolveOwnerConnectorNamespace(
    req: unknown,
    connectorId: string | null,
    options?: {
      readonly allowDefaultAccount?: boolean;
      readonly allowStatuses?: readonly string[];
      readonly connectorInstanceId?: string | null;
      readonly ownerSubjectId?: string;
    }
  ): Promise<ConnectorNamespace>;
  resolveRegisteredConnectorManifest(connectorId: string): Promise<ConnectorManifestLike>;
}

// The non-secret manifest setup field flagged `identity: true` names the account
// label (e.g. mailbox) the owner typed at draft creation. Used only to read the
// stored non-secret identity value; it never touches the secret field.
function identityFieldName(manifest: ConnectorManifestLike): string | null {
  const capture = staticSecretCredentialCaptureFromManifest(manifest);
  if (!capture) {
    return null;
  }
  const field = capture.fields.find((candidate) => candidate.identity && !candidate.secret);
  return field?.name ?? null;
}

// Pull the non-secret setup fields out of the draft's source binding. The draft
// binding is `{ kind: "static_secret_draft", setup_fields: {...} }`; only the
// non-secret fields are ever stored there (the secret goes to the credential
// store), so this is safe to surface.
function setupFieldsFromBinding(sourceBinding: unknown): Record<string, unknown> | null {
  if (!sourceBinding || typeof sourceBinding !== "object" || Array.isArray(sourceBinding)) {
    return null;
  }
  const fields = (sourceBinding as { setup_fields?: unknown }).setup_fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return null;
  }
  return fields as Record<string, unknown>;
}

const TERMINAL_FAILURE = new Set(["failed", "cancelled", "abandoned"]);

// Resolve the run evidence for the setup-status projection.
//   - an in-flight run is the active-run row keyed on connector_instance_id;
//   - otherwise, if a run id is known (in-flight earlier, or supplied by the
//     owner surface that started the run), its terminal status answers whether
//     the first sync failed.
async function resolveRunEvidence(
  ctx: MountRefStaticSecretSetupStatusContext,
  store: ConnectorInstanceStore,
  connectorInstanceId: string,
  requestedRunId: string | null
): Promise<{ activeRun: SetupStatusRun | null; lastRun: SetupStatusRun | null }> {
  const active = await store.getActiveRun(connectorInstanceId);
  if (active) {
    return {
      activeRun: { runId: active.runId, status: "in_progress", startedAt: active.startedAt },
      lastRun: null,
    };
  }
  if (!requestedRunId) {
    return { activeRun: null, lastRun: null };
  }
  const terminal = await ctx.getRunTerminalStatus(requestedRunId);
  if (!terminal) {
    return { activeRun: null, lastRun: null };
  }
  const failed = TERMINAL_FAILURE.has(terminal);
  return {
    activeRun: null,
    lastRun: {
      runId: requestedRunId,
      status: failed ? "failed" : terminal,
      failureReason: failed ? terminal : null,
    },
  };
}

function firstQueryValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return null;
}

// GET /_ref/connections/:connectorInstanceId/setup-status
//
// Owner-session-only. Projects the visible setup lifecycle for one static-secret
// connection (draft or active). No secret is accepted or returned.
export function mountRefStaticSecretSetupStatus(app: AppLike, ctx: MountRefStaticSecretSetupStatusContext): void {
  app.get(
    "/_ref/connections/:connectorInstanceId/setup-status",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const connectorInstanceId = decodeURIComponent(req.params.connectorInstanceId as string);
      try {
        const ownerSubjectId = ctx.getOwnerSubjectId(req);
        // Resolve the connection allowing `draft` so a not-yet-ingested setup is
        // visible to the owner; ownership is verified by the resolver. A foreign
        // or unknown id surfaces as connector_instance_not_found (404).
        const namespace = await ctx.resolveOwnerConnectorNamespace(req, null, {
          ownerSubjectId,
          allowDefaultAccount: false,
          allowStatuses: ["active", "draft", "paused", "revoked"],
          connectorInstanceId,
        });
        const store = ctx.createRequestConnectorInstanceStore();
        const instance = await store.get(namespace.connectorInstanceId);
        if (!instance) {
          ctx.pdppError(
            res,
            404,
            "connector_instance_not_found",
            `Connection '${connectorInstanceId}' does not exist.`
          );
          return;
        }
        const manifest = await ctx.resolveRegisteredConnectorManifest(instance.connectorId);
        const credentialStore = ctx.createRequestConnectorInstanceCredentialStore();
        const credentialMeta = await credentialStore.getMetadata(namespace.connectorInstanceId);
        const requestedRunId = firstQueryValue(req.query?.run_id);
        const { activeRun, lastRun } = await resolveRunEvidence(
          ctx,
          store,
          namespace.connectorInstanceId,
          requestedRunId
        );

        const status = projectStaticSecretSetupStatus({
          instance: {
            connectorInstanceId: instance.connectorInstanceId,
            connectorId: ctx.canonicalConnectorKey(instance.connectorId) ?? instance.connectorId,
            displayName: instance.displayName ?? null,
            status: instance.status,
            createdAt: instance.createdAt ?? null,
            updatedAt: instance.updatedAt ?? null,
            setupFields: setupFieldsFromBinding(instance.sourceBinding),
          },
          credential: credentialMeta
            ? {
                present: credentialMeta.present === true,
                credentialKind: credentialMeta.credentialKind ?? null,
                capturedAt: credentialMeta.capturedAt ?? null,
              }
            : null,
          activeRun,
          lastRun,
          identityFieldName: identityFieldName(manifest),
        });

        res.status(200).json(status);
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}
