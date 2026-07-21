// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Closed-pipe write error classifier shared by the connector runtime and the
// CLI entrypoint guard. See:
//   openspec/changes/harden-reference-runtime-reliability/design.md
//
// Closed-pipe writes raised on owned, non-essential output streams (process
// stdio for the CLI; connector child stdio for the runtime) are an
// operational condition, not a programmer bug. Anything else SHALL fall
// through to the existing fatal-exit path.

const CLOSED_PIPE_CODES = new Set(["EPIPE", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]);

/**
 * Returns true iff `err` is a write-side closed-pipe error. The shape we
 * accept is intentionally narrow:
 *   - it must be an Error;
 *   - `code` must be in CLOSED_PIPE_CODES; and
 *   - if `syscall` is set, it must be 'write' (Node sets this for EPIPE
 *     from stdio writes; the synthesized stream-error codes don't always
 *     carry syscall, so we accept them when syscall is missing).
 *
 * Anything else returns false — including unrelated errors that happen to
 * carry an EPIPE-looking message.
 */
export function isClosedPipeWriteError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string" || !CLOSED_PIPE_CODES.has(code)) {
    return false;
  }
  const syscall = (err as { syscall?: unknown }).syscall;
  if (syscall && syscall !== "write") {
    return false;
  }
  return true;
}

export const CLOSED_PIPE_ERROR_CODES: ReadonlySet<string> = CLOSED_PIPE_CODES;
