"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import type { RefConnectorSummary, RefSchedule } from "../lib/ref-client.ts";
import { deleteScheduleAction, pauseScheduleAction, resumeScheduleAction, upsertScheduleAction } from "./actions.ts";

interface ScheduleRowProps {
  runsHref: string;
  summary: RefConnectorSummary;
}

type EditState = "idle" | "editing";

function formatInterval(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m`;
  }
  if (seconds < 86_400) {
    return `${Math.round(seconds / 3600)}h`;
  }
  return `${Math.round(seconds / 86_400)}d`;
}

function formatIntervalForInput(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds % 3600 === 0) {
    return `${seconds / 3600}h`;
  }
  if (seconds % 60 === 0) {
    return `${seconds / 60}m`;
  }
  return `${seconds}s`;
}

function recommendedIntervalLabel(policy: RefConnectorSummary["refresh_policy"]): string | null {
  if (!policy?.recommended_interval_seconds) {
    return null;
  }
  return formatInterval(policy.recommended_interval_seconds);
}

function modeLabel(mode: RefSchedule["effective_mode"]): string {
  if (mode === "automatic") {
    return "automatic";
  }
  if (mode === "paused") {
    return "paused";
  }
  return "manual";
}

function automationModeLabel(mode: RefSchedule["automation_mode"]): string {
  if (mode === "unattended") return "unattended";
  if (mode === "assisted") return "assisted";
  if (mode === "ask_before_run") return "ask before run";
  return "manual only";
}

export function ScheduleRow({ summary, runsHref }: ScheduleRowProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editState, setEditState] = useState<EditState>("idle");
  const [every, setEvery] = useState(() =>
    summary.schedule ? formatIntervalForInput(summary.schedule.interval_seconds) : "1h"
  );
  const [jitter, setJitter] = useState(() =>
    summary.schedule?.jitter_seconds ? formatIntervalForInput(summary.schedule.jitter_seconds) : ""
  );
  const [toast, setToast] = useState<{ kind: "error" | "warning"; message: string } | null>(null);

  const showToast = useCallback((kind: "error" | "warning", message: string) => {
    setToast({ kind, message });
    setTimeout(() => setToast(null), 8000);
  }, []);

  const handleSave = useCallback(() => {
    startTransition(async () => {
      const res = await upsertScheduleAction(summary.connector_id, {
        every,
        jitter: jitter || undefined,
        enabled: true,
      });
      if (!res.ok) {
        showToast("error", res.message);
        return;
      }
      if (res.policy_warning) {
        showToast("warning", res.policy_warning);
      }
      setEditState("idle");
      router.refresh();
    });
  }, [summary.connector_id, every, jitter, router, showToast]);

  const handlePause = useCallback(() => {
    startTransition(async () => {
      const res = await pauseScheduleAction(summary.connector_id);
      if (!res.ok) {
        showToast("error", res.message);
      }
      router.refresh();
    });
  }, [summary.connector_id, router, showToast]);

  const handleResume = useCallback(() => {
    startTransition(async () => {
      const res = await resumeScheduleAction(summary.connector_id);
      if (!res.ok) {
        showToast("error", res.message);
      }
      router.refresh();
    });
  }, [summary.connector_id, router, showToast]);

  const handleDelete = useCallback(() => {
    startTransition(async () => {
      const res = await deleteScheduleAction(summary.connector_id);
      if (!res.ok) {
        showToast("error", res.message);
      }
      router.refresh();
    });
  }, [summary.connector_id, router, showToast]);

  const schedule = summary.schedule;
  const policy = summary.refresh_policy;
  const displayName = summary.display_name || summary.connector_id;
  const activeRunId = schedule?.active_run_id;
  const needsHuman = schedule?.human_attention_needed ?? false;
  const recInterval = recommendedIntervalLabel(policy);
  const recMode = policy?.recommended_mode;
  const rationale = policy?.rationale;
  // Stale unsafe schedule: row persists as operator intent (`enabled=true`),
  // but the connector's current manifest policy makes automatic refresh
  // ineligible, so the scheduler skips it. Surface the reason instead of
  // implying the row is running.
  const ineligibilityReason = schedule?.ineligibility_reason ?? null;

  return (
    <li>
      <div className="flex flex-col gap-2 px-3 py-3 hover:bg-muted/40">
        {/* Top row: identity + mode + actions */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          {/* Identity */}
          <div className="min-w-0 flex-1">
            <Link
              className="pdpp-body font-medium text-foreground hover:underline"
              href={`/dashboard/records/${encodeURIComponent(summary.connector_id)}`}
            >
              {displayName}
            </Link>
            <div className="pdpp-caption mt-0.5 truncate font-mono text-muted-foreground">{summary.connector_id}</div>
          </div>

          {/* Status + action buttons */}
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {ineligibilityReason && (
              <span
                className="pdpp-caption rounded-full bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
                title={ineligibilityReason}
              >
                not runnable
              </span>
            )}
            {needsHuman && (
              <span className="pdpp-caption rounded-full bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
                needs human input
              </span>
            )}
            {activeRunId && (
              <Link
                className="pdpp-caption text-blue-600 underline-offset-2 hover:underline"
                href={`${runsHref}/${encodeURIComponent(activeRunId)}`}
              >
                running →
              </Link>
            )}
            {schedule ? (
              <>
                {schedule.enabled ? (
                  <Button disabled={isPending} onClick={handlePause} size="sm" variant="outline">
                    Pause
                  </Button>
                ) : (
                  <Button disabled={isPending} onClick={handleResume} size="sm" variant="outline">
                    Resume
                  </Button>
                )}
                <Button
                  disabled={isPending}
                  onClick={() => {
                    setEvery(formatIntervalForInput(schedule.interval_seconds));
                    setJitter(schedule.jitter_seconds ? formatIntervalForInput(schedule.jitter_seconds) : "");
                    setEditState(editState === "editing" ? "idle" : "editing");
                  }}
                  size="sm"
                  variant="outline"
                >
                  Edit
                </Button>
                <Button disabled={isPending} onClick={handleDelete} size="sm" variant="outline">
                  Delete
                </Button>
              </>
            ) : (
              <Button disabled={isPending} onClick={() => setEditState("editing")} size="sm" variant="outline">
                Set schedule
              </Button>
            )}
          </div>
        </div>

        {/* Stats row */}
        <div className="pdpp-caption flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
          {schedule ? (
            <>
              <span>
                Mode: <span className="text-foreground">{modeLabel(schedule.effective_mode)}</span>
              </span>
              <span title={schedule.automation_summary}>
                Automation: <span className="text-foreground">{automationModeLabel(schedule.automation_mode)}</span>
              </span>
              <span>
                Every: <span className="text-foreground tabular-nums">{formatInterval(schedule.interval_seconds)}</span>
              </span>
            </>
          ) : (
            <span>No schedule</span>
          )}
          {recMode && (
            <span>
              Recommended:{" "}
              <span className="text-foreground">
                {recMode}
                {recInterval ? ` · ${recInterval}` : ""}
              </span>
            </span>
          )}
          {summary.last_successful_run && (
            <span>
              Last success: <Timestamp value={summary.last_successful_run.last_at} />
            </span>
          )}
          {schedule?.last_started_at && !summary.last_successful_run && (
            <span>
              Last attempt: <Timestamp value={schedule.last_started_at} />
            </span>
          )}
          <span>{summary.total_records.toLocaleString()} records</span>
        </div>

        {/* Ineligibility reason: stale enabled row + manifest policy changed */}
        {ineligibilityReason && (
          <p className="pdpp-caption text-amber-700 dark:text-amber-400">
            <strong>Not running automatically.</strong> {ineligibilityReason} Manual run remains available; pause or delete this
            schedule to reflect operator intent.
          </p>
        )}

        {/* Recommended rationale */}
        {rationale && <p className="pdpp-caption text-muted-foreground italic">{rationale}</p>}

        {/* Minimum-interval warning from last save */}
        {schedule?.minimum_interval_warning && (
          <p className="pdpp-caption text-amber-700 dark:text-amber-400">{schedule.minimum_interval_warning}</p>
        )}

        {/* Inline editor */}
        {editState === "editing" && (
          <ScheduleEditor
            every={every}
            isPending={isPending}
            jitter={jitter}
            onCancel={() => setEditState("idle")}
            onEveryChange={setEvery}
            onJitterChange={setJitter}
            onSave={handleSave}
            policy={policy}
            rationale={rationale}
            recInterval={recInterval}
          />
        )}

        {/* Inline toast */}
        {toast && (
          <p
            aria-live="polite"
            className={
              toast.kind === "error"
                ? "pdpp-caption text-destructive"
                : "pdpp-caption text-amber-700 dark:text-amber-400"
            }
            role="status"
          >
            {toast.message}
          </p>
        )}
      </div>
    </li>
  );
}

function frictionWarning(policy: RefConnectorSummary["refresh_policy"]): string | null {
  if (!policy) {
    return null;
  }
  if (policy.background_safe === false || (policy.interaction_posture && policy.interaction_posture !== "none")) {
    if (policy.interaction_posture === "otp_likely") {
      return "This connector typically requires an OTP or manual login. Frequent automatic runs will keep prompting for it.";
    }
    if (policy.interaction_posture === "manual_action_likely") {
      return "This connector typically requires manual browser steps. Automatic background runs will pause until you provide input.";
    }
    return "This connector requires credentials. Consider a longer interval to avoid re-authentication prompts.";
  }
  return null;
}

function ScheduleEditor({
  every,
  isPending,
  jitter,
  onCancel,
  onEveryChange,
  onJitterChange,
  onSave,
  policy,
  rationale,
  recInterval,
}: {
  every: string;
  isPending: boolean;
  jitter: string;
  onCancel: () => void;
  onEveryChange: (v: string) => void;
  onJitterChange: (v: string) => void;
  onSave: () => void;
  policy: RefConnectorSummary["refresh_policy"];
  rationale: string | null | undefined;
  recInterval: string | null;
}) {
  const warning = frictionWarning(policy);
  return (
    <div className="mt-1 flex flex-col gap-3 rounded-md border border-border/80 bg-muted/30 px-3 py-3">
      {warning && (
        <div className="pdpp-caption rounded border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          <strong>High friction connector.</strong> {warning}
          {rationale ? ` ${rationale}` : ""}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="pdpp-eyebrow text-muted-foreground">
            Every
            {policy?.recommended_interval_seconds ? ` (recommended: ${recInterval})` : ""}
          </span>
          <input
            className="pdpp-caption w-24 rounded border border-border bg-background px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary"
            onChange={(e) => onEveryChange(e.target.value)}
            placeholder="e.g. 30m"
            type="text"
            value={every}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="pdpp-eyebrow text-muted-foreground">Jitter (optional)</span>
          <input
            className="pdpp-caption w-20 rounded border border-border bg-background px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary"
            onChange={(e) => onJitterChange(e.target.value)}
            placeholder="e.g. 5m"
            type="text"
            value={jitter}
          />
        </label>
        <div className="flex gap-2">
          <Button disabled={isPending} onClick={onSave} size="sm">
            Save
          </Button>
          <Button disabled={isPending} onClick={onCancel} size="sm" variant="outline">
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
