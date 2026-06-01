// HTTP adapter for the reference-only `/_ref/grant-packages` and
// `/_ref/event-subscriptions` route families.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family`. Each `mount...` function
// registers one route at the same point in registration order where
// `server/index.js` previously registered it inline. Owner-session posture,
// contract metadata, response envelopes, status codes, error mapping, and
// query-string parsing are unchanged.

import type {
  ClientEventSubscriptionStore,
  SubscriptionRow,
} from "../../operations/as-client-event-subscriptions/index.ts";
import {
  executeRefClientEventSubscriptionsDisable,
  RefClientEventSubscriptionsDisableInvalidRequestError,
  RefClientEventSubscriptionsDisableNotFoundError,
} from "../../operations/ref-client-event-subscriptions-disable/index.ts";
import {
  executeRefClientEventSubscriptionsGet,
  RefClientEventSubscriptionsNotFoundError,
} from "../../operations/ref-client-event-subscriptions-get/index.ts";
import { executeRefClientEventSubscriptionsList } from "../../operations/ref-client-event-subscriptions-list/index.ts";
import type {
  ListAllSubscriptionsFilters,
  SubscriptionAttemptRow,
  SubscriptionSummaryRow,
} from "../stores/client-event-subscription-store.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

interface RouteRequest {
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, unknown>>;
}

interface RouteResponse {
  json(body: unknown): unknown;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
  post(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
}

function subscriptionIdFromParams(params: Readonly<Record<string, string>>): string {
  return params.subscription_id ?? params.id ?? "";
}

// /_ref/grant-packages

export interface GrantPackageChild {
  readonly added_at: string;
  readonly grant_id: string;
  readonly grant_status: string;
  readonly member_status: string;
  readonly revoked_at: string | null;
  readonly source: string | null;
}

export interface GrantPackageSummaryRow {
  readonly approved_at: string | null;
  readonly children: readonly GrantPackageChild[];
  readonly client_id: string;
  readonly created_at: string;
  readonly member_count: number;
  readonly package_id: string;
  readonly revoked_at: string | null;
  readonly scenario_id: string | null;
  readonly status: string;
  readonly subject_id: string;
  readonly trace_id: string | null;
}

export interface GrantPackageListPage {
  readonly data: readonly GrantPackageSummaryRow[];
  readonly has_more: boolean;
  readonly limit: number;
  readonly next_cursor: string | null;
}

export interface GrantPackageRevokeFailure {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
  readonly grant_id: string;
}

export interface GrantPackageRevokeResult {
  readonly not_revoked_child_grants: readonly GrantPackageRevokeFailure[];
  readonly package_id: string;
  readonly revoked_at: string | null;
  readonly revoked_child_grants: readonly string[];
  readonly status: "revoked" | "partial_failure";
}

export interface MountRefGrantsContext {
  readonly getClientEventSubscriptionStore: () => ClientEventSubscriptionStore;
  readonly getGrantPackageForOwner: (id: string) => Promise<GrantPackageSummaryRow | null>;
  readonly getSubscriptionSummary: (subscriptionId: string) => Promise<SubscriptionSummaryRow | null>;
  readonly handleError: (res: unknown, err: unknown) => void;
  // event-subscriptions substrate
  readonly listAllSubscriptions: (filters: ListAllSubscriptionsFilters) => Promise<readonly SubscriptionRow[]>;
  readonly listAttemptsForSubscription: (
    subscriptionId: string,
    limit: number
  ) => Promise<readonly SubscriptionAttemptRow[]>;
  // grant-packages substrate
  readonly listGrantPackagesForOwner: (query: {
    limit: number;
    cursor: string | null;
  }) => Promise<GrantPackageListPage>;
  readonly nowIso: () => string;
  readonly pdppError: PdppErrorFn;
  readonly requireOwnerSession: MiddlewareHandler;
  readonly revokeGrantPackage: (id: string, opts: { request_id?: string }) => Promise<GrantPackageRevokeResult>;
}

// Preserves the original inline validation, error codes, and defaults.
function parseGrantPackageListQuery(query: Readonly<Record<string, unknown>>): {
  limit: number;
  cursor: string | null;
} {
  const rawLimit = query?.limit;
  let limit = 50;
  if (rawLimit !== undefined && rawLimit !== null) {
    const parsed = Number.parseInt(String(rawLimit), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      const err = Object.assign(new Error(`limit must be a positive integer (got "${rawLimit}")`), {
        code: "invalid_request",
        param: "limit",
      });
      throw err;
    }
    if (parsed > 200) {
      const err = Object.assign(new Error("limit exceeds maximum 200"), {
        code: "invalid_request",
        param: "limit",
      });
      throw err;
    }
    limit = parsed;
  }
  return {
    limit,
    cursor: typeof query?.cursor === "string" && (query.cursor as string).length > 0 ? (query.cursor as string) : null,
  };
}

// GET /_ref/grant-packages
export function mountRefGrantPackagesList(app: AppLike, ctx: MountRefGrantsContext): void {
  app.get("/_ref/grant-packages", ctx.requireOwnerSession, async (req: RouteRequest, res: RouteResponse) => {
    try {
      const page = await ctx.listGrantPackagesForOwner(parseGrantPackageListQuery(req.query));
      res.json({
        object: "list",
        data: page.data.map((pkg) => ({
          object: "grant_package_summary",
          package_id: pkg.package_id,
          subject_id: pkg.subject_id,
          client_id: pkg.client_id,
          status: pkg.status,
          member_count: pkg.member_count,
          created_at: pkg.created_at,
          approved_at: pkg.approved_at,
          revoked_at: pkg.revoked_at,
        })),
        has_more: page.has_more,
        next_cursor: page.next_cursor,
        limit: page.limit,
      });
    } catch (err) {
      ctx.handleError(res, err);
    }
  });
}

// GET /_ref/grant-packages/:id
export function mountRefGrantPackagesGet(app: AppLike, ctx: MountRefGrantsContext): void {
  app.get("/_ref/grant-packages/:id", ctx.requireOwnerSession, async (req: RouteRequest, res: RouteResponse) => {
    try {
      const id = req.params.id ?? "";
      const pkg = await ctx.getGrantPackageForOwner(id);
      if (!pkg) {
        ctx.pdppError(res, 404, "not_found", `grant package not found: ${id}`);
        return;
      }
      res.json({
        object: "grant_package",
        package_id: pkg.package_id,
        subject_id: pkg.subject_id,
        client_id: pkg.client_id,
        status: pkg.status,
        member_count: pkg.member_count,
        created_at: pkg.created_at,
        approved_at: pkg.approved_at,
        revoked_at: pkg.revoked_at,
        trace_id: pkg.trace_id,
        scenario_id: pkg.scenario_id,
        children: pkg.children.map((child) => ({
          object: "grant_package_child",
          grant_id: child.grant_id,
          grant_status: child.grant_status,
          member_status: child.member_status,
          added_at: child.added_at,
          revoked_at: child.revoked_at,
          source: child.source,
        })),
      });
    } catch (err) {
      ctx.handleError(res, err);
    }
  });
}

// POST /_ref/grant-packages/:id/revoke
export function mountRefGrantPackagesRevoke(app: AppLike, ctx: MountRefGrantsContext): void {
  app.post(
    "/_ref/grant-packages/:id/revoke",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const id = req.params.id ?? "";
        const pkg = await ctx.getGrantPackageForOwner(id);
        if (!pkg) {
          ctx.pdppError(res, 404, "not_found", `grant package not found: ${id}`);
          return;
        }
        if (pkg.status !== "active") {
          ctx.pdppError(res, 409, "already_revoked", `grant package ${id} is already ${pkg.status}`);
          return;
        }
        const xRequestId = req.headers["x-request-id"];
        const revokeOpts: { request_id?: string } = typeof xRequestId === "string" ? { request_id: xRequestId } : {};
        const result = await ctx.revokeGrantPackage(id, revokeOpts);
        const after = await ctx.getGrantPackageForOwner(id);
        const body = {
          object: "grant_package_revoke_result",
          package_id: id,
          status: result.status,
          revoked_at: result.revoked_at ?? after?.revoked_at ?? null,
          revoked_child_count: result.revoked_child_grants.length,
          not_revoked_child_count: result.not_revoked_child_grants.length,
          revoked_child_grants: result.revoked_child_grants,
          not_revoked_child_grants: result.not_revoked_child_grants,
        };
        if (result.status === "partial_failure") {
          res.status(500).json(body);
          return;
        }
        res.json(body);
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

// /_ref/event-subscriptions

// GET /_ref/event-subscriptions
export function mountRefEventSubscriptionsList(app: AppLike, ctx: MountRefGrantsContext): void {
  app.get(
    "/_ref/event-subscriptions",
    { contract: "refListEventSubscriptions" } as RouteArg<RouteHandler>,
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const envelope = await executeRefClientEventSubscriptionsList(
          {
            clientId: typeof req.query.client_id === "string" ? req.query.client_id : null,
            grantId: typeof req.query.grant_id === "string" ? req.query.grant_id : null,
            status: typeof req.query.status === "string" ? req.query.status : null,
          },
          {
            listAllSubscriptions: ctx.listAllSubscriptions,
            getSubscriptionSummary: ctx.getSubscriptionSummary,
          }
        );
        res.json(envelope);
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

// GET /_ref/event-subscriptions/:subscription_id
export function mountRefEventSubscriptionsGet(app: AppLike, ctx: MountRefGrantsContext): void {
  app.get(
    "/_ref/event-subscriptions/:subscription_id",
    { contract: "refGetEventSubscription" } as RouteArg<RouteHandler>,
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const detail = await executeRefClientEventSubscriptionsGet(subscriptionIdFromParams(req.params), {
          getSubscriptionSummary: ctx.getSubscriptionSummary,
          listAttemptsForSubscription: ctx.listAttemptsForSubscription,
        });
        res.json(detail);
      } catch (err) {
        if (err instanceof RefClientEventSubscriptionsNotFoundError) {
          ctx.pdppError(res, 404, (err as { code: string }).code, (err as Error).message);
          return;
        }
        ctx.handleError(res, err);
      }
    }
  );
}

// POST /_ref/event-subscriptions/:subscription_id/disable
export function mountRefEventSubscriptionsDisable(app: AppLike, ctx: MountRefGrantsContext): void {
  app.post(
    "/_ref/event-subscriptions/:subscription_id/disable",
    { contract: "refDisableEventSubscription" } as RouteArg<RouteHandler>,
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const body = req.body as Record<string, unknown> | null | undefined;
        const reason = body && typeof body === "object" && typeof body.reason === "string" ? body.reason : null;
        const out = await executeRefClientEventSubscriptionsDisable(
          { subscriptionId: subscriptionIdFromParams(req.params), reason },
          { store: ctx.getClientEventSubscriptionStore(), nowIso: ctx.nowIso }
        );
        const detail = await executeRefClientEventSubscriptionsGet(out.subscriptionId, {
          getSubscriptionSummary: ctx.getSubscriptionSummary,
          listAttemptsForSubscription: ctx.listAttemptsForSubscription,
        });
        res.json(detail);
      } catch (err) {
        if (err instanceof RefClientEventSubscriptionsDisableNotFoundError) {
          ctx.pdppError(res, 404, (err as { code: string }).code, (err as Error).message);
          return;
        }
        if (err instanceof RefClientEventSubscriptionsDisableInvalidRequestError) {
          ctx.pdppError(res, 400, (err as { code: string }).code, (err as Error).message);
          return;
        }
        ctx.handleError(res, err);
      }
    }
  );
}
