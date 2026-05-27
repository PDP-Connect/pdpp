/**
 * Canonical `rs.client-event.deliver` operation.
 *
 * Owns the per-attempt delivery semantics:
 *
 * - Standard Webhooks HMAC-SHA256 signature over `{webhook-id}.{webhook-timestamp}.{raw body}`;
 * - `webhook-id` / `webhook-timestamp` / `webhook-signature` header set;
 * - outcome classification (success / transient / permanent failure);
 * - retry scheduling (exponential backoff with jitter);
 * - dead-letter transition after the configured max attempts;
 * - bounded response snippet for the attempt log.
 *
 * Boundary rules:
 * - This module SHALL NOT import Fastify, SQLite, Postgres, route/auth, or
 *   `process` / `process.env`. The HTTP transport is injected.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Structured-mode CloudEvents 1.0 content type. The body posted to receivers
 * is a CloudEvents JSON envelope (see `buildEventPayload` in the as-layer),
 * so the wire `content-type` SHALL identify the CloudEvents JSON format
 * rather than a generic `application/json`. CloudEvents HTTP Protocol
 * Binding §3.2.
 */
export const DELIVERY_CONTENT_TYPE = "application/cloudevents+json; charset=utf-8";

export const DEFAULT_BACKOFF_SECONDS: ReadonlyArray<number> = [
  30,
  120,
  600,
  3600,
  21600,
  86400,
];

export const MAX_RESPONSE_SNIPPET_BYTES = 512;

export interface DeliverableEvent {
  readonly queueId: number;
  readonly subscriptionId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly payloadJson: string;
  readonly attemptCount: number;
  readonly callbackUrl: string;
  /** Raw secret available to the delivery worker (typically loaded from a sealed store). */
  readonly secret: string;
  readonly verificationChallenge?: string | null;
}

export interface HttpTransportRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface HttpTransportResponse {
  readonly statusCode: number | null;
  readonly bodyText: string | null;
  readonly errorMessage: string | null;
  readonly latencyMs: number;
}

export interface DeliveryDependencies {
  readonly nowSeconds: () => number;
  readonly nowIso: () => string;
  readonly request: (req: HttpTransportRequest) => Promise<HttpTransportResponse>;
  readonly backoffSeconds?: ReadonlyArray<number>;
  /** Override for tests. */
  readonly randomJitterFactor?: () => number;
}

export type DeliveryOutcome =
  | { kind: "delivered"; statusCode: number; latencyMs: number; bodyText: string | null }
  | { kind: "verified"; statusCode: number; latencyMs: number; bodyText: string | null }
  | {
      kind: "retry";
      attemptCount: number;
      nextAttemptIso: string;
      statusCode: number | null;
      latencyMs: number;
      error: string;
      bodyText: string | null;
    }
  | {
      kind: "final_failure";
      attemptCount: number;
      statusCode: number | null;
      latencyMs: number;
      error: string;
      bodyText: string | null;
    };

/**
 * Standard Webhooks signing primitives.
 *
 * Wire format follows https://www.standardwebhooks.com :
 *
 *   webhook-id        = stable event id
 *   webhook-timestamp = unix seconds
 *   webhook-signature = "v1,<base64(hmac_sha256(key, `${id}.${ts}.${body}`))>"
 *
 * `whsec_`-prefixed secrets carry a base64 payload; the bytes after the
 * prefix decode to the raw HMAC key. Secrets without the prefix are hashed
 * as UTF-8 bytes (compatibility shim for legacy/testing — production
 * subscriptions always issue `whsec_` secrets).
 *
 * `webhook-signature` is space-separated when rotating: `"v1,sig v1,sig2"`.
 * Verifiers must accept any matching `v1,` token.
 */
export function decodeWebhookSecret(secret: string): Buffer {
  if (secret.startsWith("whsec_")) {
    return Buffer.from(secret.slice("whsec_".length), "base64");
  }
  return Buffer.from(secret, "utf8");
}

function rawSignature(secret: string, eventId: string, timestamp: number, body: string): string {
  const key = decodeWebhookSecret(secret);
  return createHmac("sha256", key).update(`${eventId}.${timestamp}.${body}`).digest("base64");
}

/** Build the `webhook-signature` header value for a single event. */
export function signEvent(secret: string, eventId: string, timestamp: number, body: string): string {
  return `v1,${rawSignature(secret, eventId, timestamp, body)}`;
}

/** Verify a `webhook-signature` header containing one or more space-separated `v1,<sig>` tokens. */
export function verifySignatureHeader(
  secret: string,
  eventId: string,
  timestamp: number,
  body: string,
  header: string,
): boolean {
  const expected = rawSignature(secret, eventId, timestamp, body);
  const expectedBuf = Buffer.from(expected);
  for (const token of header.split(/\s+/).filter(Boolean)) {
    const idx = token.indexOf(",");
    if (idx < 0) continue;
    const version = token.slice(0, idx);
    if (version !== "v1") continue;
    const candidate = token.slice(idx + 1);
    const candidateBuf = Buffer.from(candidate);
    if (candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf)) {
      return true;
    }
  }
  return false;
}

function snippet(text: string | null): string | null {
  if (text == null) return null;
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= MAX_RESPONSE_SNIPPET_BYTES) return text;
  return buf.slice(0, MAX_RESPONSE_SNIPPET_BYTES).toString("utf8");
}

function classifyChallenge(event: DeliverableEvent, bodyText: string | null): boolean {
  if (event.eventType !== "pdpp.subscription.verify") return false;
  if (!event.verificationChallenge || !bodyText) return false;
  try {
    const parsed = JSON.parse(bodyText) as { challenge?: unknown };
    return typeof parsed.challenge === "string" && parsed.challenge === event.verificationChallenge;
  } catch {
    return false;
  }
}

export async function executeDelivery(
  event: DeliverableEvent,
  deps: DeliveryDependencies,
): Promise<DeliveryOutcome> {
  const backoff = deps.backoffSeconds ?? DEFAULT_BACKOFF_SECONDS;
  const timestamp = deps.nowSeconds();
  const signature = signEvent(event.secret, event.eventId, timestamp, event.payloadJson);
  const response = await deps.request({
    url: event.callbackUrl,
    method: "POST",
    headers: {
      "content-type": DELIVERY_CONTENT_TYPE,
      "webhook-id": event.eventId,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signature,
    },
    body: event.payloadJson,
  });

  const nextAttemptIndex = event.attemptCount + 1;
  const isHttp2xx = response.statusCode != null && response.statusCode >= 200 && response.statusCode < 300;
  const bodyText = snippet(response.bodyText);

  if (isHttp2xx) {
    if (event.eventType === "pdpp.subscription.verify") {
      if (classifyChallenge(event, response.bodyText)) {
        return { kind: "verified", statusCode: response.statusCode as number, latencyMs: response.latencyMs, bodyText };
      }
      // 2xx but wrong challenge — schedule a retry until exhausted.
    } else {
      return { kind: "delivered", statusCode: response.statusCode as number, latencyMs: response.latencyMs, bodyText };
    }
  }

  const error =
    response.errorMessage ?? (response.statusCode ? `HTTP ${response.statusCode}` : "no response");
  if (nextAttemptIndex >= backoff.length) {
    return {
      kind: "final_failure",
      attemptCount: nextAttemptIndex,
      statusCode: response.statusCode,
      latencyMs: response.latencyMs,
      error,
      bodyText,
    };
  }
  const base = backoff[nextAttemptIndex] ?? backoff[backoff.length - 1] ?? 60;
  const jitter = deps.randomJitterFactor ? deps.randomJitterFactor() : 0.8 + Math.random() * 0.4;
  const delaySeconds = Math.round(base * jitter);
  const nextAttempt = new Date(Date.now() + delaySeconds * 1000).toISOString();
  return {
    kind: "retry",
    attemptCount: nextAttemptIndex,
    nextAttemptIso: nextAttempt,
    statusCode: response.statusCode,
    latencyMs: response.latencyMs,
    error,
    bodyText,
  };
}
