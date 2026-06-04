import { type CancelRunResult, cancelRunErrorCode, classifyCancelRunResponse } from "./cancel-run-result.ts";
import { describeError } from "./describe-error.ts";
import { getAsInternalUrl, ReferenceServerUnreachableError, withOwnerSessionCookie } from "./owner-token.ts";

export type { CancelRunOutcome, CancelRunResult } from "./cancel-run-result.ts";

const DURATION_RE = /^(\d+)(s|m|h|d)?$/i;

function asJson(body: unknown) {
  return JSON.stringify(body);
}

function readBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return res.text();
}

async function fetchAs(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(
      `${getAsInternalUrl()}${path}`,
      await withOwnerSessionCookie({
        cache: "no-store",
        ...init,
      })
    );
  } catch (err) {
    throw new ReferenceServerUnreachableError(`Cannot reach authorization server at ${getAsInternalUrl()}`, err);
  }
}

function parseDurationInput(value: string, label: string): number {
  const trimmed = value.trim();
  const match = trimmed.match(DURATION_RE);
  if (!match) {
    throw new Error(`Invalid ${label} value '${trimmed}'. Use values like 30m, 60s, 2h, or 1d.`);
  }

  const amount = Number.parseInt(match[1] ?? "0", 10);
  const unit = (match[2] || "s").toLowerCase();
  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60,
  };
  const multiplier = multipliers[unit] ?? 1;
  return amount * multiplier;
}

function connectorControlPath(connectorId: string, suffix: string): string {
  return `/_ref/connectors/${encodeURIComponent(connectorId)}${suffix}`;
}

function connectionControlPath(connectionId: string, suffix: string): string {
  return `/_ref/connections/${encodeURIComponent(connectionId)}${suffix}`;
}

async function runNowAt(path: string) {
  const response = await fetchAs(path, {
    method: "POST",
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(describeError(body, `run-now failed (${response.status})`));
  }
  return body;
}

async function saveScheduleAt(
  path: string,
  input: {
    every: string;
    jitter?: string;
    enabled: boolean;
  }
) {
  const body = {
    interval_seconds: parseDurationInput(input.every, "schedule interval"),
    enabled: input.enabled,
    ...(input.jitter?.trim() ? { jitter_seconds: parseDurationInput(input.jitter, "schedule jitter") } : {}),
  };

  const response = await fetchAs(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: asJson(body),
  });
  const responseBody = await readBody(response);
  if (!response.ok) {
    throw new Error(describeError(responseBody, `schedule update failed (${response.status})`));
  }
  return responseBody;
}

async function postScheduleMutationAt(path: string, fallback: string) {
  const response = await fetchAs(path, {
    method: "POST",
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(describeError(body, `${fallback} (${response.status})`));
  }
  return body;
}

/**
 * Owner-set the connection's `display_name` via the owner-authenticated
 * `PATCH /_ref/connections/:connectorInstanceId` route. The route is gated
 * by `requireOwnerSession`; grant-scoped clients cannot reach it. The stable
 * selector remains the `connection_id` / `connector_instance_id` we PATCH —
 * the label is a human-facing alias, never a routing key.
 */
export async function setConnectionDisplayName(connectionId: string, displayName: string) {
  const response = await fetchAs(connectionControlPath(connectionId, ""), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: asJson({ display_name: displayName }),
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(describeError(body, `rename failed (${response.status})`));
  }
  return body;
}

export function runConnectorNow(connectorId: string) {
  return runNowAt(connectorControlPath(connectorId, "/run"));
}

export function runConnectionNow(connectionId: string) {
  return runNowAt(connectionControlPath(connectionId, "/run"));
}

export function saveConnectorSchedule(
  connectorId: string,
  input: {
    every: string;
    jitter?: string;
    enabled: boolean;
  }
) {
  return saveScheduleAt(connectorControlPath(connectorId, "/schedule"), input);
}

export function saveConnectionSchedule(
  connectionId: string,
  input: {
    every: string;
    jitter?: string;
    enabled: boolean;
  }
) {
  return saveScheduleAt(connectionControlPath(connectionId, "/schedule"), input);
}

export function pauseConnectorSchedule(connectorId: string) {
  return postScheduleMutationAt(connectorControlPath(connectorId, "/schedule/pause"), "schedule pause failed");
}

export function pauseConnectionSchedule(connectionId: string) {
  return postScheduleMutationAt(connectionControlPath(connectionId, "/schedule/pause"), "schedule pause failed");
}

export function resumeConnectorSchedule(connectorId: string) {
  return postScheduleMutationAt(connectorControlPath(connectorId, "/schedule/resume"), "schedule resume failed");
}

export function resumeConnectionSchedule(connectionId: string) {
  return postScheduleMutationAt(connectionControlPath(connectionId, "/schedule/resume"), "schedule resume failed");
}

/**
 * Answer the current pending interaction for a controller-managed run via
 * the reference-only `POST /_ref/runs/:runId/interaction` control surface.
 *
 * `data` satisfies the current run only. The reference server does NOT
 * persist it to `.env.local`, durable SQLite state, or timeline payloads.
 * Callers must not echo it back into cookies, logs, or durable state from
 * the dashboard side either.
 */
export async function submitRunInteraction(
  runId: string,
  input: {
    interactionId: string;
    status: "success" | "cancelled";
    data?: Record<string, unknown>;
  }
) {
  const payload: Record<string, unknown> = {
    interaction_id: input.interactionId,
    status: input.status,
  };
  if (input.status === "success" && input.data && Object.keys(input.data).length > 0) {
    payload.data = input.data;
  }
  const response = await fetchAs(`/_ref/runs/${encodeURIComponent(runId)}/interaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: asJson(payload),
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(describeError(body, `run interaction failed (${response.status})`));
  }
  return body;
}

/**
 * Mint a short-lived run-interaction streaming companion session for the
 * current pending interaction. The returned token is single-attach, scoped to
 * one (run, interaction, browser session), and invalidates when the
 * interaction resolves. The dashboard never persists this token — it is held
 * only in the viewer page state for the life of the stream.
 */
export interface StreamingSessionMintResponse {
  browser_session_id: string;
  expires_at_ms: number;
  /**
   * `true` when the server returned the cached session record for an
   * `idempotency_key` it had seen within the TTL window. Useful for tracing /
   * dev-tools telemetry; the response is otherwise identical to the original
   * mint, including the same single-use token.
   */
  idempotency_replayed?: boolean;
  input_path: string;
  interaction_id: string;
  object: "run_interaction_stream_session";
  run_id: string;
  token: string;
  viewer_path: string;
  viewport_path: string;
}

/**
 * Thrown when the reference server has no streaming companion configured. The
 * dashboard surfaces this as a configuration-pointer state instead of a
 * generic error so operators see what to set, not just "failed".
 */
export class StreamingCompanionUnavailableError extends Error {
  readonly code = "streaming_companion_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "StreamingCompanionUnavailableError";
  }
}

function isUnavailableErrorBody(body: unknown): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") {
    return false;
  }
  return (error as { code?: unknown }).code === "streaming_companion_unavailable";
}

export async function mintRunInteractionStream(
  runId: string,
  input: {
    /**
     * Stripe-style idempotency key. A duplicate mint with the same key within
     * the server's TTL window (60s) returns the same session record rather
     * than minting a fresh token and superseding the prior one. Pass a
     * client-generated UUID per logical "open browser" attempt.
     */
    idempotencyKey?: string;
    interactionId: string;
    viewport?: {
      width: number;
      height: number;
      deviceScaleFactor?: number;
      hasTouch?: boolean;
      mobile?: boolean;
      userAgent?: string;
    };
  }
): Promise<StreamingSessionMintResponse> {
  const payload: Record<string, unknown> = { interaction_id: input.interactionId };
  if (input.viewport) {
    payload.viewport = input.viewport;
  }
  if (input.idempotencyKey) {
    payload.idempotency_key = input.idempotencyKey;
  }
  const response = await fetchAs(`/_ref/runs/${encodeURIComponent(runId)}/run-interaction-stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: asJson(payload),
  });
  const body = await readBody(response);
  if (!response.ok) {
    if (response.status === 503 && isUnavailableErrorBody(body)) {
      throw new StreamingCompanionUnavailableError(describeError(body, "Streaming companion is not configured"));
    }
    throw new Error(describeError(body, `mint stream failed (${response.status})`));
  }
  return body as StreamingSessionMintResponse;
}

/**
 * Report a stream-reach give-up so the reference can record a
 * `run.stream_reach_failed` spine event. The payload carries only the typed
 * reason (the server clamps it to a closed set) and the HTTP status the client's
 * give-up probe observed — never the stream token, proxy cookie, or raw viewer
 * URL. This is a best-effort diagnostic beacon: the caller surfaces the operator
 * message from its own local classification regardless of whether this succeeds.
 */
export async function reportRunInteractionStreamReachFailure(
  runId: string,
  input: { interactionId: string; reason: string; httpStatus: number | null }
): Promise<void> {
  const response = await fetchAs(`/_ref/runs/${encodeURIComponent(runId)}/run-interaction-stream/reach-failure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: asJson({
      interaction_id: input.interactionId,
      reason: input.reason,
      http_status: input.httpStatus,
    }),
  });
  if (!response.ok) {
    const body = await readBody(response);
    throw new Error(describeError(body, `report stream reach failure failed (${response.status})`));
  }
}

/**
 * Owner-cancel a single active run via the owner-session reference route
 * `POST /_ref/runs/:runId/cancel` (shipped with
 * `add-owner-run-cancellation-control`). The owner-session cookie is attached
 * by `fetchAs`/`withOwnerSessionCookie`, matching the route's
 * `requireOwnerSession` gate.
 *
 * The route is non-destructive: it terminals only the named run as
 * `run.cancelled` and preserves already-collected records, the connection's
 * schedule, grants, and configuration. This wrapper does NOT change that — it
 * only requests the cancellation and maps the three documented outcomes to a
 * typed result so the caller can render outcome-specific copy instead of a
 * generic throw:
 *   - `202` → `cancel_requested`
 *   - `404 no_active_run` → `no_active_run` (run is no longer active)
 *   - `409 run_already_terminal` → `run_already_terminal` (raced to terminal)
 *
 * `ReferenceServerUnreachableError` (thrown by `fetchAs`) propagates unchanged,
 * exactly as the other run helpers leave it. Any other non-2xx status throws a
 * described error like the sibling helpers. The pure `(status, body, code)` →
 * outcome mapping lives in `cancel-run-result.ts` so it can be unit tested
 * under `node --test` without the server-only fetch helpers.
 */
export async function cancelRun(runId: string): Promise<CancelRunResult> {
  const response = await fetchAs(`/_ref/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
  });
  const body = await readBody(response);
  return classifyCancelRunResponse(response.status, body, cancelRunErrorCode(body));
}

export async function deleteConnectorSchedule(connectorId: string) {
  const response = await fetchAs(connectorControlPath(connectorId, "/schedule"), {
    method: "DELETE",
  });
  if (!response.ok && response.status !== 204) {
    const body = await readBody(response);
    throw new Error(describeError(body, `schedule delete failed (${response.status})`));
  }
}

export async function deleteConnectionSchedule(connectionId: string) {
  const response = await fetchAs(connectionControlPath(connectionId, "/schedule"), {
    method: "DELETE",
  });
  if (!response.ok && response.status !== 204) {
    const body = await readBody(response);
    throw new Error(describeError(body, `schedule delete failed (${response.status})`));
  }
}
