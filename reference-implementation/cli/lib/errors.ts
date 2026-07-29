// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Free-form error payload attached to a CLI error: an HTTP error's `details`
// carries `status`/`body` plus whatever the reference-query metadata (see
// fetch.ts) merges in; a usage error's `details` is caller-supplied and has
// no fixed shape. Both are opaque to callers except through the typed
// subclasses' own fields (PdppHttpError.status/body/requestId/...).
export type PdppCliErrorDetails = Record<string, unknown>;

export class PdppCliError extends Error {
  exitCode: number;
  details: PdppCliErrorDetails | null;

  constructor(message: string, exitCode = 1, details: PdppCliErrorDetails | null = null) {
    super(message);
    this.name = "PdppCliError";
    this.exitCode = exitCode;
    this.details = details;
  }
}

export class PdppUsageError extends PdppCliError {
  constructor(message: string, details: PdppCliErrorDetails | null = null) {
    super(message, 2, details);
    this.name = "PdppUsageError";
  }
}

// The reference-query metadata a response can carry (see
// extractReferenceQueryMetadata in fetch.ts); optional because most HTTP
// error responses do not include either header.
export interface PdppHttpErrorResponseMetadata {
  reference_trace_id?: string | null;
  request_id?: string | null;
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
    responseMetadata: PdppHttpErrorResponseMetadata | null = null
  ) {
    super(message, exitCodeForStatus(status), {
      body,
      status,
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
