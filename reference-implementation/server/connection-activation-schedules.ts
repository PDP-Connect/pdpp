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
  getSchedule(connectorId: string, options?: { connectorInstanceId?: string | null }): Promise<ScheduleApi | null>;
  upsertSchedule(
    connectorId: string,
    input: ConnectorSchedulePatch,
    options?: { connectorInstanceId?: string | null }
  ): Promise<ScheduleUpsertResult>;
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
