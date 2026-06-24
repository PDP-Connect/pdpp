// HTTP adapter for the reference-only `/_ref/approvals`,
// `/_ref/records/timeline`, `/_ref/schedules`, `/_ref/deployment`,
// `/_ref/clients`, and `/_ref/search` route family.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family` (§2.5). Each `mount...`
// function registers one route at the same point in registration order
// where `server/index.js` previously registered it inline. Owner-session
// posture, contract metadata, response envelopes, status codes, error
// mapping, and query-string parsing are unchanged.

import { executeRefApprovalsList, type RefApproval } from "../../operations/ref-approvals-list/index.ts";
import {
  executeRefClientsList,
  type RefClientsListClient,
  RefClientsListInvalidRequestError,
} from "../../operations/ref-clients-list/index.ts";
import { executeRefDeployment, type RefDeploymentReport } from "../../operations/ref-deployment/index.ts";
import {
  executeRefRecordsTimeline,
  type RefRecordsTimelineCollectInput,
  type RefRecordsTimelineEntry,
} from "../../operations/ref-records-timeline/index.ts";
import { executeRefSchedulesList } from "../../operations/ref-schedules-list/index.ts";
import { executeRefSpineSearch, type RefSpineSearchResult } from "../../operations/ref-spine-search/index.ts";
import {
  executeExploreTimeline,
  executeExploreUpcoming,
  InvalidCompositeCursorError,
} from "../../operations/rs-explore-timeline/index.ts";
import { isInternalConnectorId } from "../connector-key.js";
import { buildExploreTimelineDeps } from "../explore-timeline-substrate.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

// Express-shaped surface, structurally typed to avoid pulling in the
// transport's `.js` ambient types. Matches the pattern established in
// `server/routes/ref-connectors.ts`.

interface RouteRequest {
  readonly body?: unknown;
  readonly ownerSession?: { readonly sub?: string } | null;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, unknown>>;
}

interface RouteResponse {
  json(body: unknown): unknown;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  delete(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
  get(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
  post(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
}

export interface RefCimdDocument {
  readonly client_name: string | null;
  readonly created_at: string;
  readonly document_id: string;
  readonly logo_uri: string | null;
  readonly redirect_uris: readonly string[];
  readonly updated_at: string;
}

export interface CreateRefCimdDocumentInput {
  readonly clientName: string | null;
  readonly logoUri: string | null;
  readonly redirectUris: readonly string[];
}

export interface MountRefAdminContext {
  readonly collectDeploymentReport: (req: RouteRequest) => Promise<RefDeploymentReport>;
  readonly collectRecordsTimelineEntries: (
    input: RefRecordsTimelineCollectInput
  ) => Promise<readonly RefRecordsTimelineEntry[]> | readonly RefRecordsTimelineEntry[];
  // Subject resolution — mirrors `getOwnerSubjectId` closure in index.js.
  readonly getOwnerSubjectId: (req: RouteRequest) => string;
  readonly handleError: (res: unknown, err: unknown) => void;
  readonly createCimdDocument: (input: CreateRefCimdDocumentInput) => Promise<string>;
  readonly deleteCimdDocument: (
    documentId: string,
    opts: { clientId: string; requestId?: string | null; traceId?: string | null }
  ) => Promise<void>;
  readonly getCimdDocument: (documentId: string) => Promise<RefCimdDocument | null>;
  readonly listCimdDocuments: () => Promise<readonly RefCimdDocument[]>;
  readonly listOwnerIssuedClients: (subjectId: string) => Promise<readonly RefClientsListClient[]>;
  // Substrate capabilities — injected by host so the adapter never touches
  // the store handles or process.env directly.
  readonly listPendingApprovals: () => Promise<readonly RefApproval[]> | readonly RefApproval[];
  readonly listSchedules: () => Promise<unknown[]>;
  readonly pdppError: PdppErrorFn;
  readonly requireOwnerSession: MiddlewareHandler;
  readonly resolveBaseUrl: (req: RouteRequest) => string;
  // Query-string helpers — mirrors `resolveSingleConnectorIdQueryValue` in index.js.
  readonly resolveSingleConnectorIdQueryValue: (raw: unknown) => string | null;
  readonly searchSpine: (query: string) => Promise<RefSpineSearchResult> | RefSpineSearchResult;
}

function buildClientMetadataUrl(baseUrl: string, documentId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/oauth/client-metadata/${encodeURIComponent(documentId)}`;
}

function asBodyObject(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function readOptionalString(body: Record<string, unknown>, ...names: string[]): string | null {
  for (const name of names) {
    const value = body[name];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return null;
}

function readQueryStringList(query: Readonly<Record<string, unknown>>, ...names: string[]): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const raw = query[name];
    const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
    for (const value of values) {
      if (typeof value !== "string") {
        continue;
      }
      const trimmed = value.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function isLoopbackRedirect(url: URL): boolean {
  if (url.protocol !== "http:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function validateRedirectUri(uri: string): string {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw Object.assign(new Error(`Invalid redirect_uri: ${uri}`), { code: "invalid_redirect_uri" });
  }
  if (parsed.protocol !== "https:" && !isLoopbackRedirect(parsed)) {
    throw Object.assign(
      new Error("redirect_uris must use https, or http loopback for local MCP clients"),
      { code: "invalid_redirect_uri" }
    );
  }
  return parsed.toString();
}

function readRedirectUris(body: Record<string, unknown>): readonly string[] {
  const raw = body.redirect_uris ?? body.redirectUris;
  const values =
    Array.isArray(raw) ? raw : typeof raw === "string" && raw.trim() ? raw.split(/\s*,\s*/) : [];
  const redirectUris = values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => validateRedirectUri(value.trim()));
  return [...new Set(redirectUris)];
}

function parseCreateCimdDocumentInput(body: unknown): CreateRefCimdDocumentInput {
  const obj = asBodyObject(body);
  if (typeof obj.client_secret === "string" && obj.client_secret.trim()) {
    throw Object.assign(new Error("client_secret is not supported for PDPP-hosted CIMD documents"), {
      code: "invalid_client_metadata",
    });
  }
  const authMethod = readOptionalString(obj, "token_endpoint_auth_method", "tokenEndpointAuthMethod");
  if (authMethod && authMethod !== "none") {
    throw Object.assign(new Error("Only token_endpoint_auth_method=none is supported"), {
      code: "invalid_client_metadata",
    });
  }
  const redirectUris = readRedirectUris(obj);
  if (redirectUris.length === 0) {
    throw Object.assign(new Error("At least one redirect_uri is required"), {
      code: "invalid_redirect_uri",
    });
  }
  const logoUri = readOptionalString(obj, "logo_uri", "logoUri");
  if (logoUri) {
    try {
      new URL(logoUri);
    } catch {
      throw Object.assign(new Error("logo_uri must be a valid URL"), { code: "invalid_client_metadata" });
    }
  }
  return {
    clientName: readOptionalString(obj, "client_name", "clientName") ?? "Custom MCP client",
    logoUri,
    redirectUris,
  };
}

function projectCimdDocument(doc: RefCimdDocument, baseUrl: string) {
  return {
    object: "cimd_client_metadata_document",
    document_id: doc.document_id,
    client_id: buildClientMetadataUrl(baseUrl, doc.document_id),
    client_name: doc.client_name,
    redirect_uris: doc.redirect_uris,
    logo_uri: doc.logo_uri,
    token_endpoint_auth_method: "none",
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

// GET /_ref/search
//
// Reference-only spine artifact-jump helper for the operator console.
// Not the public lexical retrieval surface (that lives at GET /v1/search).
export function mountRefSearch(app: AppLike, ctx: MountRefAdminContext): void {
  app.get(
    "/_ref/search",
    { contract: "refSearch" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const envelope = await executeRefSpineSearch(
          { query: (req.query.q as string) || "" },
          { searchSpine: (query) => ctx.searchSpine(query), isInternalConnectorId }
        );
        res.json(envelope);
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

// GET /_ref/approvals
//
// Reference-only pending approvals queue. The canonical `ref.approvals.list`
// operation owns the envelope, the redaction guarantees, and the sort.
export function mountRefApprovals(app: AppLike, ctx: MountRefAdminContext): void {
  app.get(
    "/_ref/approvals",
    { contract: "refListApprovals" },
    ctx.requireOwnerSession,
    async (_req: RouteRequest, res: RouteResponse) => {
      try {
        const envelope = await executeRefApprovalsList({
          listPendingApprovals: () => ctx.listPendingApprovals(),
        });
        res.json(envelope);
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

// GET /_ref/records/timeline
//
// Reference-only timeline view. The canonical `ref.records.timeline`
// operation owns input normalisation, the final data slice, and the envelope.
export function mountRefRecordsTimeline(app: AppLike, ctx: MountRefAdminContext): void {
  app.get(
    "/_ref/records/timeline",
    { contract: "refRecordsTimeline" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const limit = req.query.limit == null ? null : Number.parseInt(String(req.query.limit), 10);
        const connectorId = ctx.resolveSingleConnectorIdQueryValue(req.query.connector_id);
        const envelope = await executeRefRecordsTimeline(
          {
            connectorId,
            stream: typeof req.query.stream === "string" ? req.query.stream : null,
            since: typeof req.query.since === "string" ? req.query.since : null,
            until: typeof req.query.until === "string" ? req.query.until : null,
            limit: Number.isFinite(limit) ? limit : null,
            order: typeof req.query.order === "string" ? req.query.order : null,
            timestampMode: typeof req.query.timestamp_mode === "string" ? req.query.timestamp_mode : null,
          },
          {
            collectEntries: (input) => ctx.collectRecordsTimelineEntries(input),
          }
        );
        res.json(envelope);
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

// GET /_ref/schedules
//
// Reference-only schedule listing. The canonical `ref.schedules.list`
// operation owns the envelope; the adapter owns auth and response writing.
export function mountRefSchedules(app: AppLike, ctx: MountRefAdminContext): void {
  app.get(
    "/_ref/schedules",
    { contract: "refListSchedules" },
    ctx.requireOwnerSession,
    async (_req: RouteRequest, res: RouteResponse) => {
      try {
        const envelope = await executeRefSchedulesList({
          listSchedules: () => ctx.listSchedules(),
        });
        res.json(envelope);
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

// GET /_ref/deployment
//
// Reference operator diagnostics. Not a PDPP protocol surface. The canonical
// `ref.deployment` operation owns the envelope and env-redaction invariant;
// the host wires `collectDeploymentReport` which performs the actual redaction.
export function mountRefDeployment(app: AppLike, ctx: MountRefAdminContext): void {
  app.get("/_ref/deployment", ctx.requireOwnerSession, async (req: RouteRequest, res: RouteResponse) => {
    try {
      const report = await executeRefDeployment({
        collectDeploymentReport: () => ctx.collectDeploymentReport(req),
      });
      res.json(report);
    } catch (err) {
      ctx.handleError(res, err);
    }
  });
}

// GET /_ref/clients
//
// Operator-issued client listing. The canonical `ref.clients.list` operation
// owns the `?owner=true` requirement and the `{object: 'list', data}` envelope.
// The adapter owns owner auth and per-operator subject scoping.
export function mountRefClients(app: AppLike, ctx: MountRefAdminContext): void {
  app.get("/_ref/clients", ctx.requireOwnerSession, async (req: RouteRequest, res: RouteResponse) => {
    try {
      const subjectId = ctx.getOwnerSubjectId(req);
      const envelope = await executeRefClientsList(
        { owner: req.query?.owner },
        {
          listOwnerIssuedClients: () => ctx.listOwnerIssuedClients(subjectId),
        }
      );
      res.json(envelope);
    } catch (err) {
      if (err instanceof RefClientsListInvalidRequestError) {
        ctx.pdppError(res, 400, "invalid_request", err.message);
        return;
      }
      ctx.handleError(res, err);
    }
  });
}

// GET/POST/DELETE /_ref/cimd-client-documents
//
// Operator-managed client identity documents for local MCP clients. This is a
// reference-only management surface; the public document is served from
// `GET /oauth/client-metadata/:id`.
export function mountRefCimdClientDocuments(app: AppLike, ctx: MountRefAdminContext): void {
  app.get("/_ref/cimd-client-documents", ctx.requireOwnerSession, async (req: RouteRequest, res: RouteResponse) => {
    try {
      const baseUrl = ctx.resolveBaseUrl(req);
      const docs = await ctx.listCimdDocuments();
      res.json({
        object: "list",
        data: docs.map((doc) => projectCimdDocument(doc, baseUrl)),
        has_more: false,
      });
    } catch (err) {
      ctx.handleError(res, err);
    }
  });

  app.post("/_ref/cimd-client-documents", ctx.requireOwnerSession, async (req: RouteRequest, res: RouteResponse) => {
    try {
      const input = parseCreateCimdDocumentInput(req.body);
      const documentId = await ctx.createCimdDocument(input);
      const doc = await ctx.getCimdDocument(documentId);
      if (!doc) {
        throw new Error(`CIMD document was not readable after creation: ${documentId}`);
      }
      res.status(201).json(projectCimdDocument(doc, ctx.resolveBaseUrl(req)));
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      if (code === "invalid_redirect_uri" || code === "invalid_client_metadata") {
        ctx.pdppError(
          res,
          400,
          typeof code === "string" ? code : "invalid_request",
          err instanceof Error ? err.message : "Invalid CIMD document request"
        );
        return;
      }
      ctx.handleError(res, err);
    }
  });

  app.delete(
    "/_ref/cimd-client-documents/:documentId",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const documentId = decodeURIComponent(req.params.documentId as string);
      const clientId = buildClientMetadataUrl(ctx.resolveBaseUrl(req), documentId);
      try {
        await ctx.deleteCimdDocument(documentId, { clientId });
        res.json({
          object: "cimd_client_metadata_document_deletion",
          document_id: documentId,
          client_id: clientId,
          deleted: true,
        });
      } catch (err) {
        if ((err as { code?: unknown })?.code === "not_found") {
          ctx.pdppError(res, 404, "not_found", err instanceof Error ? err.message : "CIMD document not found");
          return;
        }
        ctx.handleError(res, err);
      }
    }
  );
}

// GET /_ref/explore/records
//
// Cross-source merged timeline for the owner's Explore surface (Phase 3).
//
// Returns a page of time-ordered records spanning all (connector_instance_id, stream)
// partitions with ONE composite cursor for stable, keyset-pageable deep pagination.
// Point-in-time stability: the snapshot anchor in the composite cursor ensures that
// records ingested after page 1 do not appear in or shift already-returned pages.
// The `new_since_snapshot` field counts new records the UI can surface as an "N new" pill.
//
// This is a reference/operator surface, not the PDPP protocol. Clients must not
// depend on the response shape — it is shaped for the console Explore canvas.
export function mountRefExploreRecords(app: AppLike, ctx: MountRefAdminContext): void {
  app.get(
    "/_ref/explore/records",
    { contract: "refExploreRecords" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const rawLimit = req.query.limit == null ? null : Number.parseInt(String(req.query.limit), 10);
        const limit = Number.isFinite(rawLimit) && rawLimit != null && rawLimit > 0 ? rawLimit : null;
        // Page-1 upcoming head size, independent of the feed `limit` (the bounded
        // future set is revealed on first expand, not dripped 32 at a time).
        const rawUpcomingLimit =
          req.query.upcoming_limit == null ? null : Number.parseInt(String(req.query.upcoming_limit), 10);
        const upcomingLimit =
          Number.isFinite(rawUpcomingLimit) && rawUpcomingLimit != null && rawUpcomingLimit > 0
            ? rawUpcomingLimit
            : null;
        const cursor = typeof req.query.cursor === "string" && req.query.cursor.length > 0 ? req.query.cursor : null;
        // REWIND: re-render page 1 pinned to the cursor's ORIGINAL snapshot
        // (snapshotSeq), not a fresh one. The console accumulator passes
        // `rewind=1` with the page-1 cursor so an after-snapshot backfill can
        // never displace an original page-1 row ("Load more hides records above").
        const rewindRaw = req.query.rewind;
        const rewindToFirstPage = rewindRaw === "1" || rewindRaw === "true";
        const connectionIds = readQueryStringList(req.query, "connection", "connection_id", "connections");
        const streams = readQueryStringList(req.query, "stream", "streams");
        // EXCLUDE scope ("is not" facet / `-con:`/`-stream:`): applied at partition
        // enumeration so excluded partitions are absent from the feed, Upcoming, counts,
        // and cursor — exact counts, no client-side shrinking.
        const excludeConnectionIds = readQueryStringList(req.query, "xconnection", "xconnections");
        const excludeStreams = readQueryStringList(req.query, "xstream", "xstreams");
        // Sort DIRECTION for the main feed: "asc" = the order=oldest re-page
        // (earliest record first, paging forward); anything else = newest-first.
        const direction = req.query.direction === "asc" ? "asc" : "desc";
        // Separate cursor for paging the Upcoming (future) projection to exhaustion.
        // When present, this request pages ONLY the future set (the main feed is not
        // re-traversed) — count==reachability for "188 upcoming, all reachable".
        const upcomingCursor =
          typeof req.query.upcoming_cursor === "string" && req.query.upcoming_cursor.length > 0
            ? req.query.upcoming_cursor
            : null;

        const deps = buildExploreTimelineDeps();

        if (upcomingCursor) {
          // Page the rest of the bounded future set with the upcoming limit so one
          // "Load more upcoming" reveals everything remaining (not 32 at a time).
          const upcomingPage = await executeExploreUpcoming({ upcomingCursor, limit: upcomingLimit ?? limit }, deps);
          // Shape to the same response contract: the feed fields are empty (this is
          // an upcoming-only page), and the client carries upcoming_total from page 1.
          res.json({
            object: "list" as const,
            data: [],
            has_more: false,
            next_cursor: null,
            snapshot_at: upcomingPage.snapshot_at,
            new_since_snapshot: 0,
            upcoming: upcomingPage.upcoming,
            upcoming_total: 0,
            upcoming_next_cursor: upcomingPage.upcoming_next_cursor,
            upcoming_has_more: upcomingPage.upcoming_has_more,
          });
          return;
        }

        const result = await executeExploreTimeline(
          {
            limit,
            upcomingLimit,
            cursor,
            rewindToFirstPage,
            connectionIds,
            streams,
            excludeConnectionIds,
            excludeStreams,
            direction,
          },
          deps
        );
        res.json(result);
      } catch (err) {
        if (err instanceof InvalidCompositeCursorError || (err as { code?: unknown })?.code === "invalid_cursor") {
          ctx.pdppError(res, 400, "invalid_cursor", err instanceof Error ? err.message : "Invalid cursor");
          return;
        }
        ctx.handleError(res, err);
      }
    }
  );
}
