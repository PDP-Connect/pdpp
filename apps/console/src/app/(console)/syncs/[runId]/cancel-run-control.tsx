// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { IcButton } from "@pdpp/brand-react";
import { Callout } from "@pdpp/operator-ui/components/primitives";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { type CancelRunActionResult, cancelRunAction } from "./actions.ts";

/**
 * Active-run-only **Cancel run** control for the run detail page.
 *
 * The page renders this only while the run is active (no terminal spine
 * event); see `add-console-run-cancel-control`. The control:
 *   - requires an explicit confirmation step before issuing the cancel — the
 *     first click reveals a confirm/back pair; it never cancels on first click;
 *   - states it stops ONLY the current run and preserves already-collected
 *     records, the connection's schedule, grants, and configuration — distinct
 *     from revoking (stop future collection) or deleting (erase the past);
 *   - reflects the three outcomes honestly: a `202` shows "cancellation
 *     requested — the run will stop shortly"; a raced `409 run_already_terminal`
 *     / `404 no_active_run` shows that the run already reached a terminal state
 *     and refreshes the detail so the now-terminal status (and the absence of
 *     this control) are shown.
 *
 * Non-destructive: this never touches records, the schedule, grants, or the
 * connection — identical to the reference route's guarantees.
 */
export function CancelRunControl({ runId }: { runId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<CancelRunActionResult | null>(null);

  function handleConfirm() {
    startTransition(async () => {
      const next = await cancelRunAction(runId);
      setResult(next);
      setConfirming(false);
      // On a 202 the run gains a terminal event shortly; on a raced terminal
      // (409/404) the run is already terminal. Either way, refresh so the
      // detail re-renders with the terminal status and drops this control.
      if (next.ok || next.kind === "already_terminal" || next.kind === "no_active_run") {
        router.refresh();
      }
    });
  }

  const message = result ? outcomeMessage(result) : null;
  const messageTone = result?.ok ? "text-muted-foreground" : "text-destructive";

  return (
    <Callout
      className="mb-6"
      description="Cancelling stops only the current run. Already-collected records, this connection's schedule, grants, and configuration are preserved. This is not the same as revoking the connection (which stops future collection) or deleting it (which erases the data already collected)."
      surface="neutral"
      title="Cancel run"
    >
      {message ? (
        <p className={`pdpp-caption mb-2 ${messageTone}`} role={result?.ok ? "status" : "alert"}>
          {message}
        </p>
      ) : null}
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="pdpp-caption text-foreground">Cancel this run? This stops only the current run.</p>
          <div className="flex flex-wrap gap-2">
            <IcButton disabled={isPending} onClick={handleConfirm} size="sm" type="button" variant="destructive">
              {isPending ? "Cancelling…" : "Yes, cancel run"}
            </IcButton>
            <IcButton disabled={isPending} onClick={() => setConfirming(false)} size="sm" type="button" variant="ghost">
              Keep running
            </IcButton>
          </div>
        </div>
      ) : (
        <IcButton
          disabled={isPending}
          onClick={() => {
            setResult(null);
            setConfirming(true);
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel run
        </IcButton>
      )}
    </Callout>
  );
}

function outcomeMessage(result: CancelRunActionResult): string {
  if (result.ok) {
    return "Cancellation requested — the run will stop shortly.";
  }
  if (result.kind === "already_terminal" || result.kind === "no_active_run") {
    return "This run already reached a terminal state.";
  }
  return result.message;
}
