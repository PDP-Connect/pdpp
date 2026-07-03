// HTTP adapter for the reference-only owner run-handle status surface.
//
// One route:
//   GET /_ref/runs/:runId — owner-only, resolves a run identifier (the
//     handle returned by run-now 202 acks and scheduler projections) to its
//     current status for the run's WHOLE lifecycle:
//
//       - active: the controller's in-process active-run bookkeeping still
//         owns the run (registered before the 202 is returned, cleared when
//         the run settles);
//       - terminal: the run's most-recent terminal spine event
//         (`run.completed` / `run.failed` / `run.cancelled` /
//         `run.abandoned`), window-independent and durable;
//       - started-but-unresolved: a `run.started` event exists with no
//         terminal event and no in-process owner (e.g. the server died
//         mid-run and boot reconciliation has not landed yet) — reported as
//         `active` because no terminal event has been recorded;
//       - unknown: typed `not_found` 404 (never Express's default 404).
//
// This closes the "202 then 404" contract break from the vanished-run
// diagnosis (tmp/workstreams/vanished-run-diagnosis-2026-06-10.md): the
// `controller_active_runs` table is flight state only, so a fast-failing
// run was unresolvable seconds after its 202 unless the caller already knew
// the timeline envelope. Failure fields surfaced here are the typed,
// bounded values the runtime stamped on the terminal event (reason,
// failure origin, bounded messages) — the same owner-session posture and
// payload the `/_ref/runs/:runId/timeline` surface already exposes; no raw
// connector stderr, secrets, or tokens are added.
//
// See openspec/changes/surface-run-handle-resolvability.

import type { MiddlewareHandler, PdppErrorFn } from "./_route-contract.ts";

interface RouteRequest {
  readonly params: Readonly<Record<string, string>>;
}

interface RouteResponse {
  json(body: unknown): unknown;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get(path: string, ...handlers: (MiddlewareHandler | RouteHandler)[]): AppLike;
}

/** Structural slice of the controller's `ActiveRun` projection. */
export interface RunStatusActiveRun {
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly run_id: string;
  readonly started_at: string;
  readonly trace_id: string;
}

export interface RunStatusController {
  findActiveRunByRunId(runId: string): RunStatusActiveRun | null;
}

/** Structural slice of `lib/spine.ts` `RunLifecycleEventSummary`. */
export interface RunStatusLifecycleEvent {
  readonly actor_id: string | null;
  readonly data: Readonly<Record<string, unknown>> | null;
  readonly event_type: string;
  readonly occurred_at: string | null;
  readonly status?: string | null;
  readonly trace_id: string | null;
}

export type RunStatusTerminalEvent = RunStatusLifecycleEvent & {
  readonly status: "completed" | "failed" | "cancelled" | "abandoned";
};

export type BrowserSurfaceRunStatus =
  | "cancelled"
  | "deferred"
  | "expired"
  | "leased"
  | "released"
  | "starting_surface"
  | "surface_failed"
  | "waiting_for_browser_surface";

export interface MountRefRunStatusContext {
  readonly controller: RunStatusController | null | undefined;
  getLatestRunEvent?(runId: string): Promise<RunStatusLifecycleEvent | null> | RunStatusLifecycleEvent | null;
  getRunStartedEvent(runId: string): Promise<RunStatusLifecycleEvent | null> | RunStatusLifecycleEvent | null;
  getRunTerminalEvent(runId: string): Promise<RunStatusTerminalEvent | null> | RunStatusTerminalEvent | null;
  handleError(res: unknown, err: unknown): void;
  pdppError: PdppErrorFn;
  requireOwnerSession: MiddlewareHandler;
}

export interface RunStatusFailureSummary {
  readonly connector_error_message: string | null;
  readonly message: string | null;
  readonly origin: string | null;
  readonly reason: string | null;
}

export interface RunStatusBody {
  readonly completed_at: string | null;
  readonly connector_id: string | null;
  readonly connector_instance_id: string | null;
  readonly failure: RunStatusFailureSummary | null;
  readonly links: { readonly timeline: string };
  readonly object: "run_status";
  readonly run_id: string;
  readonly started_at: string | null;
  readonly status: "active" | "completed" | "failed" | "cancelled" | "abandoned" | BrowserSurfaceRunStatus;
  readonly terminal_reason: string | null;
  readonly trace_id: string | null;
}

function timelineLink(runId: string): { timeline: string } {
  return { timeline: `/_ref/runs/${encodeURIComponent(runId)}/timeline` };
}

function readString(data: Readonly<Record<string, unknown>> | null, key: string): string | null {
  const value = data?.[key];
  return typeof value === "string" && value ? value : null;
}

function browserSurfaceProjection(event: RunStatusLifecycleEvent | null): Readonly<Record<string, unknown>> | null {
  const value = event?.data?.browser_surface;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function readBrowserSurfaceStatus(event: RunStatusLifecycleEvent | null): BrowserSurfaceRunStatus | null {
  const value = browserSurfaceProjection(event)?.browser_surface_status;
  return typeof value === "string" && value ? (value as BrowserSurfaceRunStatus) : null;
}

function readBrowserSurfaceReason(event: RunStatusLifecycleEvent | null): string | null {
  const value = browserSurfaceProjection(event)?.browser_surface_wait_reason;
  return typeof value === "string" && value ? value : null;
}

function readBrowserSurfaceConnectionId(event: RunStatusLifecycleEvent | null): string | null {
  const profileKey = browserSurfaceProjection(event)?.browser_surface_profile_key;
  if (typeof profileKey !== "string" || !profileKey) {
    return null;
  }
  const suffix = profileKey.split(":").at(-1);
  return suffix?.startsWith("cin_") ? suffix : null;
}

// Connector identity on spine-resolved runs: run lifecycle events stamp the
// connector id as `actor_id` and as `data.source.id` ({ kind: "connector" }).
function readConnectorId(event: RunStatusLifecycleEvent | null): string | null {
  if (!event) {
    return null;
  }
  if (event.actor_id) {
    return event.actor_id;
  }
  const source = event.data?.source;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const id = (source as Record<string, unknown>).id;
    if (typeof id === "string" && id) {
      return id;
    }
  }
  return null;
}

// Typed failure summary for failed/abandoned terminals. Values are the
// runtime-authored, bounded fields already persisted on the terminal spine
// event (`buildRunTerminalData` / the controller's launch-failure emit) —
// no new secret surface beyond what the timeline route serves.
function buildFailureSummary(terminal: RunStatusTerminalEvent): RunStatusFailureSummary | null {
  if (terminal.status !== "failed" && terminal.status !== "abandoned") {
    return null;
  }
  return {
    connector_error_message: readString(terminal.data, "connector_error_message"),
    message: readString(terminal.data, "failure_message") ?? readString(terminal.data, "message"),
    origin: readString(terminal.data, "failure_origin"),
    reason: readString(terminal.data, "reason") ?? readString(terminal.data, "failure_reason"),
  };
}

export function buildTerminalRunStatusBody(
  runId: string,
  terminal: RunStatusTerminalEvent,
  started: RunStatusLifecycleEvent | null
): RunStatusBody {
  return {
    completed_at: terminal.occurred_at,
    connector_id: readConnectorId(started) ?? readConnectorId(terminal),
    // The spine does not carry the connection (connector-instance) id;
    // it is only known while the controller's flight state owns the run.
    connector_instance_id: null,
    failure: buildFailureSummary(terminal),
    links: timelineLink(runId),
    object: "run_status",
    run_id: runId,
    started_at: started?.occurred_at ?? null,
    status: terminal.status,
    terminal_reason: readString(terminal.data, "reason") ?? readString(terminal.data, "failure_reason"),
    trace_id: started?.trace_id ?? terminal.trace_id,
  };
}

export function buildActiveRunStatusBody(active: RunStatusActiveRun): RunStatusBody {
  return {
    completed_at: null,
    connector_id: active.connector_id,
    connector_instance_id: active.connector_instance_id,
    failure: null,
    links: timelineLink(active.run_id),
    object: "run_status",
    run_id: active.run_id,
    started_at: active.started_at,
    status: "active",
    terminal_reason: null,
    trace_id: active.trace_id,
  };
}

function buildStartedOnlyRunStatusBody(runId: string, started: RunStatusLifecycleEvent): RunStatusBody {
  // `run.started` exists but no terminal event and no in-process owner —
  // the honest projection is "no terminal recorded yet"; boot reconciliation
  // will convert orphans to a terminal `run.failed` on the next start.
  return {
    completed_at: null,
    connector_id: readConnectorId(started),
    connector_instance_id: null,
    failure: null,
    links: timelineLink(runId),
    object: "run_status",
    run_id: runId,
    started_at: started.occurred_at,
    status: "active",
    terminal_reason: null,
    trace_id: started.trace_id,
  };
}

function buildBrowserSurfaceRunStatusBody(runId: string, event: RunStatusLifecycleEvent): RunStatusBody | null {
  if (!event.event_type.startsWith("run.browser_surface_")) {
    return null;
  }
  const fallbackStatus =
    typeof event.status === "string" && event.status ? (event.status as BrowserSurfaceRunStatus) : null;
  const surfaceStatus = readBrowserSurfaceStatus(event) ?? fallbackStatus;
  if (!surfaceStatus) {
    return null;
  }
  const terminal =
    surfaceStatus === "cancelled" ||
    surfaceStatus === "deferred" ||
    surfaceStatus === "expired" ||
    surfaceStatus === "released" ||
    surfaceStatus === "surface_failed";
  const reason = readBrowserSurfaceReason(event);
  return {
    completed_at: terminal ? event.occurred_at : null,
    connector_id: readConnectorId(event),
    connector_instance_id: readBrowserSurfaceConnectionId(event),
    failure:
      surfaceStatus === "surface_failed"
        ? {
            connector_error_message: null,
            message: null,
            origin: "browser_surface",
            reason,
          }
        : null,
    links: timelineLink(runId),
    object: "run_status",
    run_id: runId,
    started_at: null,
    status: surfaceStatus,
    terminal_reason: terminal ? reason : null,
    trace_id: event.trace_id,
  };
}

export function mountRefRunStatus(app: AppLike, ctx: MountRefRunStatusContext): void {
  app.get("/_ref/runs/:runId", ctx.requireOwnerSession, async (req: RouteRequest, res: RouteResponse) => {
    try {
      const runId = decodeURIComponent(req.params.runId as string);

      // Durable truth first: once a terminal event exists it wins over any
      // not-yet-finalized in-memory flight state.
      const terminal = await ctx.getRunTerminalEvent(runId);
      if (terminal) {
        const browserSurfaceStatus = buildBrowserSurfaceRunStatusBody(runId, terminal);
        if (browserSurfaceStatus) {
          return res.json(browserSurfaceStatus);
        }
        const started = await ctx.getRunStartedEvent(runId);
        return res.json(buildTerminalRunStatusBody(runId, terminal, started));
      }

      const active = ctx.controller?.findActiveRunByRunId?.(runId) ?? null;
      if (active) {
        return res.json(buildActiveRunStatusBody(active));
      }

      const started = await ctx.getRunStartedEvent(runId);
      if (started) {
        return res.json(buildStartedOnlyRunStatusBody(runId, started));
      }

      const latest = (await ctx.getLatestRunEvent?.(runId)) ?? null;
      const browserSurfaceStatus = latest ? buildBrowserSurfaceRunStatusBody(runId, latest) : null;
      if (browserSurfaceStatus) {
        return res.json(browserSurfaceStatus);
      }

      return ctx.pdppError(res, 404, "not_found", `Run not found: ${runId}`, "run_id");
    } catch (err) {
      return ctx.handleError(res, err);
    }
  });
}
