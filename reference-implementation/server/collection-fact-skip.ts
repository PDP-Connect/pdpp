// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeCollectionFactSkip } from "./ref-control.ts";

type SkipRecord = Record<string, unknown>;

function isRecord(value: unknown): value is SkipRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalFields(skip: SkipRecord): Omit<RuntimeCollectionFactSkip, "reason"> {
  return {
    ...(typeof skip.recovery_action === "string" ? { recovery_action: skip.recovery_action } : {}),
    ...(typeof skip.recovery_retryable === "boolean" ? { recovery_retryable: skip.recovery_retryable } : {}),
    ...(typeof skip.severity === "string" ? { severity: skip.severity } : {}),
  };
}

/** Parse the bounded skip fact carried in runtime collection facts. */
export function readCollectionFactSkip(value: unknown): RuntimeCollectionFactSkip | null {
  if (!isRecord(value) || typeof value.reason !== "string") {
    return null;
  }
  return { reason: value.reason, ...optionalFields(value) };
}

/** A retryable fact is always unfinished work, independent of its reason. */
export function isRetryableCollectionFactSkip(skip: RuntimeCollectionFactSkip): boolean {
  return skip.recovery_retryable === true || skip.recovery_action === "retry_by_runtime";
}
