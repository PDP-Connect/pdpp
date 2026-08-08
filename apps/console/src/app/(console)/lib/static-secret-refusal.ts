// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Classification for a static-secret credential capture that the reference
 * server REFUSED — the decision that keeps the owner on the credential form
 * with a real reason instead of a silent success.
 *
 * Split out of `ref-client.ts` so it is directly executable under `node:test`:
 * that module imports `server-only` (via `owner-token.ts`) and cannot run in a
 * plain test process. The rule below is the whole owner-visible contract, so it
 * is tested for real rather than pinned by a source regex.
 *
 * Two refusal classes exist, and they matter to the owner for the same reason —
 * NOTHING WAS STORED and the previous credential is still in place:
 *   - 400 `static_secret_credential_rejected` — the provider itself rejected
 *     the secret (bad password, wrong mailbox).
 *   - 409 `static_secret_…` — the secret may be perfectly valid, but replacing
 *     the credential on THIS connection cannot be proven safe (identity
 *     mismatch/conflict/ambiguity, unverified replacement, invalid binding).
 *     See `reference-implementation/server/routes/ref-error-status.ts`.
 *
 * Connector-agnostic by construction: the classification reads HTTP status and
 * the error envelope only. Nothing here knows Gmail from Jellyfin, Steam, or
 * GroupMe — a connector-specific branch in the Console would be a defect.
 */

/**
 * Extract the reference error envelope's `error.code`.
 *
 * The envelope is `{ error: { code, message, ... } }`; some surfaces send a
 * bare `{ error: "<code>" }`. Returns null for a non-JSON or code-less body.
 */
export function refErrorCode(bodyText: string): string | null {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { code?: unknown } | string };
    const code = typeof parsed.error === "object" && parsed.error ? parsed.error.code : parsed.error;
    return typeof code === "string" && code ? code : null;
  } catch {
    return null;
  }
}

/**
 * True when a capture response is an owner-actionable refusal that stored
 * nothing.
 *
 * Every 409 qualifies, matched by STATUS rather than by an allowlist of the
 * seven `static_secret_*` conflict codes. That is deliberate: the reference may
 * add a conflict code, and a code the Console has never heard of must still
 * reach the owner carrying the server's own message — never fall through to a
 * generic crash banner, and never be mistaken for a successful save.
 */
export function isCredentialRefusal(status: number, code: string | null): boolean {
  if (status === 409) {
    return true;
  }
  return status === 400 && code === "static_secret_credential_rejected";
}
