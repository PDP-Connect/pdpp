// PROGRESS-message sub-validators for the connector runtime.
//
// A PROGRESS envelope may carry an optional provider-budget circuit-transition
// block and/or a collection-rate block. These validators enforce the shape and
// numeric bounds of those sub-objects, throwing on the first violation.
//
// Extracted from runtime/index.js: pure enum/numeric shape checks with no
// runtime state, secret handling, or grant/scope enforcement.

const PROVIDER_BUDGET_PROGRESS_OBJECTS = new Set(['provider_budget_circuit_transition']);
const PROVIDER_BUDGET_CIRCUIT_STATES = new Set(['closed', 'half_open', 'open']);
const PROVIDER_BUDGET_CIRCUIT_REASONS = new Set([
  'provider_failure',
  'provider_throttle',
  'reset_timeout',
  'success',
]);
const PROVIDER_BUDGET_CIRCUIT_TRIGGERS = new Set([
  'before_request',
  'provider_failure',
  'provider_throttle',
  'success',
]);

export function validateProgressProviderBudget(providerBudget) {
  if (!providerBudget || typeof providerBudget !== 'object' || Array.isArray(providerBudget)) {
    throw new Error('Connector emitted invalid PROGRESS.provider_budget: expected object');
  }
  if (!PROVIDER_BUDGET_PROGRESS_OBJECTS.has(providerBudget.object)) {
    throw new Error('Connector emitted invalid PROGRESS.provider_budget.object');
  }
  const circuit = providerBudget.circuit;
  if (!circuit || typeof circuit !== 'object' || Array.isArray(circuit)) {
    throw new Error('Connector emitted invalid PROGRESS.provider_budget.circuit: expected object');
  }
  if (!PROVIDER_BUDGET_CIRCUIT_STATES.has(circuit.previous_state)) {
    throw new Error('Connector emitted invalid PROGRESS.provider_budget.circuit.previous_state');
  }
  if (!PROVIDER_BUDGET_CIRCUIT_STATES.has(circuit.state)) {
    throw new Error('Connector emitted invalid PROGRESS.provider_budget.circuit.state');
  }
  if (!PROVIDER_BUDGET_CIRCUIT_REASONS.has(circuit.reason)) {
    throw new Error('Connector emitted invalid PROGRESS.provider_budget.circuit.reason');
  }
  if (!PROVIDER_BUDGET_CIRCUIT_TRIGGERS.has(circuit.trigger)) {
    throw new Error('Connector emitted invalid PROGRESS.provider_budget.circuit.trigger');
  }
  for (const fieldName of ['elapsed_ms', 'request_count']) {
    const value = providerBudget[fieldName];
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Connector emitted invalid PROGRESS.provider_budget.${fieldName}`);
    }
  }
  const retryTokensRemaining = providerBudget.retry_tokens_remaining;
  if (
    retryTokensRemaining != null
    && retryTokensRemaining !== 'unbounded'
    && (!Number.isFinite(retryTokensRemaining) || retryTokensRemaining < 0)
  ) {
    throw new Error('Connector emitted invalid PROGRESS.provider_budget.retry_tokens_remaining');
  }
}

const COLLECTION_RATE_BACKOFF_REASONS = new Set(['retry_after', 'throttle']);

function validateCollectionRateRequiredNumbers(collectionRate) {
  for (const fieldName of ['ceiling_interval_ms', 'ceiling_rate_per_min', 'current_interval_ms', 'effective_rate_per_min']) {
    const value = collectionRate[fieldName];
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Connector emitted invalid PROGRESS.collection_rate.${fieldName}: expected non-negative number`);
    }
  }
}

function validateCollectionRateLastBackoff(lastBackoff) {
  if (lastBackoff != null) {
    if (!lastBackoff || typeof lastBackoff !== 'object' || Array.isArray(lastBackoff)) {
      throw new Error('Connector emitted invalid PROGRESS.collection_rate.last_backoff: expected object or null');
    }
    if (!Number.isFinite(lastBackoff.at_interval_ms) || lastBackoff.at_interval_ms < 0) {
      throw new Error('Connector emitted invalid PROGRESS.collection_rate.last_backoff.at_interval_ms');
    }
    if (!COLLECTION_RATE_BACKOFF_REASONS.has(lastBackoff.reason)) {
      throw new Error('Connector emitted invalid PROGRESS.collection_rate.last_backoff.reason');
    }
  }
}

export function validateProgressCollectionRate(collectionRate) {
  if (!collectionRate || typeof collectionRate !== 'object' || Array.isArray(collectionRate)) {
    throw new Error('Connector emitted invalid PROGRESS.collection_rate: expected object');
  }
  if (collectionRate.object !== 'collection_rate') {
    throw new Error('Connector emitted invalid PROGRESS.collection_rate.object');
  }
  validateCollectionRateRequiredNumbers(collectionRate);
  validateCollectionRateLastBackoff(collectionRate.last_backoff);
}
