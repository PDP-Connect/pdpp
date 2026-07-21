// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export class PdppCliError extends Error {
  constructor(message, exitCode = 1, details = null) {
    super(message);
    this.name = 'PdppCliError';
    this.exitCode = exitCode;
    this.details = details;
  }
}

export class PdppUsageError extends PdppCliError {
  constructor(message, details = null) {
    super(message, 2, details);
    this.name = 'PdppUsageError';
  }
}

export class PdppHttpError extends PdppCliError {
  constructor(message, status, body = null, responseMetadata = null) {
    super(message, exitCodeForStatus(status), {
      status,
      body,
      ...(responseMetadata || {}),
    });
    this.name = 'PdppHttpError';
    this.status = status;
    this.body = body;
    this.requestId = responseMetadata?.request_id || null;
    this.referenceTraceId = responseMetadata?.reference_trace_id || null;
  }
}

function exitCodeForStatus(status) {
  if (status === 401) return 3;
  if (status === 403) return 4;
  if (status === 404) return 5;
  return 1;
}
