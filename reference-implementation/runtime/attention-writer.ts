/**
 * Runtime → durable structured attention writer.
 *
 * Maps INTERACTION / ASSISTANCE / ASSISTANCE_STATUS / INTERACTION_RESPONSE
 * lifecycle events emitted by the runtime to `connector_attention_records`
 * rows via `getDefaultConnectorAttentionStore()`. The reader path
 * (`server/ref-control::getConnectorAttentionProjection` → connection
 * health projection) was already in place; this module finally closes the
 * production-writer gap called out by
 * `complete-ri-operator-console-reliability` task 5.3.
 *
 * Design rules:
 *
 *   1. Pure adapter over `runtime/attention.ts::createAttention` and
 *      `transition`. No connector-specific copy or classification lives
 *      here.
 *   2. Connector-agnostic: takes (connectorId, connectorInstanceId, runId,
 *      connectionId) and returns operations against the store. The
 *      reference runtime is the only caller today, but the shape stays
 *      generic so adopting it from other controllers is mechanical.
 *   3. Secret-safe: secret-sensitive interactions (`credentials`, `otp`)
 *      persist with `sensitivity: "secret"`; the projection then
 *      suppresses `next_action.action_target` so dashboard links to
 *      secret-prompt surfaces never appear, and the runtime payload never
 *      reaches `pushPayload`.
 *   4. Non-fatal: store writes wrap their own try/catch. A store outage
 *      degrades the projection to `unknown` (existing behaviour via
 *      `getConnectorAttentionProjection`); it must never abort a
 *      successful collection. Failures are logged through the supplied
 *      `log` so tests and operator timelines stay honest.
 *   5. Lifecycle authoritative: callers do not pass arbitrary lifecycles.
 *      The writer keys off the wire status the runtime already validated
 *      (`success` / `cancelled` / `timeout` / `resolved` / `escalated`
 *      / `timed_out`) and maps to the closed `AttentionLifecycle` set.
 *
 * Action targets are restricted to the non-secret enum
 * `{ dashboard, remote_surface, external_app, local_device }`. Free-form
 * URLs, raw browser ws targets, OTP/credential values, and connector
 * messages never enter the store from this path.
 */

import {
  type AttentionLifecycle,
  type AttentionRecord,
  createAttention,
  type NotificationState,
  type OwnerAction,
  type ProgressPosture,
  recordNotificationOutcome,
  type Sensitivity,
} from "./attention.ts";

/** Terminal wire status the runtime hands to the resolve/drain paths. */
type TerminalStatus = string;

/** Connector-emitted INTERACTION message shape (only fields read here). */
interface InteractionMessage {
  kind?: string | null;
  request_id?: string | null;
  stream?: string | null;
  timeout_seconds?: number | null;
}

/** Connector-emitted ASSISTANCE message shape (only fields read here). */
interface AssistanceMessage {
  assistance_request_id?: string | null;
  attachments?: Array<{ kind?: string } | null> | null;
  auto_detect?: boolean;
  kind?: string | null;
  owner_action: OwnerAction;
  progress_posture?: ProgressPosture;
  reason_code?: string | null;
  response_contract: "none" | "response_required";
  sensitivity?: string | null;
  stream?: string | null;
  timeout_seconds?: number | null;
}

/** Structural view of the connector attention store the writer needs. */
interface AttentionStore {
  transitionAttention(args: { attentionId: string; to: AttentionLifecycle; now: string }): Promise<unknown>;
  upsertAttention(args: {
    record: AttentionRecord;
    connectorId: string;
    connectorInstanceId: string | null;
  }): Promise<unknown>;
}

interface ConsoleLike {
  warn?: (message: string) => void;
}

export interface AttentionWriterOptions {
  connectionId?: string;
  connectorId: string;
  connectorInstanceId?: string | null;
  log?: ConsoleLike;
  makeAttentionId?: (requestId: string) => string;
  nowIso?: () => string;
  runId: string;
  store: AttentionStore;
}

interface OpenEntry {
  dedupeKey: string;
  record: AttentionRecord;
  requestId: string;
}

interface NormalizedAssistanceRequestInput {
  requestId: string;
}

interface BuildAssistanceAttentionRecordArgs {
  attentionId: string;
  connectionId: string;
  dedupeKey: string;
  msg: AssistanceMessage;
  now: string;
  runId: string;
}

/**
 * Map a connector-emitted INTERACTION kind to the non-secret action_target
 * enum the projection accepts. `credentials` and `otp` deliberately point
 * at `dashboard` even though the projection will suppress the value:
 * the row still needs a non-null target so the schedule fallback never
 * wins the precedence race, and the projection layer enforces the
 * suppression centrally via `sensitivity === "secret"`.
 */
function actionTargetForInteractionKind(kind: string | null | undefined): string {
  switch (kind) {
    case "manual_action":
      return "remote_surface";
    case "credentials":
    case "otp":
      return "dashboard";
    default:
      return "dashboard";
  }
}

function ownerActionForInteractionKind(kind: string | null | undefined): OwnerAction {
  return kind === "manual_action" ? "operate_attachment" : "provide_value";
}

function sensitivityForInteractionKind(kind: string | null | undefined): Sensitivity {
  return kind === "credentials" || kind === "otp" ? "secret" : "non_secret";
}

function reasonCodeForInteractionKind(kind: string | null | undefined): string {
  switch (kind) {
    case "credentials":
      return "credentials_required";
    case "otp":
      return "otp_required";
    case "manual_action":
      return "manual_action_required";
    default:
      return `interaction_${kind || "unknown"}`;
  }
}

/**
 * Map the wire-level INTERACTION/ASSISTANCE_STATUS terminal status to a
 * durable `AttentionLifecycle`. Anything we cannot honestly classify
 * resolves as `cancelled` — the run is over, the prompt no longer
 * applies, and we don't want a stuck `open` row haunting the projection.
 */
function lifecycleForTerminalStatus(status: string | null | undefined): AttentionLifecycle {
  switch (status) {
    case "success":
    case "resolved":
      return "resolved";
    case "timeout":
    case "timed_out":
      return "expired";
    default:
      return "cancelled";
  }
}

/**
 * Restrict action_target to the non-secret enum. The ASSISTANCE protocol
 * shape gives connectors enough rope to emit attachment role/availability
 * metadata; we deliberately do not forward those through the durable
 * record. Only a small enum survives so the dashboard never links to a
 * connector-controlled URL via the attention CTA.
 */
function actionTargetForAssistance(msg: AssistanceMessage): string {
  const owner = msg.owner_action;
  if (Array.isArray(msg.attachments) && msg.attachments.some((a) => a && a.kind === "browser_surface")) {
    return "remote_surface";
  }
  if (owner === "act_elsewhere") {
    return "external_app";
  }
  if (owner === "operate_attachment") {
    return "remote_surface";
  }
  if (owner === "provide_value") {
    return "dashboard";
  }
  return "dashboard";
}

function sensitivityForAssistance(msg: AssistanceMessage): Sensitivity {
  if (msg.sensitivity === "secret") {
    return "secret";
  }
  return "non_secret";
}

function expiresAtFromTimeout(nowMs: number, timeoutSeconds: number | null | undefined): string | null {
  if (!Number.isFinite(timeoutSeconds) || (timeoutSeconds ?? 0) <= 0) {
    return null;
  }
  return new Date(nowMs + (timeoutSeconds as number) * 1000).toISOString();
}

function normalizeAssistanceRequestInput(msg: AssistanceMessage): NormalizedAssistanceRequestInput | null {
  const requestId = String(msg.assistance_request_id || "").trim();
  if (!requestId) {
    return null;
  }
  // ASSISTANCE with `owner_action: none` + `response_contract: none`
  // would be a pure progress notice; the runtime already rejects that
  // shape at validation time, but defend in depth.
  if (msg.owner_action === "none" && msg.response_contract === "none") {
    return null;
  }
  return { requestId };
}

function buildAssistanceAttentionRecord({
  attentionId,
  connectionId,
  dedupeKey,
  msg,
  now,
  runId,
}: BuildAssistanceAttentionRecordArgs): AttentionRecord {
  return createAttention({
    id: attentionId,
    dedupe_key: dedupeKey,
    connection_id: connectionId,
    run_id: runId,
    reason_code: msg.reason_code || msg.kind || "assistance_required",
    progress_posture: msg.progress_posture || "blocked",
    owner_action: msg.owner_action,
    response_contract: msg.response_contract,
    sensitivity: sensitivityForAssistance(msg),
    auto_detect: msg.auto_detect === true,
    now,
    expires_at: expiresAtFromTimeout(Date.parse(now), msg.timeout_seconds),
    action_target: actionTargetForAssistance(msg),
    metadata: { stream: msg.stream || null, kind: msg.kind || null },
  });
}

/**
 * Build the writer bound to a specific run. The runtime calls
 * `recordInteractionRequest` / `recordAssistanceRequest` when a new
 * owner-action prompt is emitted and `resolveByDedupeKey` /
 * `resolveAll` when the prompt terminates.
 *
 * @param {object} opts
 * @param {string} opts.connectorId
 * @param {string|null} [opts.connectorInstanceId]
 * @param {string} opts.runId
 * @param {string} [opts.connectionId] - Defaults to `connectorId`. Today
 *   the reference console renders one row per (connectorId,
 *   connectorInstanceId), so the attention `connection_id` field is the
 *   connector id; the schema accepts an override for future per-grant
 *   surfaces.
 * @param {object} opts.store - `getDefaultConnectorAttentionStore()`
 *   shape; injected for tests.
 * @param {object} [opts.log] - Console-like; `warn` is used on failure.
 * @param {() => string} [opts.nowIso] - Injected clock for tests.
 * @param {(prefix: string) => string} [opts.makeAttentionId] - Injected
 *   id factory for tests. Default: `att_<runId>_<requestId>`.
 */
export function createAttentionWriter(opts: AttentionWriterOptions) {
  const connectorId = String(opts.connectorId || "").trim();
  if (!connectorId) {
    throw new Error("attention-writer: connectorId is required");
  }
  const connectorInstanceId = opts.connectorInstanceId || null;
  const runId = String(opts.runId || "").trim();
  if (!runId) {
    throw new Error("attention-writer: runId is required");
  }
  const connectionId = String(opts.connectionId || connectorId).trim();
  const store = opts.store;
  if (!store || typeof store.upsertAttention !== "function" || typeof store.transitionAttention !== "function") {
    throw new Error("attention-writer: store must implement upsertAttention and transitionAttention");
  }
  const log = opts.log || console;
  const nowIso = typeof opts.nowIso === "function" ? opts.nowIso : () => new Date().toISOString();
  const makeAttentionId =
    typeof opts.makeAttentionId === "function"
      ? opts.makeAttentionId
      : (requestId: string) => `att_${runId}_${requestId}`;

  // Track outstanding attention rows by their primary key. Dedupe keys are
  // persisted for projection/dedupe semantics, but they are not unique in the
  // table. Multiple open ASSISTANCE prompts may legitimately share kind/stream;
  // resolving one request must not orphan the earlier row by overwriting an
  // in-memory entry with the same dedupe key.
  //
  // `record` is the last persisted shape; the notification-outcome path
  // upserts the same id with the new `notification_state`, so we need the
  // current axes locally without re-reading the store on every push attempt.
  const open = new Map<string, OpenEntry>(); // attentionId -> { dedupeKey, requestId, record }
  const byRequestId = new Map<string, string>(); // requestId -> attentionId

  function trackOpen(dedupeKey: string, attentionId: string, requestId: string, record: AttentionRecord): void {
    open.set(attentionId, { dedupeKey, requestId, record });
    if (requestId) {
      byRequestId.set(requestId, attentionId);
    }
  }

  function untrack(attentionId: string): void {
    const entry = open.get(attentionId);
    open.delete(attentionId);
    if (entry?.requestId) {
      byRequestId.delete(entry.requestId);
    }
  }

  async function safeUpsert(record: AttentionRecord): Promise<AttentionRecord | null> {
    try {
      await store.upsertAttention({
        record,
        connectorId,
        connectorInstanceId,
      });
      return record;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[attention-writer] upsert failed for ${record.id}: ${message}`);
      return null;
    }
  }

  async function safeTransition(attentionId: string, to: AttentionLifecycle): Promise<unknown> {
    try {
      return await store.transitionAttention({ attentionId, to, now: nowIso() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[attention-writer] transition ${attentionId} -> ${to} failed: ${message}`);
      return null;
    }
  }

  /**
   * Build the dedupe key for an INTERACTION. Same connector instance +
   * same kind + same stream collapses to one row; a fresh request for
   * the same shape upserts in place rather than fanning out.
   */
  function dedupeKeyForInteraction(msg: InteractionMessage): string {
    const instance = connectorInstanceId || "default";
    return `${connectorId}:${instance}:interaction:${msg.kind || "unknown"}:${msg.stream || "global"}`;
  }

  function dedupeKeyForAssistance(msg: AssistanceMessage): string {
    const instance = connectorInstanceId || "default";
    const kind = msg.kind || msg.reason_code || "assistance";
    return `${connectorId}:${instance}:assistance:${kind}:${msg.stream || "global"}`;
  }

  return {
    /**
     * Persist an INTERACTION request as a durable attention row. Called
     * by the runtime immediately after validation, before the wait for
     * INTERACTION_RESPONSE. Returns the row id (or null when the store
     * write failed; the runtime keeps running either way).
     */
    async recordInteractionRequest(msg: InteractionMessage): Promise<string | null> {
      const requestId = String(msg.request_id || "").trim();
      if (!requestId) {
        return null;
      }
      const kind = msg.kind;
      const dedupeKey = dedupeKeyForInteraction(msg);
      const attentionId = makeAttentionId(requestId);
      const now = nowIso();
      let record: AttentionRecord;
      try {
        record = createAttention({
          id: attentionId,
          dedupe_key: dedupeKey,
          connection_id: connectionId,
          run_id: runId,
          reason_code: reasonCodeForInteractionKind(kind),
          progress_posture: "blocked",
          owner_action: ownerActionForInteractionKind(kind),
          response_contract: "response_required",
          sensitivity: sensitivityForInteractionKind(kind),
          auto_detect: false,
          now,
          expires_at: expiresAtFromTimeout(Date.parse(now), msg.timeout_seconds),
          action_target: actionTargetForInteractionKind(kind),
          metadata: { stream: msg.stream || null, kind },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn?.(`[attention-writer] createAttention failed for interaction ${requestId}: ${message}`);
        return null;
      }
      const upserted = await safeUpsert(record);
      if (upserted) {
        trackOpen(dedupeKey, attentionId, requestId, upserted);
        return attentionId;
      }
      return null;
    },

    /**
     * Persist an ASSISTANCE request as a durable attention row.
     * `assistanceRequestId` comes from the runtime (connector-supplied or
     * runtime-generated) and is the same id used in
     * `ASSISTANCE_STATUS`, so completion can find the row deterministically.
     */
    async recordAssistanceRequest(msg: AssistanceMessage): Promise<string | null> {
      const normalized = normalizeAssistanceRequestInput(msg);
      if (!normalized) {
        return null;
      }
      const { requestId } = normalized;
      const dedupeKey = dedupeKeyForAssistance(msg);
      const attentionId = makeAttentionId(requestId);
      const now = nowIso();
      let record: AttentionRecord;
      try {
        record = buildAssistanceAttentionRecord({
          attentionId,
          connectionId,
          dedupeKey,
          msg,
          now,
          runId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn?.(`[attention-writer] createAttention failed for assistance ${requestId}: ${message}`);
        return null;
      }
      const upserted = await safeUpsert(record);
      if (upserted) {
        trackOpen(dedupeKey, attentionId, requestId, upserted);
        return attentionId;
      }
      return null;
    },

    /**
     * Transition the attention row matching `requestId` (the
     * connector-supplied INTERACTION request_id or
     * ASSISTANCE.assistance_request_id) to a terminal lifecycle. Returns
     * `true` if a tracked row was transitioned, `false` if there was no
     * tracked row (e.g. the upsert failed earlier or the row was already
     * drained).
     */
    async resolveByRequestId(requestId: string, status: TerminalStatus): Promise<boolean> {
      if (!requestId) {
        return false;
      }
      const attentionId = byRequestId.get(requestId);
      if (!attentionId) {
        return false;
      }
      const entry = open.get(attentionId);
      if (!entry) {
        return false;
      }
      const lifecycle = lifecycleForTerminalStatus(status);
      const next = await safeTransition(attentionId, lifecycle);
      untrack(attentionId);
      return next !== null;
    },

    /**
     * Drain all still-open attention rows on connector exit. Called from
     * the runtime's `closeOpenStructuredAssistance` so a run that crashes
     * or is force-cancelled leaves no orphaned `open` rows polluting
     * `needs_attention` indefinitely.
     */
    async resolveAllOpen(status: TerminalStatus): Promise<string[]> {
      const lifecycle = lifecycleForTerminalStatus(status);
      const drained: string[] = [];
      for (const [attentionId] of [...open.entries()]) {
        const next = await safeTransition(attentionId, lifecycle);
        untrack(attentionId);
        if (next) {
          drained.push(attentionId);
        }
      }
      return drained;
    },

    /**
     * Update the durable `notification_state` on a tracked attention row.
     * Called from the push fanout seam so the operator console can show
     * "we notified the owner" vs. "delivery failed" without re-querying
     * transport logs.
     *
     * Returns the updated record (or `null` when nothing was tracked or
     * the upsert failed). Lifecycle is preserved — a `failed` outcome
     * does NOT terminate the attention; the unresolved owner action is
     * still real and the projection must keep surfacing it. This is the
     * spec requirement that notification failure not become permission
     * to relaunch the same scheduled run.
     */
    async recordNotificationOutcome(
      attentionId: string,
      outcome: NotificationState,
      reason?: string | null
    ): Promise<AttentionRecord | null> {
      if (!attentionId) {
        return null;
      }
      const entry = open.get(attentionId);
      if (!entry?.record) {
        return null;
      }
      let next: AttentionRecord;
      try {
        next = recordNotificationOutcome(entry.record, {
          outcome,
          now: nowIso(),
          reason: reason ?? null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn?.(`[attention-writer] recordNotificationOutcome ${attentionId} invalid outcome: ${message}`);
        return null;
      }
      const upserted = await safeUpsert(next);
      if (upserted) {
        open.set(attentionId, { ...entry, record: upserted });
      }
      return upserted;
    },

    /**
     * Look up the tracked attentionId for a given runtime request id
     * (interaction request_id or assistance_request_id). The push fanout
     * seam uses this to address `recordNotificationOutcome` without
     * having to know the writer's id naming scheme.
     */
    attentionIdForRequest(requestId: string): string | null {
      if (!requestId) {
        return null;
      }
      return byRequestId.get(requestId) || null;
    },

    /** Test/inspection hook — read-only view of tracked rows. */
    _trackedForTests() {
      return {
        open: new Map(open),
        byRequestId: new Map(byRequestId),
      };
    },
  };
}
