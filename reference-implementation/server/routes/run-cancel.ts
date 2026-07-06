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
  readonly params: Readonly<Record<string, string>>;
}

interface RouteResponse {
  json(body: unknown): unknown;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  post(path: string, ...args: (MiddlewareHandler | RouteHandler)[]): AppLike;
}

export interface RunCancelResult {
  readonly run_id: string;
  readonly status: string;
}

export interface RunCancelController {
  cancelRun(runId: string): Promise<RunCancelResult> | RunCancelResult;
}

export interface MountRefRunCancelContext {
  cancelRun?(runId: string): Promise<RunCancelResult> | RunCancelResult;
  readonly controller: RunCancelController | null | undefined;
  handleError(res: unknown, err: unknown): void;
  pdppError: PdppErrorFn;
  requireOwnerSession: MiddlewareHandler;
}

export function mountRefRunCancel(app: AppLike, ctx: MountRefRunCancelContext): void {
  app.post("/_ref/runs/:runId/cancel", ctx.requireOwnerSession, async (req: RouteRequest, res: RouteResponse) => {
    try {
      if (!ctx.controller || typeof ctx.controller.cancelRun !== "function") {
        return ctx.pdppError(res, 404, "not_found", "Controller is not configured on this server");
      }
      const runId = decodeURIComponent(req.params.runId as string);
      const result = await (ctx.cancelRun ? ctx.cancelRun(runId) : ctx.controller.cancelRun(runId));
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
    } catch (err) {
      return ctx.handleError(res, err);
    }
  });
}
