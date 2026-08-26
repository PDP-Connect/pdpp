// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Decide whether the Sources error boundary should try the same render again.
 *
 * Typed, deterministic client failures must be rendered by the server page
 * before Next.js redacts their message for the browser. The error boundary is
 * still defensive for client-originated typed errors; all other errors retain
 * the existing quiet recovery path for RSC stream-close races.
 */
export function isDeterministicSourcesReadError(error: unknown): error is { message: string; status: number } {
  if (!error || typeof error !== "object" || !("message" in error) || !("status" in error)) {
    return false;
  }
  const { message, status } = error as { message?: unknown; status?: unknown };
  // 408 and 429 are client-class statuses with a normal transient recovery
  // story. The remaining 4xx responses describe a request/configuration
  // problem that repeating unchanged cannot solve.
  return (
    typeof message === "string" &&
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

export function shouldRetrySourcesReadError(error: unknown): boolean {
  return !isDeterministicSourcesReadError(error);
}
