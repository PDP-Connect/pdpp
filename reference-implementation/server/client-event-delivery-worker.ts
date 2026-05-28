/**
 * In-process delivery worker for outbound client event subscriptions.
 *
 * Tickable: each `tick()` claims due queue rows, attempts delivery via the
 * injected HTTP transport, logs the attempt, and transitions queue / row
 * state per the delivery operation outcome. A timer drives ticks in
 * production; tests call `tick()` directly so they don't race with timers.
 */

import {
  executeDelivery,
  type DeliveryDependencies,
  type DeliveryOutcome,
} from "../operations/rs-client-event-deliver/index.ts";
import {
  executeRecordDeliveryFailure,
  executeVerificationOutcome,
} from "../operations/as-client-event-subscriptions/index.ts";
import {
  type QueueRow,
  claimDueQueue,
  getDefaultClientEventSubscriptionStore,
  insertAttempt,
  updateQueueAttempt,
} from "./stores/client-event-subscription-store.ts";

export interface HttpTransport {
  (req: {
    url: string;
    method: "POST";
    headers: Record<string, string>;
    body: string;
  }): Promise<{
    statusCode: number | null;
    bodyText: string | null;
    errorMessage: string | null;
    latencyMs: number;
  }>;
}

const RESPONSE_WINDOW_MS = 10_000;

export const defaultHttpTransport: HttpTransport = async ({ url, method, headers, body }) => {
  const start = Date.now();
  try {
    const resp = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(RESPONSE_WINDOW_MS) });
    const text = await resp.text();
    return {
      statusCode: resp.status,
      bodyText: text,
      errorMessage: null,
      latencyMs: Date.now() - start,
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
  readonly transport?: HttpTransport;
  readonly randomJitterFactor?: () => number;
  readonly tickIntervalMs?: number;
}

export interface DeliveryWorker {
  tick(): Promise<{ readonly attempted: number; readonly outcomes: ReadonlyArray<DeliveryOutcome> }>;
  start(): void;
  stop(): void;
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
        secret: (row as unknown as { secret_text: string }).secret_text,
        verificationChallenge: (row as unknown as { verification_challenge: string | null }).verification_challenge,
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

  async function tickInternal(): Promise<{ attempted: number; outcomes: DeliveryOutcome[] }> {
    if (inFlight) return { attempted: 0, outcomes: [] };
    inFlight = true;
    try {
      const due = await claimDueQueue(new Date(nowMs()).toISOString());
      const outcomes: DeliveryOutcome[] = [];
      for (const row of due) {
        // Skip rows whose subscription is no longer eligible. The verify event
        // is allowed through while the subscription is still
        // `pending_verification`.
        if (row.subscription_status === "deleted") {
          await updateQueueAttempt(
            row.queue_id,
            row.attempt_count,
            new Date(nowMs()).toISOString(),
            "dropped",
            "subscription_inactive"
          );
          continue;
        }
        if (row.subscription_status === "disabled_revoked" && row.event_type !== "pdpp.grant.revoked") {
          await updateQueueAttempt(
            row.queue_id,
            row.attempt_count,
            new Date(nowMs()).toISOString(),
            "dropped",
            "subscription_revoked"
          );
          continue;
        }
        if (row.subscription_status === "pending_verification" && row.event_type !== "pdpp.subscription.verify") {
          continue;
        }
        if (
          (row.subscription_status === "disabled" || row.subscription_status === "disabled_failure") &&
          row.event_type !== "pdpp.subscription.verify"
        ) {
          await updateQueueAttempt(
            row.queue_id,
            row.attempt_count,
            new Date(nowMs()).toISOString(),
            "dropped",
            "subscription_disabled"
          );
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
      if (timer) return;
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
  if (!defaultWorker) defaultWorker = createDeliveryWorker();
  return defaultWorker;
}
