// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The reference run-now routes use the shared typed error envelope. Keep the
 * console's run-start boundary equally small: status and a validated stable
 * code are enough to choose an owner action, while the only body value that
 * may cross the boundary is the validated incumbent run id.
 *
 * Do not retain or display the upstream message here. Connector/provider
 * messages are not an owner-safe protocol field and may contain credentials,
 * request payloads, or internal paths.
 */

const SAFE_ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_RUN_ID_RE = /^run_[A-Za-z0-9_-]{1,127}$/;

export const RUN_NOW_ALREADY_ACTIVE_MESSAGE = "Sync already in progress.";
export const RUN_NOW_UNREACHABLE_MESSAGE =
  "Couldn't reach the reference server, so the sync was not started. Check the deployment is running, then retry.";
export const RUN_NOW_UNEXPECTED_MESSAGE =
  "The sync could not be started because the reference server returned an unexpected response.";

export interface SafeRunNowErrorBody {
  readonly code: string | null;
  readonly run_id: string | null;
}

interface RecordLike {
  readonly [key: string]: unknown;
}

function asRecord(value: unknown): RecordLike | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordLike) : null;
}

function safeErrorCode(value: unknown): string | null {
  return typeof value === "string" && SAFE_ERROR_CODE_RE.test(value) ? value : null;
}

export function isSafeRunId(value: unknown): value is string {
  return typeof value === "string" && SAFE_RUN_ID_RE.test(value);
}

function safeRunId(value: unknown): string | null {
  return isSafeRunId(value) ? value : null;
}

/**
 * Read only the stable, non-secret fields needed by the run-now actions.
 * Malformed bodies and untrusted message fields intentionally collapse to
 * null rather than being copied into an Error or a redirect query string.
 */
export function safeRunNowErrorBody(body: unknown): SafeRunNowErrorBody {
  const outer = asRecord(body);
  const error = asRecord(outer?.error);
  return {
    code: safeErrorCode(error?.code),
    run_id: safeRunId(error?.run_id ?? outer?.run_id),
  };
}

function requestErrorMessage(status: number, code: string | null): string {
  if (status === 409 && code === "run_already_active") {
    return RUN_NOW_ALREADY_ACTIVE_MESSAGE;
  }
  return code
    ? `The reference server rejected the sync request with code ${code} (HTTP ${status}).`
    : `The reference server rejected the sync request (HTTP ${status}).`;
}

export class RunNowRequestError extends Error {
  readonly body: SafeRunNowErrorBody;
  readonly code: string | null;
  readonly runId: string | null;
  readonly status: number;

  constructor(status: number, body: unknown) {
    const safeBody = safeRunNowErrorBody(body);
    super(requestErrorMessage(status, safeBody.code));
    this.name = "RunNowRequestError";
    this.body = safeBody;
    this.code = safeBody.code;
    this.runId = safeBody.run_id;
    this.status = status;
  }
}

export function runNowFailureMessage(error: Pick<RunNowRequestError, "code" | "status">): string {
  return requestErrorMessage(error.status, error.code);
}
