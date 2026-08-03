// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorSchedulePatch, ScheduleApi, ScheduleUpsertResult } from "../runtime/controller.ts";

const DEFAULT_ACTIVATION_INTERVAL_SECONDS = 3600;

export type ActivationRefreshContractMode = "automatic" | "manual";

export interface ActivationRefreshContract {
  readonly backgroundSafe: boolean | null;
  readonly intervalSeconds: number;
  readonly mode: ActivationRefreshContractMode;
  readonly reason: "automatic" | "background_unsafe" | "manual" | "paused";
  readonly recommendedMode: "automatic" | "manual" | "paused" | null;
}

export interface ActivationScheduleController {
  getSchedule: (connectorId: string, options?: { connectorInstanceId?: string | null }) => Promise<ScheduleApi | null>;
  upsertSchedule: (
    connectorId: string,
    input: ConnectorSchedulePatch,
    options?: { connectorInstanceId?: string | null }
  ) => Promise<ScheduleUpsertResult>;
}

export interface ActivationScheduleResult {
  readonly attached: boolean;
  readonly contract: ActivationRefreshContract;
  readonly reason: "already_attached" | "attached" | "manual_contract";
}

interface ManifestLike {
  readonly capabilities?: {
    readonly refresh_policy?: unknown;
  } | null;
}

interface RefreshPolicyLike {
  readonly background_safe?: unknown;
  readonly recommended_interval_seconds?: unknown;
  readonly recommended_mode?: unknown;
}

interface RuntimeCollectionFactStreamLike {
  readonly checkpoint?: unknown;
  readonly considered?: unknown;
  readonly stream?: unknown;
}

interface RunTerminalDataLike {
  readonly collection_facts?: {
    readonly streams?: unknown;
  } | null;
  readonly recovery_only?: unknown;
}

interface ManifestStreamLike {
  readonly name?: unknown;
  readonly required?: unknown;
}

interface ManifestWithStreamsLike extends ManifestLike {
  readonly streams?: unknown;
}

/**
 * The manifest's own required-stream names (a stream is required unless it
 * explicitly declares `required: false` — the same default `isRequiredStream`
 * uses in `server/connector-coverage-policy.ts` and `streamPriority` uses in
 * `runtime/connector-verdict-input.ts`; duplicated here as a narrow read
 * rather than imported, to avoid pulling this activation-policy module into
 * the coverage-projection module graph). A malformed or missing `streams`
 * array yields an empty set — callers must treat that as "no required stream
 * is provable", never as "every stream is required".
 */
function manifestRequiredStreamNames(manifest: unknown): ReadonlySet<string> {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return new Set();
  }
  const streams = (manifest as ManifestWithStreamsLike).streams;
  if (!Array.isArray(streams)) {
    return new Set();
  }
  const names = new Set<string>();
  for (const raw of streams) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const stream = raw as ManifestStreamLike;
    if (typeof stream.name !== "string" || !stream.name) {
      continue;
    }
    if (stream.required === false) {
      continue;
    }
    names.add(stream.name);
  }
  return names;
}

/**
 * Did this run's own terminal `collection_facts` prove it actually reached
 * and completed a pass over one of THIS MANIFEST's declared required streams
 * — as opposed to merely reporting terminal `status: "succeeded"` (which a
 * run can claim without ever authenticating or touching a stream), and as
 * opposed to any incidental/optional stream fact the connector happens to
 * emit (which proves nothing about the manifest's own required-data
 * boundary). Binding to the manifest is load-bearing: without it, a fact for
 * an unrelated or explicitly `required: false` stream could activate a draft
 * and attach an unattended schedule with no real proof the connector's
 * required data was ever reached.
 *
 * Two independent, connector-shape-specific proofs are accepted for a
 * required-stream entry, because different connector shapes prove "reached
 * this stream" differently:
 *
 *   - `checkpoint` is anything other than `"not_staged"` — the runtime only
 *     advances a stream's checkpoint past `not_staged` after a real `STATE`
 *     commit, which a connector can only emit after its login-gated fetch for
 *     that stream actually completed (see e.g. reddit's `collectStream`,
 *     which emits `STATE` unconditionally right after its paginated fetch
 *     succeeds, regardless of item count).
 *   - `considered` is a declared, non-null value (including `0`) — connectors
 *     that don't checkpoint every zero-record run still emit a `DETAIL_COVERAGE`
 *     fact for their required list stream once its sweep completes without
 *     throwing, INCLUDING the zero-considered steady-state (see amazon's
 *     `emitOrdersCoverage`/`emitOrderItemsCoverage`, explicitly documented to
 *     always emit "after the year loop... including that zero-required
 *     steady-state case" so a brand-new, zero-order account still reads as
 *     measured rather than silently unmeasured).
 *
 * A run that dies before authenticating (e.g. `credential_rejected`, a
 * bot-challenge that aborts before any fetch) throws before either signal is
 * produced for any stream, so `collection_facts` is either absent or every
 * required-stream entry fails both checks — this deliberately does NOT trust
 * records_emitted, event_count, or terminal `status` alone.
 *
 * `recovery_only` runs are excluded unconditionally: a recovery-only pass
 * drains pending detail gaps only and performs no forward/list-pass inventory
 * scan, so even a genuinely successful one carries no `collection_facts`
 * block by design (see `buildCollectionFacts`'s own `recoveryOnly` branch) —
 * treating its absence as "no evidence" here, not as a false negative.
 */
export function hasAuthenticatedRequiredStreamEvidence(terminalData: unknown, manifest: unknown): boolean {
  if (!terminalData || typeof terminalData !== "object" || Array.isArray(terminalData)) {
    return false;
  }
  const data = terminalData as RunTerminalDataLike;
  if (data.recovery_only === true) {
    return false;
  }
  const requiredStreamNames = manifestRequiredStreamNames(manifest);
  if (requiredStreamNames.size === 0) {
    return false;
  }
  const streams = data.collection_facts?.streams;
  if (!Array.isArray(streams)) {
    return false;
  }
  return streams.some((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return false;
    }
    const entry = raw as RuntimeCollectionFactStreamLike;
    // `requiredStreamNames.has(entry.stream)` uses Set strict-equality, so a
    // non-string entry.stream (number/undefined/null/object) can never match
    // any string key here — no separate typeof guard needed.
    if (!requiredStreamNames.has(entry.stream as string)) {
      return false;
    }
    const checkpointProven = typeof entry.checkpoint === "string" && entry.checkpoint !== "not_staged";
    const consideredProven = typeof entry.considered === "number" && Number.isFinite(entry.considered);
    return checkpointProven || consideredProven;
  });
}

function getRefreshPolicy(manifest: unknown): RefreshPolicyLike | null {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return null;
  }
  const caps = (manifest as ManifestLike).capabilities;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) {
    return null;
  }
  const policy = caps.refresh_policy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return null;
  }
  return policy as RefreshPolicyLike;
}

function positiveIntegerOrDefault(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_ACTIVATION_INTERVAL_SECONDS;
}

export function resolveActivationRefreshContract(manifest: unknown): ActivationRefreshContract {
  const policy = getRefreshPolicy(manifest);
  const recommendedMode =
    policy?.recommended_mode === "automatic" ||
    policy?.recommended_mode === "manual" ||
    policy?.recommended_mode === "paused"
      ? policy.recommended_mode
      : null;
  const backgroundSafe = typeof policy?.background_safe === "boolean" ? policy.background_safe : null;
  const intervalSeconds = positiveIntegerOrDefault(policy?.recommended_interval_seconds);

  if (recommendedMode === "manual") {
    return {
      backgroundSafe,
      intervalSeconds,
      mode: "manual",
      reason: "manual",
      recommendedMode,
    };
  }
  if (recommendedMode === "paused") {
    return {
      backgroundSafe,
      intervalSeconds,
      mode: "manual",
      reason: "paused",
      recommendedMode,
    };
  }
  if (backgroundSafe === false) {
    return {
      backgroundSafe,
      intervalSeconds,
      mode: "manual",
      reason: "background_unsafe",
      recommendedMode,
    };
  }
  return {
    backgroundSafe,
    intervalSeconds,
    mode: "automatic",
    reason: "automatic",
    recommendedMode,
  };
}

export async function attachActivationScheduleIfAutomatic(input: {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly controller: ActivationScheduleController;
  readonly manifest: unknown;
}): Promise<ActivationScheduleResult> {
  const contract = resolveActivationRefreshContract(input.manifest);
  if (contract.mode !== "automatic") {
    return {
      attached: false,
      contract,
      reason: "manual_contract",
    };
  }

  const options = { connectorInstanceId: input.connectorInstanceId };
  const existing = await input.controller.getSchedule(input.connectorId, options);
  if (existing) {
    return {
      attached: false,
      contract,
      reason: "already_attached",
    };
  }

  await input.controller.upsertSchedule(
    input.connectorId,
    {
      enabled: true,
      interval_seconds: contract.intervalSeconds,
      jitter_seconds: 0,
    },
    options
  );
  return {
    attached: true,
    contract,
    reason: "attached",
  };
}
