// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// PROGRESS-message sub-validators for the connector runtime.
//
// A PROGRESS envelope may carry an optional provider-budget circuit-transition
// block and/or a collection-rate block. These validators enforce the shape and
// numeric bounds of those sub-objects, throwing on the first violation.
//
// Extracted from runtime/index.js: pure enum/numeric shape checks with no
// runtime state, secret handling, or grant/scope enforcement.

const PROVIDER_BUDGET_PROGRESS_OBJECTS = new Set(["provider_budget_circuit_transition"]);
const PROVIDER_BUDGET_CIRCUIT_STATES = new Set(["closed", "half_open", "open"]);
const PROVIDER_BUDGET_CIRCUIT_REASONS = new Set(["provider_failure", "provider_throttle", "reset_timeout", "success"]);
const PROVIDER_BUDGET_CIRCUIT_TRIGGERS = new Set([
  "before_request",
  "provider_failure",
  "provider_throttle",
  "success",
]);

interface ProviderBudgetCircuit {
  previous_state: string;
  reason: string;
  state: string;
  trigger: string;
  [key: string]: unknown;
}

interface ProviderBudget {
  circuit: ProviderBudgetCircuit;
  elapsed_ms?: number;
  object: string;
  request_count?: number;
  retry_tokens_remaining?: number | string | null;
  [key: string]: unknown;
}

export function validateProgressProviderBudget(providerBudget: unknown): void {
  if (!providerBudget || typeof providerBudget !== "object" || Array.isArray(providerBudget)) {
    throw new Error("Connector emitted invalid PROGRESS.provider_budget: expected object");
  }
  const budget = providerBudget as ProviderBudget;
  if (!PROVIDER_BUDGET_PROGRESS_OBJECTS.has(budget.object)) {
    throw new Error("Connector emitted invalid PROGRESS.provider_budget.object");
  }
  const { circuit } = budget;
  if (!circuit || typeof circuit !== "object" || Array.isArray(circuit)) {
    throw new Error("Connector emitted invalid PROGRESS.provider_budget.circuit: expected object");
  }
  if (!PROVIDER_BUDGET_CIRCUIT_STATES.has(circuit.previous_state)) {
    throw new Error("Connector emitted invalid PROGRESS.provider_budget.circuit.previous_state");
  }
  if (!PROVIDER_BUDGET_CIRCUIT_STATES.has(circuit.state)) {
    throw new Error("Connector emitted invalid PROGRESS.provider_budget.circuit.state");
  }
  if (!PROVIDER_BUDGET_CIRCUIT_REASONS.has(circuit.reason)) {
    throw new Error("Connector emitted invalid PROGRESS.provider_budget.circuit.reason");
  }
  if (!PROVIDER_BUDGET_CIRCUIT_TRIGGERS.has(circuit.trigger)) {
    throw new Error("Connector emitted invalid PROGRESS.provider_budget.circuit.trigger");
  }
  for (const fieldName of ["elapsed_ms", "request_count"]) {
    const value = budget[fieldName as keyof ProviderBudget];
    if (!Number.isFinite(value as number) || (value as number) < 0) {
      throw new Error(`Connector emitted invalid PROGRESS.provider_budget.${fieldName}`);
    }
  }
  const retryTokensRemaining = budget.retry_tokens_remaining;
  if (
    // biome-ignore lint/suspicious/noEqualsToNull: check for both null and undefined
    retryTokensRemaining != null &&
    retryTokensRemaining !== "unbounded" &&
    (!Number.isFinite(retryTokensRemaining as number) || (retryTokensRemaining as number) < 0)
  ) {
    throw new Error("Connector emitted invalid PROGRESS.provider_budget.retry_tokens_remaining");
  }
}

const COLLECTION_RATE_BACKOFF_REASONS = new Set(["retry_after", "throttle"]);

interface LastBackoff {
  at_interval_ms: number;
  reason: string;
  [key: string]: unknown;
}

interface CollectionRate {
  ceiling_interval_ms: number;
  ceiling_rate_per_min: number;
  current_interval_ms: number;
  effective_rate_per_min: number;
  last_backoff?: LastBackoff | null;
  object: string;
  [key: string]: unknown;
}

function validateCollectionRateRequiredNumbers(collectionRate: unknown): void {
  const rate = collectionRate as CollectionRate;
  for (const fieldName of [
    "ceiling_interval_ms",
    "ceiling_rate_per_min",
    "current_interval_ms",
    "effective_rate_per_min",
  ]) {
    const value = rate[fieldName as keyof CollectionRate];
    if (!Number.isFinite(value as number) || (value as number) < 0) {
      throw new Error(`Connector emitted invalid PROGRESS.collection_rate.${fieldName}: expected non-negative number`);
    }
  }
}

function validateCollectionRateLastBackoff(lastBackoff: unknown): void {
  // biome-ignore lint/suspicious/noEqualsToNull: check for both null and undefined
  if (lastBackoff != null) {
    if (!lastBackoff || typeof lastBackoff !== "object" || Array.isArray(lastBackoff)) {
      throw new Error("Connector emitted invalid PROGRESS.collection_rate.last_backoff: expected object or null");
    }
    const backoff = lastBackoff as LastBackoff;
    if (!Number.isFinite(backoff.at_interval_ms) || backoff.at_interval_ms < 0) {
      throw new Error("Connector emitted invalid PROGRESS.collection_rate.last_backoff.at_interval_ms");
    }
    if (!COLLECTION_RATE_BACKOFF_REASONS.has(backoff.reason)) {
      throw new Error("Connector emitted invalid PROGRESS.collection_rate.last_backoff.reason");
    }
  }
}

export function validateProgressCollectionRate(collectionRate: unknown): void {
  if (!collectionRate || typeof collectionRate !== "object" || Array.isArray(collectionRate)) {
    throw new Error("Connector emitted invalid PROGRESS.collection_rate: expected object");
  }
  const rate = collectionRate as CollectionRate;
  if (rate.object !== "collection_rate") {
    throw new Error("Connector emitted invalid PROGRESS.collection_rate.object");
  }
  validateCollectionRateRequiredNumbers(collectionRate);
  validateCollectionRateLastBackoff(rate.last_backoff);
}

const ATTACHMENT_RECOVERY_OUTCOME_FIELDS = new Set([
  "admitted",
  "admitted_bytes",
  "attempted",
  "hydration_failed",
  "lookup_miss",
  "metadata_lookups",
  "object",
  "recovered",
  "run_cap_deferred",
  "served",
]);
const ATTACHMENT_HYDRATION_FAILURE_OUTCOME_FIELDS = new Set([
  "blob_upload_http_4xx",
  "blob_upload_http_5xx",
  "blob_upload_integrity_failed",
  "blob_upload_invalid_response",
  "blob_upload_transport_failed",
  "imap_download_failed",
  "object",
  "unclassified_failed",
]);

interface AttachmentRecoveryOutcome {
  object: string;
  [key: string]: unknown;
}

interface AttachmentHydrationFailureOutcome {
  object: string;
  [key: string]: unknown;
}

export function validateProgressAttachmentRecoveryOutcome(outcome: unknown): void {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
    throw new Error("Connector emitted invalid PROGRESS.attachment_recovery_outcome: expected object");
  }
  const recoveryOutcome = outcome as AttachmentRecoveryOutcome;
  if (recoveryOutcome.object !== "attachment_recovery_outcome") {
    throw new Error("Connector emitted invalid PROGRESS.attachment_recovery_outcome.object");
  }
  const fields = Object.keys(recoveryOutcome);
  if (
    fields.length !== ATTACHMENT_RECOVERY_OUTCOME_FIELDS.size ||
    fields.some((field) => !ATTACHMENT_RECOVERY_OUTCOME_FIELDS.has(field))
  ) {
    throw new Error("Connector emitted invalid PROGRESS.attachment_recovery_outcome: unexpected field");
  }
  for (const fieldName of ATTACHMENT_RECOVERY_OUTCOME_FIELDS) {
    if (fieldName === "object") {
      continue;
    }
    const value = recoveryOutcome[fieldName];
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new Error(
        `Connector emitted invalid PROGRESS.attachment_recovery_outcome.${fieldName}: expected non-negative integer`
      );
    }
  }
}

export function validateProgressAttachmentHydrationFailureOutcome(outcome: unknown): void {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
    throw new Error("Connector emitted invalid PROGRESS.attachment_hydration_failure_outcome: expected object");
  }
  const failureOutcome = outcome as AttachmentHydrationFailureOutcome;
  if (failureOutcome.object !== "attachment_hydration_failure_outcome") {
    throw new Error("Connector emitted invalid PROGRESS.attachment_hydration_failure_outcome.object");
  }
  const fields = Object.keys(failureOutcome);
  if (
    fields.length !== ATTACHMENT_HYDRATION_FAILURE_OUTCOME_FIELDS.size ||
    fields.some((field) => !ATTACHMENT_HYDRATION_FAILURE_OUTCOME_FIELDS.has(field))
  ) {
    throw new Error("Connector emitted invalid PROGRESS.attachment_hydration_failure_outcome: unexpected field");
  }
  for (const fieldName of ATTACHMENT_HYDRATION_FAILURE_OUTCOME_FIELDS) {
    if (fieldName === "object") {
      continue;
    }
    const value = failureOutcome[fieldName];
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new Error(
        `Connector emitted invalid PROGRESS.attachment_hydration_failure_outcome.${fieldName}: expected non-negative integer`
      );
    }
  }
}

export function validateProgressAttachmentHydrationFailureOutcomeSum(
  recoveryOutcome: AttachmentRecoveryOutcome | null | undefined,
  failureOutcome: AttachmentHydrationFailureOutcome | null | undefined
): void {
  // biome-ignore lint/suspicious/noEqualsToNull: check for both null and undefined
  if (recoveryOutcome == null && failureOutcome == null) {
    return;
  }
  // biome-ignore lint/suspicious/noEqualsToNull: check for both null and undefined
  if (recoveryOutcome == null || failureOutcome == null) {
    throw new Error(
      "Connector emitted invalid PROGRESS.attachment_recovery_aggregates: attachment_recovery_outcome and attachment_hydration_failure_outcome must be emitted together"
    );
  }
  const stagesTotal = Object.entries(failureOutcome)
    .filter(([fieldName]) => fieldName !== "object")
    .reduce((total, [, count]) => total + (count as number), 0);
  if (stagesTotal !== recoveryOutcome.hydration_failed) {
    throw new Error(
      "Connector emitted invalid PROGRESS.attachment_hydration_failure_aggregate: stage counters must sum to attachment_recovery_outcome.hydration_failed"
    );
  }
}
