// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the reference-only owner run-cancellation control surface.
//
// One route:
//   POST /_ref/runs/:runId/cancel — owner-only, requests cooperative
//     cancellation of a single active controller-managed run. This is NOT a
//     public PDPP protocol endpoint; it is reference/operator control. It
//     stops only the targeted run, preserves already-collected records, and
//     does not affect sibling runs, schedules, grants, or connections.
//
// The controller aborts only the targeted run's cancel signal; the runtime
// emits `run.cancel_requested` and terminates that connector child, then
// records a terminal `run.cancelled` event when the child exits. The route
// acknowledges the request asynchronously (the run ends on the spine
// timeline), mirroring how run-now returns before a run completes.
//
// See openspec/changes/add-owner-run-cancellation-control.

import type { MiddlewareHandler, PdppErrorFn } from "./_route-contract.ts";

interface RouteRequest {
  readonly ownerSession?: { readonly sub?: string | null } | null;
  readonly params: Readonly<Record<string, string>>;
}

interface RouteResponse {
  json: (body: unknown) => unknown;
  status: (code: number) => RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  post: (path: string, ...args: (MiddlewareHandler | RouteHandler)[]) => AppLike;
}

export interface RunCancelResult {
  readonly run_id: string;
  readonly status: string;
}

export interface RunCancelController {
  cancelRun: (runId: string, requestingOwnerSubjectId: string) => Promise<RunCancelResult> | RunCancelResult;
}

export interface MountRefRunCancelContext {
  cancelRun?: (runId: string, requestingOwnerSubjectId: string) => Promise<RunCancelResult> | RunCancelResult;
  readonly controller: RunCancelController | null | undefined;
  handleError: (res: unknown, err: unknown) => void;
  /** Fallback subject when no owner session is attached to the request (matches the rest of the owner-session-optional surface). */
  readonly ownerSubjectId: string;
  pdppError: PdppErrorFn;
  requireOwnerSession: MiddlewareHandler;
}

// Maps a controller cancel-run outcome onto the route's HTTP response.
function respondToCancelOutcome(
  res: RouteResponse,
  ctx: Pick<MountRefRunCancelContext, "pdppError">,
  runId: string,
  result: RunCancelResult
): unknown {
  if (result.status === "no_active_run") {
    return ctx.pdppError(res, 404, "no_active_run", `No active run with id: ${runId}`, "run_id");
  }
  if (result.status === "already_terminal") {
    return ctx.pdppError(
      res,
      409,
      "run_already_terminal",
      `Run ${runId} has already reached a terminal state`,
      "run_id"
    );
  }
  return res.status(202).json({
    object: "run_cancel_ack",
    run_id: runId,
    status: result.status,
  });
}

// Requests cancellation for one run, preferring the route-level `cancelRun`
// override (used by callers that need to reach a scheduler-owned run the
// controller itself does not track) over the controller's own cancelRun.
function requestRunCancellation(
  ctx: Pick<MountRefRunCancelContext, "cancelRun" | "controller">,
  runId: string,
  requestingOwnerSubjectId: string
): Promise<RunCancelResult> | RunCancelResult {
  if (ctx.cancelRun) {
    return ctx.cancelRun(runId, requestingOwnerSubjectId);
  }
  // Guarded by the caller: ctx.controller.cancelRun is confirmed callable
  // before requestRunCancellation is invoked.
  return (ctx.controller as RunCancelController).cancelRun(runId, requestingOwnerSubjectId);
}

// True when a controller is wired up and exposes a callable cancelRun.
function hasCallableCancelRunController(ctx: Pick<MountRefRunCancelContext, "controller">): boolean {
  return Boolean(ctx.controller) && typeof ctx.controller?.cancelRun === "function";
}

export function mountRefRunCancel(app: AppLike, ctx: MountRefRunCancelContext): void {
  app.post("/_ref/runs/:runId/cancel", ctx.requireOwnerSession, async (req: RouteRequest, res: RouteResponse) => {
    try {
      if (!hasCallableCancelRunController(ctx)) {
        return ctx.pdppError(res, 404, "not_found", "Controller is not configured on this server");
      }
      const runId = decodeURIComponent(req.params.runId as string);
      const requestingOwnerSubjectId = req.ownerSession?.sub ?? ctx.ownerSubjectId;
      const result = await requestRunCancellation(ctx, runId, requestingOwnerSubjectId);
      return respondToCancelOutcome(res, ctx, runId, result);
    } catch (err) {
      return ctx.handleError(res, err);
    }
  });
}
