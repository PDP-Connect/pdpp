"use server";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { revalidatePath } from "next/cache";
import { requireDashboardAccess } from "../../lib/dashboard-access.ts";
import { type CancelRunOutcome, cancelRun, submitRunInteraction } from "../../lib/operator-runs.ts";
import { ReferenceServerUnreachableError } from "../../lib/owner-token.ts";

function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected interaction submission failure";
}

export interface RunInteractionActionState {
  error: string | null;
  status: "success" | "cancelled" | null;
}

export async function submitRunInteractionAction(
  _prev: RunInteractionActionState,
  formData: FormData
): Promise<RunInteractionActionState> {
  const runId = asString(formData.get("run_id"));
  if (!runId) {
    return { error: "Missing run_id", status: null };
  }
  await requireDashboardAccess(`/syncs/${encodeURIComponent(runId)}`);

  const interactionId = asString(formData.get("interaction_id"));
  const rawStatus = asString(formData.get("status"));
  const status = rawStatus === "success" || rawStatus === "cancelled" ? rawStatus : null;
  if (!(interactionId && status)) {
    return { error: "Missing interaction_id or status", status: null };
  }

  // Pull every other form field as interaction data. The form is schema-shaped
  // server-side so only declared fields ride along. Values are forwarded to
  // the runtime as the current INTERACTION_RESPONSE and not stored anywhere
  // durable on the dashboard side — no cookies, no logs, no localStorage.
  const data: Record<string, string> = {};
  if (status === "success") {
    for (const [key, value] of formData.entries()) {
      if (key === "run_id" || key === "interaction_id" || key === "status") {
        continue;
      }
      if (typeof value !== "string") {
        continue;
      }
      data[key] = value;
    }
  }

  try {
    await submitRunInteraction(runId, {
      data: Object.keys(data).length > 0 ? data : undefined,
      interactionId,
      status,
    });
  } catch (err) {
    return { error: errorMessage(err), status: null };
  }

  revalidatePath(`/syncs/${runId}`);
  return { error: null, status };
}

export type CancelRunActionResult =
  | { ok: true; status: CancelRunOutcome }
  | {
      ok: false;
      kind: "already_terminal" | "no_active_run" | "unreachable" | "error";
      message: string;
    };

/**
 * Owner-cancel the named run via `cancelRun`, then revalidate the run detail
 * route so the now-terminal status and the absence of the cancel control are
 * shown. Re-verifies dashboard access first (CVE-2025-29927: every Server
 * Action re-checks the session).
 *
 * The three documented outcomes surface as in-place messaging, not a route
 * error boundary: a `202` returns `{ ok: true }`; `409 run_already_terminal`
 * and `404 no_active_run` return `{ ok: false }` discriminated outcomes the
 * control reflects as "the run already reached a terminal state"; an
 * unreachable reference server returns a typed `unreachable` outcome.
 */
export async function cancelRunAction(runId: string): Promise<CancelRunActionResult> {
  const trimmed = runId.trim();
  if (!trimmed) {
    return { kind: "error", message: "Missing run_id", ok: false };
  }
  await requireDashboardAccess(`/syncs/${encodeURIComponent(trimmed)}`);

  let result: { status: CancelRunOutcome };
  try {
    result = await cancelRun(trimmed);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return { kind: "unreachable", message: err.message, ok: false };
    }
    return { kind: "error", message: errorMessage(err), ok: false };
  }

  // Always revalidate: on success the timeline gains a terminal event; on a
  // raced terminal the detail refreshes so the now-terminal status and the
  // absence of the cancel control are shown.
  revalidatePath(`/syncs/${trimmed}`);

  if (result.status === "run_already_terminal") {
    return { kind: "already_terminal", message: "This run already reached a terminal state.", ok: false };
  }
  if (result.status === "no_active_run") {
    return { kind: "no_active_run", message: "This run already reached a terminal state.", ok: false };
  }
  return { ok: true, status: result.status };
}
