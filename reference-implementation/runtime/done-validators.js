// DONE-message validators for the connector runtime.
//
// When a connector emits its terminal DONE envelope, the runtime cross-checks
// it against observed reality: the child's exit code must agree with the
// declared status, the reported records_emitted must match what the runtime
// counted, the status must be a known terminal value, and any error block must
// be well-shaped. Each validator returns an Error to raise (or, for
// validateDoneError, the normalized error object) or null when the field is
// acceptable.
//
// Extracted from runtime/index.js: pure shape/consistency checks with no
// runtime state, secret handling, or grant/scope enforcement.

export function validateDoneExitCode(doneMessage, exitCode) {
  if (!doneMessage) return null;
  if (doneMessage.status === 'succeeded' && exitCode !== 0) {
    return new Error(`Connector exit code ${exitCode} does not match DONE status: succeeded`);
  }
  if ((doneMessage.status === 'failed' || doneMessage.status === 'cancelled') && exitCode === 0) {
    return new Error(`Connector exit code ${exitCode} does not match DONE status: ${doneMessage.status}`);
  }
  return null;
}

export function validateDoneRecordsEmitted(doneMessage, observedRecordsEmitted) {
  if (!doneMessage) return null;
  if (!Number.isInteger(doneMessage.records_emitted) || doneMessage.records_emitted < 0) {
    return new Error(`Connector emitted invalid DONE.records_emitted: ${doneMessage.records_emitted}`);
  }
  if (doneMessage.records_emitted !== observedRecordsEmitted) {
    return new Error(
      `Connector reported records_emitted ${doneMessage.records_emitted} but runtime observed ${observedRecordsEmitted}`
    );
  }
  return null;
}

export function validateDoneStatus(status) {
  if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
    return null;
  }
  return new Error(`Connector emitted invalid DONE status: ${status}`);
}

const DONE_ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

export function validateDoneError(status, error) {
  if (error == null) return null;
  if (status === 'succeeded') {
    return new Error('Connector emitted invalid DONE.error: succeeded runs must not include terminal error details');
  }
  if (typeof error !== 'object' || Array.isArray(error)) {
    return new Error('Connector emitted invalid DONE.error: expected object');
  }
  const unsupportedFields = Object.keys(error).filter(
    (field) => field !== 'message' && field !== 'retryable' && field !== 'code',
  );
  if (unsupportedFields.length) {
    return new Error(`Connector emitted invalid DONE.error: unsupported fields ${unsupportedFields.join(', ')}`);
  }
  if (error.code != null && (typeof error.code !== 'string' || !DONE_ERROR_CODE_RE.test(error.code))) {
    return new Error('Connector emitted invalid DONE.error.code: expected bounded snake_case code');
  }
  if (typeof error.message !== 'string' || !error.message.trim()) {
    return new Error('Connector emitted invalid DONE.error.message: expected non-empty string');
  }
  if (error.retryable != null && typeof error.retryable !== 'boolean') {
    return new Error('Connector emitted invalid DONE.error.retryable: expected boolean');
  }
  return {
    ...(error.code ? { code: error.code } : {}),
    message: error.message.trim(),
    retryable: error.retryable ?? null,
  };
}
