// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Owner-facing surface for a connection's attributed configuration-revision
// ledger:
//
//   GET  /v1/owner/connections/:connectionId/config            -> active revision
//   GET  /v1/owner/connections/:connectionId/config/revisions  -> full ledger
//   POST /v1/owner/connections/:connectionId/config/revisions  -> propose
//   POST /v1/owner/connections/:connectionId/config/revisions/:revision/confirm
//
// This is the HTTP half of `server/stores/connector-instance-config-store.ts`.
// The store's whole point is that "who chose that list?" is always answerable
// and that a well-typed agent write cannot pass as an owner choice; these
// routes must not undermine either property.
//
// The two decisions that carry the safety here:
//
// 1. `authenticatedOwnerSubjectId` comes from `getOwnerTokenSubjectId(req)` --
//    the authenticated bearer session -- and NEVER from the request body. A
//    body-supplied owner subject would make owner confirmation a forgeable
//    field, which is the exact attack the propose/confirm split exists to
//    stop: an agent holding the owner's token could then both propose a
//    collection-shaping revision and "confirm" it in one breath. The body is
//    not consulted for identity on the confirm path at all.
//
// 2. `origin` is derived from the token kind, not accepted from the body. A
//    caller cannot label its own write `owner` to look more authoritative.
//    Attribution describes who supplied a value; it never authorizes
//    activation (only `confirm` does), but a caller that could forge
//    attribution would defeat the ledger's purpose as an audit record.
//
// Conflict mapping: `ConfigStaleWriteError` becomes
// `connector_instance_config_stale_write` -> 409, matching how this codebase
// reports every other optimistic-concurrency / wrong-state conflict
// (`approval_conflict`, `interaction_id_mismatch`,
// `static_secret_identity_conflict` are all 409 in
// `routes/ref-error-status.ts`). The response carries the store's ACTUAL
// current revision/epoch so the caller can rebase explicitly rather than
// re-reading and racing again.

import type {
  ConfigOrigin,
  ConfigRevision,
  ConnectorInstanceConfigStore,
  CurrentPointer,
} from "../stores/connector-instance-config-store.ts";
import { ConfigStaleWriteError } from "../stores/connector-instance-config-store.ts";

interface RouteRequest {
  readonly body?: unknown;
  readonly params: Readonly<Record<string, string>>;
  readonly tokenInfo?: {
    readonly client_id?: string | null;
    readonly pdpp_token_kind?: string | null;
    readonly subject_id?: string | null;
  } | null;
}

interface RouteResponse {
  end: () => unknown;
  json: (body: unknown) => unknown;
  status: (code: number) => RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get: (path: string, ...args: unknown[]) => AppLike;
  post: (path: string, ...args: unknown[]) => AppLike;
}

export interface MountOwnerConnectionConfigContext {
  /** Resolves the AUTHENTICATED owner subject from the request. Never the body. */
  getOwnerTokenSubjectId: (req: unknown) => string;
  handleError: (res: unknown, err: unknown) => void;
  /** Run-clock, injected so handlers stay total and testable. */
  now?: () => Date;
  pdppError: (res: RouteResponse, status: number, code: string, message: string) => void;
  requireOwner: unknown;
  requireToken: unknown;
  resolveOwnerConnectorNamespace: (
    req: unknown,
    connectorId: string | null,
    options?: {
      readonly allowDefaultAccount?: boolean;
      readonly connectorInstanceId?: string | null;
      readonly ownerSubjectId?: string;
    }
  ) => Promise<{ connectorId: string; connectorInstanceId: string }>;
  store: ConnectorInstanceConfigStore;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Attribution derived from the authenticated token, never from the body.
 *
 * An owner-kind bearer records `owner`; anything else records `agent`. The
 * conservative direction matters: mislabelling an agent write as `owner`
 * would corrupt the audit answer to "who chose that list?", whereas
 * labelling an owner-driven console write `agent` only understates it. Note
 * that this choice does not affect what a run collects -- a collection_scope
 * revision stays `proposed` under EITHER origin.
 */
function originForToken(req: RouteRequest): ConfigOrigin {
  return req.tokenInfo?.pdpp_token_kind === "owner" ? "owner" : "agent";
}

function actorForToken(req: RouteRequest, ownerSubjectId: string): string {
  if (req.tokenInfo?.pdpp_token_kind === "owner") {
    return ownerSubjectId;
  }
  const clientId = req.tokenInfo?.client_id;
  return typeof clientId === "string" && clientId.trim() ? `client:${clientId.trim()}` : "agent";
}

function revisionForWire(revision: ConfigRevision): Record<string, unknown> {
  return {
    collection_boundary_fingerprint: revision.collectionBoundaryFingerprint,
    config: revision.config,
    config_contract_id: revision.configContractId,
    config_contract_version: revision.configContractVersion,
    confirmed_at: revision.confirmedAt,
    confirmed_by: revision.confirmedBy,
    connection_id: revision.connectorInstanceId,
    is_explicit: revision.isExplicit,
    object: "connector_config_revision",
    option_kind: revision.optionKind,
    origin: revision.origin,
    revision: revision.revision,
    set_at: revision.setAt,
    set_by: revision.setBy,
    source_of_change: revision.sourceOfChange,
    status: revision.status,
  };
}

function pointerForWire(pointer: CurrentPointer | null): Record<string, unknown> | null {
  return pointer
    ? {
        active_revision: pointer.activeRevision,
        storage_epoch: pointer.storageEpoch,
        updated_at: pointer.updatedAt,
      }
    : null;
}

interface ParsedProposal {
  readonly baseEpoch: number;
  readonly baseRevision: number;
  readonly boundaryFingerprint: string | null;
  readonly config: Record<string, unknown>;
  readonly sourceOfChange: string;
}

/**
 * Validate a proposal body.
 *
 * Rejects rather than defaults on `base_revision`/`base_epoch`: inventing a
 * base would turn an optimistic-concurrency check into last-write-wins, which
 * is precisely what the store refuses to do. A caller that does not know its
 * base must GET the active revision first.
 *
 * `source_of_change` is required for the same reason the store requires it --
 * a revision nobody can explain is an unattributed revision.
 */
function parseProposalBody(body: unknown): { error: string } | { proposal: ParsedProposal } {
  if (!isRecord(body)) {
    return { error: "body must be an object" };
  }
  if (!isRecord(body.config)) {
    return { error: "config must be an object" };
  }
  if (typeof body.base_revision !== "number" || !Number.isInteger(body.base_revision) || body.base_revision < 0) {
    return { error: "base_revision must be a non-negative integer (read it from GET .../config)" };
  }
  if (typeof body.base_epoch !== "number" || !Number.isInteger(body.base_epoch) || body.base_epoch < 1) {
    return { error: "base_epoch must be a positive integer (read it from GET .../config)" };
  }
  if (typeof body.source_of_change !== "string" || !body.source_of_change.trim()) {
    return { error: "source_of_change must be a non-empty string explaining why this configuration changed" };
  }
  let boundaryFingerprint: string | null = null;
  if (body.boundary_fingerprint !== undefined && body.boundary_fingerprint !== null) {
    if (typeof body.boundary_fingerprint !== "string" || !body.boundary_fingerprint.trim()) {
      return { error: "boundary_fingerprint must be a non-empty string when present" };
    }
    boundaryFingerprint = body.boundary_fingerprint.trim();
  }
  return {
    proposal: {
      baseEpoch: body.base_epoch,
      baseRevision: body.base_revision,
      boundaryFingerprint,
      config: body.config,
      sourceOfChange: body.source_of_change.trim(),
    },
  };
}

function parseRevisionParam(raw: string | undefined): number | null {
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }
  const parsed = Number(raw.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Matches the store's "no revision N for <instance>" miss. */
const REVISION_NOT_FOUND_RE = /no revision \d+ for/;

/**
 * Map the store's thrown Errors onto the typed-error envelope.
 *
 * The store signals wrong-state and missing-revision conditions with plain
 * `Error`s carrying stable message prefixes, so this adapter classifies them
 * rather than letting every one collapse into an opaque 500. Anything
 * unrecognized is rethrown untouched — an adapter must not invent a status for
 * a failure it does not understand.
 */
function classifyStoreError(err: unknown): { code: string; message: string; status: number } | null {
  const message = err instanceof Error ? err.message : "";
  if (message.includes("is 'active'") || message.includes("not 'proposed'")) {
    return {
      code: "connector_instance_config_not_proposed",
      message,
      status: 409,
    };
  }
  if (REVISION_NOT_FOUND_RE.test(message)) {
    return {
      code: "connector_instance_config_revision_not_found",
      message,
      status: 404,
    };
  }
  if (message.includes("does not own")) {
    return { code: "connector_instance_owner_mismatch", message, status: 403 };
  }
  return null;
}

function buildGetActiveHandler(ctx: MountOwnerConnectionConfigContext): RouteHandler {
  return async (req: RouteRequest, res: RouteResponse) => {
    try {
      const ownerSubjectId = ctx.getOwnerTokenSubjectId(req);
      const namespace = await ctx.resolveOwnerConnectorNamespace(req, null, {
        allowDefaultAccount: false,
        connectorInstanceId: decodeURIComponent(req.params.connectionId as string),
        ownerSubjectId,
      });
      const [active, pointer] = await Promise.all([
        ctx.store.getActiveRevision(namespace.connectorInstanceId),
        ctx.store.getCurrentPointer(namespace.connectorInstanceId),
      ]);
      // `base_revision`/`base_epoch` are surfaced here because they are exactly
      // what a subsequent propose must echo back. A connection with no pointer
      // yet reports the store's own starting base (revision 0, epoch 1) rather
      // than null, so a first write does not have to guess.
      res.json({
        active_revision: active ? revisionForWire(active) : null,
        base_epoch: pointer?.storageEpoch ?? 1,
        base_revision: pointer?.activeRevision ?? 0,
        connection_id: namespace.connectorInstanceId,
        current: pointerForWire(pointer),
        object: "connector_config",
      });
    } catch (err) {
      ctx.handleError(res, err);
    }
  };
}

function buildListRevisionsHandler(ctx: MountOwnerConnectionConfigContext): RouteHandler {
  return async (req: RouteRequest, res: RouteResponse) => {
    try {
      const ownerSubjectId = ctx.getOwnerTokenSubjectId(req);
      const namespace = await ctx.resolveOwnerConnectorNamespace(req, null, {
        allowDefaultAccount: false,
        connectorInstanceId: decodeURIComponent(req.params.connectionId as string),
        ownerSubjectId,
      });
      const revisions = await ctx.store.listRevisions(namespace.connectorInstanceId);
      res.json({
        connection_id: namespace.connectorInstanceId,
        data: revisions.map((revision) => revisionForWire(revision)),
        object: "list",
      });
    } catch (err) {
      ctx.handleError(res, err);
    }
  };
}

function buildProposeHandler(ctx: MountOwnerConnectionConfigContext): RouteHandler {
  return async (req: RouteRequest, res: RouteResponse) => {
    try {
      const ownerSubjectId = ctx.getOwnerTokenSubjectId(req);
      const parsed = parseProposalBody(req.body);
      if ("error" in parsed) {
        ctx.pdppError(res, 400, "invalid_request", parsed.error);
        return;
      }
      const namespace = await ctx.resolveOwnerConnectorNamespace(req, null, {
        allowDefaultAccount: false,
        connectorInstanceId: decodeURIComponent(req.params.connectionId as string),
        ownerSubjectId,
      });
      const now = (ctx.now?.() ?? new Date()).toISOString();
      const revision = await ctx.store.propose({
        baseEpoch: parsed.proposal.baseEpoch,
        baseRevision: parsed.proposal.baseRevision,
        boundaryFingerprint: parsed.proposal.boundaryFingerprint,
        config: parsed.proposal.config,
        connectorInstanceId: namespace.connectorInstanceId,
        provenance: {
          isExplicit: true,
          origin: originForToken(req),
          setAt: now,
          setBy: actorForToken(req, ownerSubjectId),
          sourceOfChange: parsed.proposal.sourceOfChange,
        },
      });
      // 201: a revision was appended. Its `status` tells the caller whether
      // anything is now in force — `proposed` means a confirm call is still
      // required before any run resolves against it.
      res.status(201).json(revisionForWire(revision));
    } catch (err) {
      if (err instanceof ConfigStaleWriteError) {
        // Hand back the store's ACTUAL current base so the caller can rebase
        // deterministically instead of re-reading into the same race.
        ctx.pdppError(res, 409, "connector_instance_config_stale_write", err.message);
        return;
      }
      const classified = classifyStoreError(err);
      if (classified) {
        ctx.pdppError(res, classified.status, classified.code, classified.message);
        return;
      }
      ctx.handleError(res, err);
    }
  };
}

function buildConfirmHandler(ctx: MountOwnerConnectionConfigContext): RouteHandler {
  return async (req: RouteRequest, res: RouteResponse) => {
    try {
      // The authenticated session is the ONLY source of this identity. The
      // body is never consulted -- see the file header.
      const ownerSubjectId = ctx.getOwnerTokenSubjectId(req);
      const revisionNumber = parseRevisionParam(req.params.revision);
      if (revisionNumber === null) {
        ctx.pdppError(res, 400, "invalid_request", "revision must be a positive integer");
        return;
      }
      const namespace = await ctx.resolveOwnerConnectorNamespace(req, null, {
        allowDefaultAccount: false,
        connectorInstanceId: decodeURIComponent(req.params.connectionId as string),
        ownerSubjectId,
      });
      const confirmed = await ctx.store.confirm({
        authenticatedOwnerSubjectId: ownerSubjectId,
        confirmedAt: (ctx.now?.() ?? new Date()).toISOString(),
        connectorInstanceId: namespace.connectorInstanceId,
        revision: revisionNumber,
      });
      res.json(revisionForWire(confirmed));
    } catch (err) {
      const classified = classifyStoreError(err);
      if (classified) {
        ctx.pdppError(res, classified.status, classified.code, classified.message);
        return;
      }
      ctx.handleError(res, err);
    }
  };
}

export function mountOwnerConnectionConfig(app: AppLike, ctx: MountOwnerConnectionConfigContext): void {
  app.get("/v1/owner/connections/:connectionId/config", ctx.requireToken, ctx.requireOwner, buildGetActiveHandler(ctx));
  app.get(
    "/v1/owner/connections/:connectionId/config/revisions",
    ctx.requireToken,
    ctx.requireOwner,
    buildListRevisionsHandler(ctx)
  );
  app.post(
    "/v1/owner/connections/:connectionId/config/revisions",
    ctx.requireToken,
    ctx.requireOwner,
    buildProposeHandler(ctx)
  );
  app.post(
    "/v1/owner/connections/:connectionId/config/revisions/:revision/confirm",
    ctx.requireToken,
    ctx.requireOwner,
    buildConfirmHandler(ctx)
  );
}
