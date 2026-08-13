// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHmac, timingSafeEqual } from "node:crypto";

import { canonicalConnectorKey } from "../../server/connector-key.ts";

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
  readonly body: string;
  readonly eventId: string | null | undefined;
  readonly signature: string | null | undefined;
  readonly sourceId: string;
  readonly timestamp: string | null | undefined;
}

export interface SourceWebhookDependencies {
  readonly claimEvent: (event: {
    sourceId: string;
    eventId: string;
    bodyHash: string;
    receivedAt: string;
  }) => boolean | Promise<boolean>;
  readonly ingestRecords: (input: {
    connectorId: string;
    connectorInstanceId: string;
    ownerSubjectId: string;
    streamName: string;
    body: string;
  }) => Promise<{
    readonly stream: string;
    readonly records_accepted: number;
    readonly records_rejected: number;
    readonly errors: readonly string[];
  }>;
  readonly nowMs: () => number;
  readonly projectAutomationPolicy?: (input: { connectorId: string; triggerKind: "webhook" }) =>
    | Promise<{
        readonly allowed_to_start?: boolean;
        readonly automation_mode?: string;
        readonly reason?: string | null;
        readonly trigger_kind: "webhook";
      }>
    | {
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
    bodyHash: string;
    connectorId: string;
    connectorInstanceId: string;
    eventId: string;
    ownerSubjectId: string;
    receivedAt: string;
    sourceId: string;
    triggerKind: "webhook";
  }) =>
    | Promise<{
        readonly automation_mode?: string;
        readonly automation_summary?: string;
        readonly run_id: string;
        readonly status?: string;
        readonly trace_id: string;
        readonly trigger_kind?: string;
      } | null>
    | {
        readonly automation_mode?: string;
        readonly automation_summary?: string;
        readonly run_id: string;
        readonly status?: string;
        readonly trace_id: string;
        readonly trigger_kind?: string;
      }
    | null;
  readonly resolveSecret: (sourceId: string) => string | null | undefined;
  readonly resolveTarget: (
    sourceId: string
  ) =>
    | Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }>
    | { connectorId: string; connectorInstanceId: string; ownerSubjectId: string };
  readonly signalScheduler: (input: {
    connectorId: string;
    connectorInstanceId: string;
    eventId: string;
    ownerSubjectId: string;
    receivedAt: string;
  }) => void | Promise<void>;
}

export interface SourceWebhookResult {
  readonly accepted: boolean;
  readonly action?: "ingest_records" | "schedule_run";
  readonly automation_policy?: {
    readonly allowed_to_start?: boolean;
    readonly automation_mode?: string;
    readonly reason?: string | null;
    readonly trigger_kind: "webhook";
  };
  readonly duplicate: boolean;
  readonly event_id: string;
  readonly ingest?: {
    readonly stream: string;
    readonly records_accepted: number;
    readonly records_rejected: number;
    readonly errors: readonly string[];
  };
  readonly run?: {
    readonly automation_mode?: string;
    readonly automation_summary?: string;
    readonly run_id: string;
    readonly status?: string;
    readonly trace_id: string;
    readonly trigger_kind?: string;
  } | null;
  readonly source_id: string;
  readonly trigger_kind?: "webhook";
}

const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

/** Reference ingress resource policy; these are not PDPP Core constants. */
export const SOURCE_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
export const SOURCE_WEBHOOK_MAX_RECORDS = 500;

function requireNonEmpty(value: string | null | undefined, code: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SourceWebhookError(code, `${label} is required`, 401);
  }
  return value.trim();
}

function verifySignature(secret: string, eventId: string, timestamp: string, body: string, signature: string): void {
  const expected = `sha256=${createHmac("sha256", secret).update(`${eventId}.${timestamp}.${body}`).digest("hex")}`;
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
    if (err instanceof SourceWebhookError) {
      throw err;
    }
    // biome-ignore lint/style/useErrorCause: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    throw new SourceWebhookError("invalid_payload", "webhook body must be valid JSON");
  }
}

function validateRecordCount(payload: Record<string, unknown>): void {
  if (payload.action !== "ingest_records" || !Array.isArray(payload.records)) {
    return;
  }
  if (payload.records.length > SOURCE_WEBHOOK_MAX_RECORDS) {
    throw new SourceWebhookError(
      "resource_limit",
      `ingest_records accepts at most ${SOURCE_WEBHOOK_MAX_RECORDS} records`,
      413
    );
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
export async function executeSourceWebhook(
  input: SourceWebhookInput,
  deps: SourceWebhookDependencies
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

  verifySignature(secret, eventId, timestamp, input.body, signature);
  const payload = parseBody(input.body);
  // Reject overlarge record arrays before target lookup, idempotency claim, or
  // the map/stringify pass that constructs the NDJSON ingest body.
  validateRecordCount(payload);
  const resolvedTarget = await deps.resolveTarget(sourceId);
  const connectorId = canonicalConnectorKey(resolvedTarget.connectorId) ?? resolvedTarget.connectorId;
  const { connectorInstanceId, ownerSubjectId } = resolvedTarget;
  if (!(connectorId && connectorInstanceId && ownerSubjectId)) {
    throw new SourceWebhookError("invalid_source_target", "source webhook target is incomplete", 404);
  }
  const bodyHash = createHmac("sha256", secret).update(input.body).digest("hex");
  const receivedAt = new Date(deps.nowMs()).toISOString();
  const claimEvent = async (): Promise<boolean> => await deps.claimEvent({ bodyHash, eventId, receivedAt, sourceId });

  // A controller-backed schedule_run reserves the generic event key together
  // with its receipt in one store transaction. Claiming it here would discard
  // the receipt's replay handle; non-controller paths retain claim-before-action.
  if ((payload.action !== "schedule_run" || !deps.requestRun) && !(await claimEvent())) {
    return { accepted: true, duplicate: true, event_id: eventId, source_id: sourceId };
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
      body,
      connectorId,
      connectorInstanceId,
      ownerSubjectId,
      streamName: payload.stream,
    });
    return {
      accepted: true,
      action: "ingest_records",
      duplicate: false,
      event_id: eventId,
      ingest,
      source_id: sourceId,
    };
  }

  if (payload.action === "schedule_run") {
    const automationPolicy = deps.projectAutomationPolicy
      ? await deps.projectAutomationPolicy({ connectorId, triggerKind: "webhook" })
      : { trigger_kind: "webhook" as const };
    if (automationPolicy.allowed_to_start === false && !(await claimEvent())) {
      return { accepted: true, duplicate: true, event_id: eventId, source_id: sourceId };
    }
    const run =
      automationPolicy.allowed_to_start === false
        ? null
        : // biome-ignore lint/style/noNestedTernary: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
          deps.requestRun
          ? await deps.requestRun({
              automationPolicy,
              bodyHash,
              connectorId,
              connectorInstanceId,
              eventId,
              ownerSubjectId,
              receivedAt,
              sourceId,
              triggerKind: "webhook",
            })
          : null;
    if (automationPolicy.allowed_to_start !== false && !run) {
      if (!(await claimEvent())) {
        return { accepted: true, duplicate: true, event_id: eventId, source_id: sourceId };
      }
      await deps.signalScheduler({ connectorId, connectorInstanceId, eventId, ownerSubjectId, receivedAt });
    }
    return {
      accepted: true,
      action: "schedule_run",
      automation_policy: automationPolicy,
      duplicate: false,
      event_id: eventId,
      run,
      source_id: sourceId,
      trigger_kind: "webhook",
    };
  }

  throw new SourceWebhookError("invalid_payload", "unsupported webhook action");
}
