/**
 * In-process delivery worker for outbound client event subscriptions.
 *
 * Tickable: each `tick()` claims due queue rows, attempts delivery via the
 * injected HTTP transport, logs the attempt, and transitions queue / row
 * state per the delivery operation outcome. A timer drives ticks in
 * production; tests call `tick()` directly so they don't race with timers.
 */

import {
  executeRecordDeliveryFailure,
  executeVerificationOutcome,
} from "../operations/as-client-event-subscriptions/index.ts";
import {
  type DeliveryDependencies,
  type DeliveryOutcome,
  executeDelivery,
} from "../operations/rs-client-event-deliver/index.ts";
import {
  claimDueQueue,
  getDefaultClientEventSubscriptionStore,
  insertAttempt,
  type QueueRow,
  updateQueueAttempt,
} from "./stores/client-event-subscription-store.ts";

export type HttpTransport = (req: {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}) => Promise<{
  statusCode: number | null;
  bodyText: string | null;
  errorMessage: string | null;
  latencyMs: number;
  responseHeaders?: Readonly<Record<string, string>>;
}>;

const RESPONSE_WINDOW_MS = 10_000;

export const defaultHttpTransport: HttpTransport = async ({ url, method, headers, body }) => {
  const start = Date.now();
  try {
    const resp = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(RESPONSE_WINDOW_MS) });
    const text = await resp.text();
    // Capture headers the operation layer needs for throttle scheduling.
    const responseHeaders: Record<string, string> = {};
    const retryAfter = resp.headers.get("retry-after");
    if (retryAfter != null) {
      responseHeaders["retry-after"] = retryAfter;
    }
    return {
      statusCode: resp.status,
      bodyText: text,
      errorMessage: null,
      latencyMs: Date.now() - start,
      responseHeaders,
    };
  } catch (err) {
    return {
      statusCode: null,
      bodyText: null,
      errorMessage: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
    };
  }
};

export interface DeliveryWorkerOptions {
  readonly nowMs?: () => number;
  readonly randomJitterFactor?: () => number;
  readonly tickIntervalMs?: number;
  readonly transport?: HttpTransport;
}

export interface DeliveryWorker {
  start(): void;
  stop(): void;
  tick(): Promise<{ readonly attempted: number; readonly outcomes: readonly DeliveryOutcome[] }>;
}

export function createDeliveryWorker(opts: DeliveryWorkerOptions = {}): DeliveryWorker {
  const nowMs = opts.nowMs ?? (() => Date.now());
  const transport = opts.transport ?? defaultHttpTransport;
  const interval = opts.tickIntervalMs ?? 5000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  const store = getDefaultClientEventSubscriptionStore();

  async function processOne(row: QueueRow): Promise<DeliveryOutcome> {
    const deliveryDeps: DeliveryDependencies = {
      nowSeconds: () => Math.floor(nowMs() / 1000),
      nowIso: () => new Date(nowMs()).toISOString(),
      request: transport,
      ...(opts.randomJitterFactor ? { randomJitterFactor: opts.randomJitterFactor } : {}),
    };
    const outcome = await executeDelivery(
      {
        queueId: row.queue_id,
        subscriptionId: row.subscription_id,
        eventId: row.event_id,
        eventType: row.event_type,
        payloadJson: row.payload_json,
        attemptCount: row.attempt_count,
        callbackUrl: row.callback_url,
        secret: row.secret_text,
        verificationChallenge: row.verification_challenge,
      },
      deliveryDeps
    );
    const attemptedAt = new Date(nowMs()).toISOString();

    if (outcome.kind === "delivered" || outcome.kind === "verified") {
      await insertAttempt(
        row.queue_id,
        attemptedAt,
        outcome.statusCode,
        true,
        outcome.latencyMs,
        null,
        outcome.bodyText
      );
      await updateQueueAttempt(row.queue_id, row.attempt_count + 1, attemptedAt, "delivered", null);
      if (outcome.kind === "verified") {
        await executeVerificationOutcome(row.subscription_id, "verified", {
          store,
          nowIso: () => attemptedAt,
        });
      }
    } else if (outcome.kind === "retry") {
      await insertAttempt(
        row.queue_id,
        attemptedAt,
        outcome.statusCode,
        false,
        outcome.latencyMs,
        outcome.error,
        outcome.bodyText
      );
      await updateQueueAttempt(row.queue_id, outcome.attemptCount, outcome.nextAttemptIso, "pending", outcome.error);
    } else if (outcome.kind === "throttle") {
      // Log the attempt but do NOT increment attempt_count — the delivery slot
      // is preserved. Reschedule at nextAttemptIso derived from retry-after.
      await insertAttempt(
        row.queue_id,
        attemptedAt,
        outcome.statusCode,
        false,
        outcome.latencyMs,
        outcome.error,
        outcome.bodyText
      );
      await updateQueueAttempt(row.queue_id, outcome.attemptCount, outcome.nextAttemptIso, "pending", outcome.error);
    } else if (outcome.kind === "permanent_failure") {
      // 410 Gone: disable the subscription immediately without consuming retry slots.
      await insertAttempt(
        row.queue_id,
        attemptedAt,
        outcome.statusCode,
        false,
        outcome.latencyMs,
        outcome.error,
        outcome.bodyText
      );
      await updateQueueAttempt(row.queue_id, outcome.attemptCount, attemptedAt, "final_failure", outcome.error);
      await executeRecordDeliveryFailure(row.subscription_id, {
        store,
        nowIso: () => attemptedAt,
      });
    } else {
      await insertAttempt(
        row.queue_id,
        attemptedAt,
        outcome.statusCode,
        false,
        outcome.latencyMs,
        outcome.error,
        outcome.bodyText
      );
      await updateQueueAttempt(row.queue_id, outcome.attemptCount, attemptedAt, "final_failure", outcome.error);
      await executeRecordDeliveryFailure(row.subscription_id, {
        store,
        nowIso: () => attemptedAt,
      });
    }
    return outcome;
  }
  // Classifies a queue row into one of three pre-delivery dispositions. The
  // table is the spec; this function makes the table local and exhaustive so
  // the tick loop only orchestrates I/O around it.
  type RowDisposition =
    | { kind: "deliver" }
    | { kind: "skip" }
    | { kind: "drop"; reason: "subscription_inactive" | "subscription_revoked" | "subscription_disabled" };

  function classifyRow(row: QueueRow): RowDisposition {
    if (row.subscription_status === "deleted") {
      return { kind: "drop", reason: "subscription_inactive" };
    }
    if (row.subscription_status === "disabled_revoked") {
      return row.event_type === "pdpp.grant.revoked"
        ? { kind: "deliver" }
        : { kind: "drop", reason: "subscription_revoked" };
    }
    if (row.subscription_status === "pending_verification") {
      return row.event_type === "pdpp.subscription.verify" ? { kind: "deliver" } : { kind: "skip" };
    }
    if (row.subscription_status === "disabled" || row.subscription_status === "disabled_failure") {
      return row.event_type === "pdpp.subscription.verify"
        ? { kind: "deliver" }
        : { kind: "drop", reason: "subscription_disabled" };
    }
    return { kind: "deliver" };
  }

  async function dropRow(row: QueueRow, reason: string): Promise<void> {
    await updateQueueAttempt(row.queue_id, row.attempt_count, new Date(nowMs()).toISOString(), "dropped", reason);
  }

  async function tickInternal(): Promise<{ attempted: number; outcomes: DeliveryOutcome[] }> {
    if (inFlight) {
      return { attempted: 0, outcomes: [] };
    }
    inFlight = true;
    try {
      const due = await claimDueQueue(new Date(nowMs()).toISOString());
      const outcomes: DeliveryOutcome[] = [];
      for (const row of due) {
        const disposition = classifyRow(row);
        if (disposition.kind === "skip") {
          continue;
        }
        if (disposition.kind === "drop") {
          await dropRow(row, disposition.reason);
          continue;
        }
        outcomes.push(await processOne(row));
      }
      return { attempted: outcomes.length, outcomes };
    } finally {
      inFlight = false;
    }
  }

  return {
    tick: tickInternal,
    start(): void {
      if (timer) {
        return;
      }
      timer = setInterval(() => {
        tickInternal().catch(() => {
          /* ignored; surfaced via attempt log */
        });
      }, interval);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

let defaultWorker: DeliveryWorker | null = null;
export function getDefaultDeliveryWorker(): DeliveryWorker {
  if (!defaultWorker) {
    defaultWorker = createDeliveryWorker();
  }
  return defaultWorker;
}
