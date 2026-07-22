// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the reference-only `/_ref/{traces,grants,runs}`
// detail / timeline endpoints.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family` (§2.2 detail/timeline
// sub-bullet). Each `mount...` function registers one route at the same
// point in registration order where `server/index.js` previously
// registered it inline. Owner-session posture, query-string parsing
// (limit/cursor with the 400 error shape and upper bound), 404-on-empty-
// first-page, and `invalid_cursor` discrimination on the catch path are
// unchanged.
//
// The canonical `ref.spine.events.page` operation (see
// `operations/ref-spine-events-page`) owns the envelope shape and the
// live-bearer redaction. This adapter owns owner-auth, query-string
// parsing, the host-side spine read, and error→HTTP mapping.

import { InvalidCursorError } from "../../lib/db.ts";
import {
  executeRefSpineEventsPage,
  type RefSpineEventsKind,
  type RefSpineEventsPageInputPagination,
  type RefSpineRunTerminalStatus,
} from "../../operations/ref-spine-events-page/index.ts";
import type { MiddlewareHandler, PdppErrorFn } from "./_route-contract.ts";

// Express-shaped surface, structurally typed to avoid pulling in the
// transport's `.js` ambient types. Matches the pattern established in
// `server/routes/ref-spine-correlations.ts`.

interface RouteRequest {
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, unknown>>;
}

interface RouteResponse {
  json(body: unknown): unknown;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get(path: string, ...handlers: (MiddlewareHandler | RouteHandler)[]): AppLike;
}

interface TimelinePageOptions {
  readonly cursor: string | null;
  readonly limit: number;
}

export interface MountRefSpineTimelinesContext {
  /**
   * Window-independent terminal-status lookup for the run kind. Resolves
   * the run's most-recent terminal event via the bounded `LIMIT 1` query;
   * returns `null` when the run has no terminal event. Only invoked for
   * `kind === "run"` (trace/grant timelines have no terminal status).
   */
  getRunTerminalStatus(runId: string): Promise<RefSpineRunTerminalStatus | null> | RefSpineRunTerminalStatus | null;
  handleError(res: unknown, err: unknown): void;
  listSpineEventsPage(
    kind: RefSpineEventsKind,
    id: string,
    opts: TimelinePageOptions
  ): Promise<RefSpineEventsPageInputPagination> | RefSpineEventsPageInputPagination;
  pdppError: PdppErrorFn;
  requireOwnerSession: MiddlewareHandler;
}

// Mirrors the inline limit policy that previously lived at module scope
// in `server/index.js`. Default fits every observed real-world timeline;
// the upper bound prevents pathological reads while keeping the cap well
// above the largest observed run (2,542 events).
const TIMELINE_DEFAULT_LIMIT = 2000;
const TIMELINE_MAX_LIMIT = 5000;

// `parseTimelinePageOptions` matches the inline helper that previously
// lived in `server/index.js`. Cursor validation is a route-layer concern:
// an invalid `limit` must short-circuit (HTTP 400) before any operation
// runs. Returns `null` after writing the error response when validation
// fails; callers MUST `return` early in that case.
function parseTimelinePageOptions(
  req: RouteRequest,
  res: RouteResponse,
  pdppError: PdppErrorFn
): TimelinePageOptions | null {
  const rawLimit = req.query?.limit;
  let limit = TIMELINE_DEFAULT_LIMIT;
  if (rawLimit !== undefined && rawLimit !== null && rawLimit !== "") {
    const parsed = Number(rawLimit);
    if (!(Number.isFinite(parsed) && Number.isInteger(parsed)) || parsed <= 0) {
      pdppError(res, 400, "invalid_request", `limit must be a positive integer (got "${String(rawLimit)}")`, "limit");
      return null;
    }
    if (parsed > TIMELINE_MAX_LIMIT) {
      pdppError(res, 400, "invalid_request", `limit ${parsed} exceeds maximum ${TIMELINE_MAX_LIMIT}`, "limit");
      return null;
    }
    limit = parsed;
  }
  const rawCursor = req.query?.cursor;
  const cursor = typeof rawCursor === "string" && rawCursor.length > 0 ? rawCursor : null;
  return { limit, cursor };
}

function mountTimeline(
  app: AppLike,
  ctx: MountRefSpineTimelinesContext,
  routePath: string,
  kind: RefSpineEventsKind,
  idParamKey: string,
  notFoundMessage: string
): void {
  app.get(routePath, ctx.requireOwnerSession, async (req: RouteRequest, res: RouteResponse) => {
    try {
      // Express route matching guarantees the id param is present whenever
      // this handler fires (the path pattern requires a non-empty segment).
      // The string assertion preserves the original behaviour where
      // `decodeURIComponent(req.params[idParamKey])` is called directly.
      const id = decodeURIComponent(req.params[idParamKey] as string);
      const opts = parseTimelinePageOptions(req, res, ctx.pdppError);
      if (!opts) {
        return;
      }
      const page = await ctx.listSpineEventsPage(kind, id, opts);
      if (!(page.events.length || opts.cursor)) {
        ctx.pdppError(res, 404, "not_found", notFoundMessage);
        return;
      }
      // Window-independent run terminal status: resolved from the run's
      // most-recent terminal event (bounded `LIMIT 1`), NOT from this page.
      // Run kind only — trace/grant timelines have no terminal status.
      const terminalStatus = kind === "run" ? await ctx.getRunTerminalStatus(id) : null;
      const envelope = executeRefSpineEventsPage({
        kind,
        id,
        cursor: opts.cursor,
        page,
        terminalStatus,
      });
      res.json(envelope);
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        ctx.pdppError(res, 400, "invalid_cursor", err.message, "cursor");
        return;
      }
      ctx.handleError(res, err);
    }
  });
}

export function mountRefTraceTimeline(app: AppLike, ctx: MountRefSpineTimelinesContext): void {
  mountTimeline(app, ctx, "/_ref/traces/:traceId", "trace", "traceId", "Trace not found");
}

export function mountRefGrantTimeline(app: AppLike, ctx: MountRefSpineTimelinesContext): void {
  mountTimeline(app, ctx, "/_ref/grants/:grantId/timeline", "grant", "grantId", "Grant timeline not found");
}

export function mountRefRunTimeline(app: AppLike, ctx: MountRefSpineTimelinesContext): void {
  mountTimeline(app, ctx, "/_ref/runs/:runId/timeline", "run", "runId", "Run timeline not found");
}
