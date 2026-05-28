// HTTP adapter for the reference-only `/_ref/web-push/*` operator surface.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family` (§5.2). Owner-session
// posture, response envelopes, status codes, and error mapping are
// unchanged.
//
// The web push notifications surface is operator-only (operator console
// receives badge notifications about pending interactions and assistance
// alerts). Subscription state is owner-subject-scoped. The `test`
// endpoint is the operator's "ping my browser" smoke check; it requires
// VAPID to be configured.

interface WebPushConfig {
  readonly enabled: boolean;
  readonly publicKey?: string;
  readonly unavailableReason?: string;
}

interface WebPushSubscriptionRecord {
  readonly endpoint: string;
  readonly [key: string]: unknown;
}

interface WebPushUpsertMetadata {
  readonly device_label: string | null;
  readonly platform: string | null;
  readonly user_agent: string | null;
}

interface WebPushStore {
  list(ownerSubjectId: string): Promise<readonly WebPushSubscriptionRecord[]> | readonly WebPushSubscriptionRecord[];
  revoke(ownerSubjectId: string, endpoint: string): Promise<unknown> | unknown;
  upsert(
    ownerSubjectId: string,
    subscription: unknown,
    meta: WebPushUpsertMetadata
  ): Promise<WebPushSubscriptionRecord> | WebPushSubscriptionRecord;
}

interface FanoutTestResult {
  readonly attempted: number;
  readonly sent: number;
  readonly unavailable?: boolean | null;
}

type FanoutTestWebPush = (input: {
  config: WebPushConfig;
  store: WebPushStore;
  ownerSubjectId: string;
}) => Promise<FanoutTestResult> | FanoutTestResult;

interface RouteRequest {
  readonly body?: unknown;
  get(name: string): string | undefined;
}

interface RouteResponse {
  json(body: unknown): unknown;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;
type MiddlewareHandler = (...args: unknown[]) => unknown;

interface AppLike {
  delete(path: string, ...handlers: (MiddlewareHandler | RouteHandler)[]): AppLike;
  get(path: string, ...handlers: (MiddlewareHandler | RouteHandler)[]): AppLike;
  post(path: string, ...handlers: (MiddlewareHandler | RouteHandler)[]): AppLike;
}

type PdppErrorFn = (
  res: unknown,
  status: number,
  code: string,
  message: string | undefined,
  param?: string | null,
  extras?: Readonly<Record<string, unknown>> | null
) => unknown;

export interface MountRefWebPushContext {
  fanoutTestWebPush: FanoutTestWebPush;
  getOwnerSubjectId(req: unknown): string;
  handleError(res: unknown, err: unknown): void;
  pdppError: PdppErrorFn;
  requireOwnerSession: MiddlewareHandler;
  webPushConfig: WebPushConfig;
  webPushStore: WebPushStore;
}

function bodyOf(req: RouteRequest): Record<string, unknown> | null {
  return req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : null;
}

export function mountRefWebPushConfig(app: AppLike, ctx: MountRefWebPushContext): void {
  // Operator-visible VAPID-status surface. Returns the public key only
  // when web push is configured; otherwise reports the static reason.
  app.get("/_ref/web-push/config", ctx.requireOwnerSession, (_req: RouteRequest, res: RouteResponse) => {
    res.json({
      object: "web_push_config",
      enabled: ctx.webPushConfig.enabled,
      public_key: ctx.webPushConfig.enabled ? ctx.webPushConfig.publicKey : null,
      unavailable_reason: ctx.webPushConfig.enabled ? null : ctx.webPushConfig.unavailableReason,
    });
  });
}

export function mountRefWebPushListSubscriptions(app: AppLike, ctx: MountRefWebPushContext): void {
  // List the operator's own subscriptions. Scoped by owner subject id so
  // multiple operator browsers register independently without leaking.
  app.get("/_ref/web-push/subscriptions", ctx.requireOwnerSession, async (req: RouteRequest, res: RouteResponse) => {
    const ownerSubjectId = ctx.getOwnerSubjectId(req);
    res.json({
      object: "list",
      data: await ctx.webPushStore.list(ownerSubjectId),
      has_more: false,
    });
  });
}

export function mountRefWebPushCreateSubscription(app: AppLike, ctx: MountRefWebPushContext): void {
  // Register a Web Push subscription. The browser-side subscription
  // payload is required; metadata fields are best-effort hints used by
  // the operator console to label devices in the management view.
  app.post("/_ref/web-push/subscriptions", ctx.requireOwnerSession, async (req: RouteRequest, res: RouteResponse) => {
    try {
      if (!ctx.webPushConfig.enabled) {
        ctx.pdppError(res, 503, "web_push_unavailable", ctx.webPushConfig.unavailableReason);
        return;
      }
      const ownerSubjectId = ctx.getOwnerSubjectId(req);
      const body = bodyOf(req);
      // Matches the original `req.body?.subscription || req.body` shape:
      // accept either a top-level subscription envelope or the bare
      // browser-side subscription object.
      const subscription = body?.subscription || req.body;
      const platform = body && typeof body.platform === "string" ? body.platform : null;
      const deviceLabel = body && typeof body.device_label === "string" ? body.device_label : null;
      const record = await ctx.webPushStore.upsert(ownerSubjectId, subscription, {
        user_agent: req.get("user-agent") || null,
        platform,
        device_label: deviceLabel,
      });
      res.status(201).json({ object: "web_push_subscription", subscription: record });
    } catch (err) {
      const e = err as { status?: number; code?: string; message?: string } | null;
      if (e?.status === 400) {
        ctx.pdppError(res, 400, e.code || "invalid_request", e.message);
        return;
      }
      ctx.handleError(res, err);
    }
  });
}

export function mountRefWebPushDeleteSubscription(app: AppLike, ctx: MountRefWebPushContext): void {
  // Revoke by endpoint. The browser already knows its own endpoint URL,
  // so we accept it in the request body and let the store decide whether
  // a record existed to revoke (`deleted: boolean`).
  app.delete("/_ref/web-push/subscriptions", ctx.requireOwnerSession, async (req: RouteRequest, res: RouteResponse) => {
    const body = bodyOf(req);
    const endpoint = body && typeof body.endpoint === "string" ? body.endpoint : null;
    if (!endpoint) {
      ctx.pdppError(res, 400, "invalid_request", "endpoint is required");
      return;
    }
    const ownerSubjectId = ctx.getOwnerSubjectId(req);
    const revoked = await ctx.webPushStore.revoke(ownerSubjectId, endpoint);
    res.json({ object: "web_push_subscription_deleted", deleted: Boolean(revoked) });
  });
}

export function mountRefWebPushTest(app: AppLike, ctx: MountRefWebPushContext): void {
  // Operator "ping my browser" smoke check. Fan out a test notification
  // to every subscription owned by the requesting owner subject and
  // report counts. Best-effort: a transport failure marks that
  // subscription stale without failing the request.
  app.post("/_ref/web-push/test", ctx.requireOwnerSession, async (req: RouteRequest, res: RouteResponse) => {
    try {
      if (!ctx.webPushConfig.enabled) {
        ctx.pdppError(res, 503, "web_push_unavailable", ctx.webPushConfig.unavailableReason);
        return;
      }
      const ownerSubjectId = ctx.getOwnerSubjectId(req);
      const result = await ctx.fanoutTestWebPush({
        config: ctx.webPushConfig,
        store: ctx.webPushStore,
        ownerSubjectId,
      });
      res.json({
        object: "web_push_test_notification",
        attempted: result.attempted,
        sent: result.sent,
        unavailable: Boolean(result.unavailable),
      });
    } catch (err) {
      ctx.handleError(res, err);
    }
  });
}
