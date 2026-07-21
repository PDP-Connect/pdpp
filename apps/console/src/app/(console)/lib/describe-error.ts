/**
 * Turn an authorization-server / reference-server error response body into a
 * single human-readable line suitable for an operator-facing banner.
 *
 * The reference server's error envelope is `{ error: { type, code, message,
 * request_id, ... } }`; OAuth surfaces use `{ error, error_description }`.
 * This helper extracts the most specific human message available and falls
 * back to a caller-supplied summary (usually `"<op> failed (<status>)"`) so
 * the operator never sees a raw JSON blob in the UI.
 *
 * Single source of truth: every `_ref`/`_rs`/OAuth client that surfaces a
 * thrown `Error.message` to an operator banner should route its non-ok
 * responses through this so the message is friendly, not the stringified
 * response body. Keeping the status in the `fallback` preserves server-side
 * diagnostics when no envelope message is present.
 */
export function describeError(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const maybeError = body as {
      error?: string | { message?: string };
      error_description?: string;
    };
    if (typeof maybeError.error_description === "string" && maybeError.error_description) {
      return maybeError.error_description;
    }
    if (typeof maybeError.error === "string" && maybeError.error) {
      return maybeError.error;
    }
    if (
      maybeError.error &&
      typeof maybeError.error === "object" &&
      typeof maybeError.error.message === "string" &&
      maybeError.error.message
    ) {
      return maybeError.error.message;
    }
  }
  if (typeof body === "string" && body.trim()) {
    return body.trim();
  }
  return fallback;
}

/**
 * Parse a response body string (which may or may not be JSON) and describe
 * it. Convenience for clients that hold the raw `await res.text()` string
 * rather than a parsed object.
 */
export function describeErrorText(bodyText: string, fallback: string): string {
  let parsed: unknown = bodyText;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    // Non-JSON body: describeError handles the raw string branch.
  }
  return describeError(parsed, fallback);
}
