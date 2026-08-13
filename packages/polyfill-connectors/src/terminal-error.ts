// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The typed terminal-failure primitive shared by the connector runtime and
 * the session-establishment flow (`session-establish.ts`). Kept in its own
 * module so both can construct/instanceof-check the same class without a
 * runtime import cycle. Connectors never import this module directly: their
 * constructor is `createConnectorFailure` in `connector-runtime.ts`, which
 * composes this class with the code-charset gate below.
 */

export interface TerminalErrorDetails {
  code?: string;
  message: string;
  /** Provider-neutral action for the runtime to preserve on DONE.error. */
  recovery_hint?: string | { action: string; retryable?: boolean };
  retryable: boolean;
}

/**
 * A failure that the runtime should convert to a terminal DONE rather than
 * let it bubble as an unhandled rejection. Carries an explicit `retryable`
 * bit so the outer catch doesn't have to heuristically pattern-match the
 * message. The optional `code` carries a stable, infrastructure-set
 * machine-actionable code (e.g. `browser_surface_attach_exhausted`) through
 * to `DONE.error.code` — see `emitFailed`'s composition with a connector's
 * `normalizeTerminalError` for how this survives connector overrides.
 */
export class TerminalError extends Error {
  readonly code?: string;
  readonly retryable: boolean;
  constructor(message: string, options: { cause?: unknown; code?: string; retryable?: boolean } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TerminalError";
    this.retryable = options.retryable ?? false;
    if (options.code !== undefined) {
      this.code = options.code;
    }
  }
}

/**
 * `DONE.error.code` / `connector_error_code` is a TYPED channel, deliberately
 * exempt from the free-form redaction `boundConnectorErrorMessage` applies to
 * `DONE.error.message` / `connector_error_message` (see
 * `runtime/index.ts`'s `buildTerminalConnectorFields`: `code` is copied
 * verbatim, `message` is redacted). That is safe ONLY because `code` is
 * constrained to a small, connector-declared, machine-actionable vocabulary —
 * never derived from arbitrary thrown text, and never able to carry the kind
 * of free-form content (a URL, a stack trace, an echoed request body) that
 * could smuggle a secret through unredacted. This pattern is deliberately
 * narrow: short, lowercase, snake_case, no spaces/URLs/punctuation beyond
 * underscore. A connector-authored string this restrictive cannot encode a
 * credential, a session token, or PII — those all fail the length or charset
 * check and the connector gets a thrown ProgrammerError instead of a silently
 * accepted unsafe code.
 */
const CONNECTOR_ERROR_CODE_RE = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Validate a connector-declared terminal-error `code` against the strict
 * charset/length contract `CONNECTOR_ERROR_CODE_RE` documents. Throws
 * (fails closed) rather than silently truncating, stripping, or passing an
 * invalid code through — an invalid code is a connector programming error,
 * not a runtime condition to paper over, because `code` reaches
 * `connector_error_json` with no further redaction.
 */
export function assertValidConnectorErrorCode(code: string): void {
  if (!CONNECTOR_ERROR_CODE_RE.test(code)) {
    throw new Error(
      `connector_failure_invalid_code: "${code}" must match ${CONNECTOR_ERROR_CODE_RE.source} ` +
        "(short, lowercase, snake_case — this channel is never redacted, so it cannot carry arbitrary text)"
    );
  }
}
