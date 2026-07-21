// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHmac, timingSafeEqual } from "node:crypto";

import { canonicalConnectorKey } from "../../server/connector-key.js";

export class SourceWebhookError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "SourceWebhookError";
    this.code = code;
    this.status = status;
  }
}

export interface SourceWebhookInput {
  readonly sourceId: string;
  readonly body: string;
  readonly timestamp: string | null | undefined;
  readonly eventId: string | null | undefined;
  readonly signature: string | null | undefined;
}

export interface SourceWebhookDependencies {
  readonly nowMs: () => number;
  readonly resolveSecret: (sourceId: string) => string | null | undefined;
  readonly resolveConnectorId?: (sourceId: string) => string | null | undefined;
  readonly claimEvent: (event: {
    sourceId: string;
    eventId: string;
    bodyHash: string;
    receivedAt: string;
  }) => boolean | Promise<boolean>;
  readonly ingestRecords: (input: {
    connectorId: string;
    streamName: string;
    body: string;
  }) => Promise<{
    readonly stream: string;
    readonly records_accepted: number;
    readonly records_rejected: number;
    readonly errors: readonly string[];
  }>;
  readonly signalScheduler: (input: {
    connectorId: string;
    eventId: string;
    receivedAt: string;
  }) => void | Promise<void>;
  readonly projectAutomationPolicy?: (input: {
    connectorId: string;
    triggerKind: "webhook";
  }) => Promise<{
    readonly allowed_to_start?: boolean;
    readonly automation_mode?: string;
    readonly reason?: string | null;
    readonly trigger_kind: "webhook";
  }> | {
    readonly allowed_to_start?: boolean;
    readonly automation_mode?: string;
    readonly reason?: string | null;
    readonly trigger_kind: "webhook";
  };
  readonly requestRun?: (input: {
    automationPolicy: {
      readonly allowed_to_start?: boolean;
      readonly automation_mode?: string;
      readonly reason?: string | null;
      readonly trigger_kind: "webhook";
    };
    connectorId: string;
    eventId: string;
    receivedAt: string;
    triggerKind: "webhook";
  }) => Promise<{
    readonly automation_mode?: string;
    readonly automation_summary?: string;
    readonly run_id: string;
    readonly status?: string;
    readonly trace_id: string;
    readonly trigger_kind?: string;
  } | null> | {
    readonly automation_mode?: string;
    readonly automation_summary?: string;
    readonly run_id: string;
    readonly status?: string;
    readonly trace_id: string;
    readonly trigger_kind?: string;
  } | null;
}

export interface SourceWebhookResult {
  readonly accepted: boolean;
  readonly duplicate: boolean;
  readonly source_id: string;
  readonly event_id: string;
  readonly action?: "ingest_records" | "schedule_run";
  readonly ingest?: {
    readonly stream: string;
    readonly records_accepted: number;
    readonly records_rejected: number;
    readonly errors: readonly string[];
  };
  readonly automation_policy?: {
    readonly allowed_to_start?: boolean;
    readonly automation_mode?: string;
    readonly reason?: string | null;
    readonly trigger_kind: "webhook";
  };
  readonly run?: {
    readonly automation_mode?: string;
    readonly automation_summary?: string;
    readonly run_id: string;
    readonly status?: string;
    readonly trace_id: string;
    readonly trigger_kind?: string;
  } | null;
  readonly trigger_kind?: "webhook";
}

const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

function requireNonEmpty(value: string | null | undefined, code: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SourceWebhookError(code, `${label} is required`, 401);
  }
  return value.trim();
}

function verifySignature(secret: string, timestamp: string, body: string, signature: string): void {
  const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    throw new SourceWebhookError("invalid_signature", "webhook signature is invalid", 401);
  }
}

function parseBody(body: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SourceWebhookError("invalid_payload", "webhook body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SourceWebhookError) throw err;
    throw new SourceWebhookError("invalid_payload", "webhook body must be valid JSON");
  }
}

export async function executeSourceWebhook(
  input: SourceWebhookInput,
  deps: SourceWebhookDependencies,
): Promise<SourceWebhookResult> {
  const sourceId = requireNonEmpty(input.sourceId, "invalid_source", "source id");
  const eventId = requireNonEmpty(input.eventId, "missing_event_id", "PDPP-Webhook-Event-Id");
  const timestamp = requireNonEmpty(input.timestamp, "missing_timestamp", "PDPP-Webhook-Timestamp");
  const signature = requireNonEmpty(input.signature, "missing_signature", "PDPP-Webhook-Signature");
  const secret = deps.resolveSecret(sourceId);
  if (!secret) {
    throw new SourceWebhookError("unknown_source", "source webhook credential is not configured", 404);
  }

  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(deps.nowMs() - timestampMs) > DEFAULT_TOLERANCE_MS) {
    throw new SourceWebhookError("stale_timestamp", "webhook timestamp is outside the accepted window", 401);
  }

  verifySignature(secret, timestamp, input.body, signature);
  const payload = parseBody(input.body);
  const resolvedConnectorId = deps.resolveConnectorId?.(sourceId) || sourceId;
  // Canonicalize at the operation boundary: the configured connector id (from
  // PDPP_SOURCE_WEBHOOK_SECRETS or the raw URL :sourceId) may be a URL-shaped
  // first-party id or a legacy snake_case alias. Keying the webhook-triggered
  // run, spine events, and last-run row by a non-canonical id splits identity
  // from every other surface, so map it to the canonical key here.
  const connectorId = canonicalConnectorKey(resolvedConnectorId) ?? resolvedConnectorId;
  const bodyHash = createHmac("sha256", secret).update(input.body).digest("hex");
  const receivedAt = new Date(deps.nowMs()).toISOString();
  const claimed = await deps.claimEvent({ sourceId, eventId, bodyHash, receivedAt });
  if (!claimed) {
    return { accepted: true, duplicate: true, source_id: sourceId, event_id: eventId };
  }

  if (payload.action === "ingest_records") {
    if (typeof payload.stream !== "string" || payload.stream.trim() === "") {
      throw new SourceWebhookError("invalid_payload", "ingest_records requires stream");
    }
    if (!Array.isArray(payload.records)) {
      throw new SourceWebhookError("invalid_payload", "ingest_records requires records array");
    }
    const body = payload.records.map((record) => JSON.stringify(record)).join("\n");
    const ingest = await deps.ingestRecords({
      connectorId,
      streamName: payload.stream,
      body,
    });
    return { accepted: true, duplicate: false, source_id: sourceId, event_id: eventId, action: "ingest_records", ingest };
  }

  if (payload.action === "schedule_run") {
    const automationPolicy = deps.projectAutomationPolicy
      ? await deps.projectAutomationPolicy({ connectorId, triggerKind: "webhook" })
      : { trigger_kind: "webhook" as const };
    const run = automationPolicy.allowed_to_start === false
      ? null
      : deps.requestRun
        ? await deps.requestRun({ connectorId, eventId, receivedAt, triggerKind: "webhook", automationPolicy })
        : null;
    if (!deps.requestRun) {
      await deps.signalScheduler({ connectorId, eventId, receivedAt });
    }
    return {
      accepted: true,
      duplicate: false,
      source_id: sourceId,
      event_id: eventId,
      action: "schedule_run",
      trigger_kind: "webhook",
      automation_policy: automationPolicy,
      run,
    };
  }

  throw new SourceWebhookError("invalid_payload", "unsupported webhook action");
}
