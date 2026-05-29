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

import {
  type RefApproval,
  executeRefApprovalsList,
} from "../../operations/ref-approvals-list/index.ts";
import {
  RefClientsListInvalidRequestError,
  type RefClientsListClient,
  executeRefClientsList,
} from "../../operations/ref-clients-list/index.ts";
import {
  type RefDeploymentReport,
  executeRefDeployment,
} from "../../operations/ref-deployment/index.ts";
import {
  type RefRecordsTimelineCollectInput,
  type RefRecordsTimelineEntry,
  executeRefRecordsTimeline,
} from "../../operations/ref-records-timeline/index.ts";
import { executeRefSchedulesList } from "../../operations/ref-schedules-list/index.ts";
import {
  type RefSpineSearchResult,
  executeRefSpineSearch,
} from "../../operations/ref-spine-search/index.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

// Express-shaped surface, structurally typed to avoid pulling in the
// transport's `.js` ambient types. Matches the pattern established in
// `server/routes/ref-connectors.ts`.

interface RouteRequest {
  readonly body?: unknown;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, unknown>>;
  readonly ownerSession?: { readonly sub?: string } | null;
}

interface RouteResponse {
  json(body: unknown): unknown;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
}

export interface MountRefAdminContext {
  readonly requireOwnerSession: MiddlewareHandler;
  readonly handleError: (res: unknown, err: unknown) => void;
  readonly pdppError: PdppErrorFn;
  // Substrate capabilities — injected by host so the adapter never touches
  // the store handles or process.env directly.
  readonly listPendingApprovals: () => Promise<readonly RefApproval[]> | readonly RefApproval[];
  readonly collectRecordsTimelineEntries: (
    input: RefRecordsTimelineCollectInput,
  ) => Promise<readonly RefRecordsTimelineEntry[]> | readonly RefRecordsTimelineEntry[];
  readonly listSchedules: () => Promise<unknown[]>;
  readonly collectDeploymentReport: (req: RouteRequest) => Promise<RefDeploymentReport>;
  readonly listOwnerIssuedClients: (subjectId: string) => Promise<readonly RefClientsListClient[]>;
  readonly searchSpine: (query: string) => Promise<RefSpineSearchResult> | RefSpineSearchResult;
  // Subject resolution — mirrors `getOwnerSubjectId` closure in index.js.
  readonly getOwnerSubjectId: (req: RouteRequest) => string;
  // Query-string helpers — mirrors `resolveSingleConnectorIdQueryValue` in index.js.
  readonly resolveSingleConnectorIdQueryValue: (raw: unknown) => string | null;
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
          { searchSpine: (query) => ctx.searchSpine(query) },
        );
        res.json(envelope);
      } catch (err) {
        ctx.handleError(res, err);
      }
    },
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
    },
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
        const limit =
          req.query.limit == null
            ? null
            : Number.parseInt(String(req.query.limit), 10);
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
          },
        );
        res.json(envelope);
      } catch (err) {
        ctx.handleError(res, err);
      }
    },
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
    },
  );
}

// GET /_ref/deployment
//
// Reference operator diagnostics. Not a PDPP protocol surface. The canonical
// `ref.deployment` operation owns the envelope and env-redaction invariant;
// the host wires `collectDeploymentReport` which performs the actual redaction.
export function mountRefDeployment(app: AppLike, ctx: MountRefAdminContext): void {
  app.get(
    "/_ref/deployment",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const report = await executeRefDeployment({
          collectDeploymentReport: () => ctx.collectDeploymentReport(req),
        });
        res.json(report);
      } catch (err) {
        ctx.handleError(res, err);
      }
    },
  );
}

// GET /_ref/clients
//
// Operator-issued client listing. The canonical `ref.clients.list` operation
// owns the `?owner=true` requirement and the `{object: 'list', data}` envelope.
// The adapter owns owner auth and per-operator subject scoping.
export function mountRefClients(app: AppLike, ctx: MountRefAdminContext): void {
  app.get(
    "/_ref/clients",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const subjectId = ctx.getOwnerSubjectId(req);
        const envelope = await executeRefClientsList(
          { owner: req.query?.owner },
          {
            listOwnerIssuedClients: () => ctx.listOwnerIssuedClients(subjectId),
          },
        );
        res.json(envelope);
      } catch (err) {
        if (err instanceof RefClientsListInvalidRequestError) {
          ctx.pdppError(res, 400, "invalid_request", err.message);
          return;
        }
        ctx.handleError(res, err);
      }
    },
  );
}
