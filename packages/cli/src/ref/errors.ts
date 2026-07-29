// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export interface PdppHttpResponseMetadata {
  reference_trace_id?: string | null;
  request_id?: string | null;
  [key: string]: unknown;
}

export class PdppCliError extends Error {
  exitCode: number;
  details: unknown;

  constructor(message: string, exitCode = 1, details: unknown = null) {
    super(message);
    this.name = "PdppCliError";
    this.exitCode = exitCode;
    this.details = details;
  }
}

export class PdppUsageError extends PdppCliError {
  constructor(message: string, details: unknown = null) {
    super(message, 2, details);
    this.name = "PdppUsageError";
  }
}

export class PdppHttpError extends PdppCliError {
  status: number;
  body: unknown;
  requestId: string | null;
  referenceTraceId: string | null;

  constructor(
    message: string,
    status: number,
    body: unknown = null,
    responseMetadata: PdppHttpResponseMetadata | null = null
  ) {
    super(message, exitCodeForStatus(status), {
      status,
      body,
      ...(responseMetadata || {}),
    });
    this.name = "PdppHttpError";
    this.status = status;
    this.body = body;
    this.requestId = responseMetadata?.request_id || null;
    this.referenceTraceId = responseMetadata?.reference_trace_id || null;
  }
}

function exitCodeForStatus(status: number): number {
  if (status === 401) {
    return 3;
  }
  if (status === 403) {
    return 4;
  }
  if (status === 404) {
    return 5;
  }
  return 1;
}
