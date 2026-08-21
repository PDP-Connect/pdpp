// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The one resolution path for a browser connector's sign-in credentials.
 *
 * ## Why this module exists
 *
 * A browser connector needs a username/password to drive a provider's own
 * sign-in form. There have historically been two ways to obtain them, and only
 * one of them is correct:
 *
 *  1. **`ctx.credentials`** — the runtime resolves the connector's declared
 *     `auth` block (`connector-runtime.ts`'s `resolveCredentials` →
 *     `@pdpp/connector-protocol/auth`) and threads the result through
 *     `establishSession` into `ensureSession({ credentials })`. When a
 *     credential is missing the runtime raises a `credentials` INTERACTION
 *     naming exactly which fields it needs, and the owner can supply them.
 *
 *  2. **`process.env.<CONNECTOR>_USERNAME`** read inside `ensureSession` — the
 *     shape `heb`, `chase`, `amazon`, `chatgpt`, `github`, and `reddit` used.
 *
 * Path 2 reaches the same values in the happy case, because the reference
 * server injects the connection-scoped fragment into the CHILD process env (see
 * `static-secret-injection.ts` and `runtime/connector-child-environment.ts` —
 * the child does NOT inherit the parent's environment, so a connector's
 * `process.env.HEB_USERNAME` is that one connection's secret, not a
 * process-global one). Path 2 is therefore not a security leak and not a
 * multi-account defect at the injection layer.
 *
 * What path 2 loses is everything the runtime built around path 1:
 *
 *  - **No declared `auth` block.** A connector that reads `process.env`
 *    directly has no reason to declare `auth`, and four of them
 *    (`heb`, `chase`, `amazon`, `chatgpt`) did not. With no declaration the
 *    runtime resolves `{}`, never prompts for the missing field, and never
 *    tells anyone a credential was expected.
 *  - **No precise failure.** When the value is absent the connector falls
 *    through to a generic "hand the page to the owner" branch whose message
 *    describes the PAGE ("sign-in form did not render", "unexpected UI"), not
 *    the CREDENTIAL. The owner is told the site broke when the truth is that
 *    no stored credential reached the run.
 *  - **No way to notice.** Nothing fails; the run just quietly asks for manual
 *    help within seconds, forever.
 *
 * This module makes path 1 the only path. `resolveLoginCredentials` takes the
 * `credentials` object the runtime already hands `ensureSession` and returns
 * either a complete credential pair or a typed, *specific* absence. The
 * companion lint gate (`scripts/check-no-direct-credential-env.ts`) makes path
 * 2 unrepresentable: reading `process.env.*_USERNAME` / `*_PASSWORD` anywhere
 * under `src/auto-login/` or `connectors/` fails the build.
 *
 * ## Multi-account
 *
 * Nothing here reads ambient state. The values come from the `credentials`
 * argument, which the runtime derived from THIS run's connection. Two
 * connections of the same connector therefore resolve two different pairs —
 * the case a process-global env var structurally cannot express.
 */

/** A resolved, complete credential pair for one connection's sign-in. */
export interface ResolvedLoginCredentials {
  readonly kind: "resolved";
  readonly password: string;
  readonly username: string;
}

/**
 * No usable credential for this connection. `missing` names the credential
 * fields that were absent, so the caller can say precisely what is missing
 * instead of blaming the provider's page.
 */
export interface AbsentLoginCredentials {
  readonly kind: "absent";
  /** The credential field names that were absent or blank. */
  readonly missing: readonly string[];
  /**
   * Owner-facing reason. Names the CREDENTIAL, never the page — the whole
   * point of the type. Safe to surface in an interaction message: it contains
   * only field NAMES, never a value.
   */
  readonly reason: string;
}

export type LoginCredentialsResolution = AbsentLoginCredentials | ResolvedLoginCredentials;

/**
 * Field names, as they appear in the runtime-resolved `credentials` object,
 * that carry one connector's sign-in pair. These are the same names the
 * connector declares in its `auth.required` block and the same names the
 * static-secret registry injects — one vocabulary, not three.
 */
export interface LoginCredentialFields {
  /** Credential field name(s) holding the password. First non-empty wins. */
  readonly password: readonly string[];
  /** Credential field name(s) holding the username/email. First non-empty wins. */
  readonly username: readonly string[];
}

function firstNonEmpty(
  credentials: Readonly<Record<string, string | undefined>>,
  names: readonly string[]
): string | undefined {
  for (const name of names) {
    const value = credentials[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  // No configured field carried a usable value. Returning explicitly keeps
  // `noImplicitReturns` satisfied and states the "no credential" case as a
  // real branch rather than an implicit fall-through.
  return undefined;
}

/**
 * Resolve one connection's sign-in pair from the runtime-supplied credentials.
 *
 * Returns a discriminated result rather than throwing or returning
 * `undefined`: an absent credential is a normal, expected state (the owner may
 * have deliberately chosen to sign in by hand), but it must be *named* as such
 * so the caller cannot silently conflate it with a page failure.
 *
 * A pair is BOTH-OR-NOTHING. A username with no password is reported absent
 * with the password named as missing, never submitted as half a login — the
 * same fail-closed rule `injectSecretBundle` applies one layer down.
 */
export function resolveLoginCredentials(
  credentials: Readonly<Record<string, string | undefined>> | undefined,
  fields: LoginCredentialFields,
  connectorName: string
): LoginCredentialsResolution {
  const source = credentials ?? {};
  const username = firstNonEmpty(source, fields.username);
  const password = firstNonEmpty(source, fields.password);
  if (username && password) {
    return { kind: "resolved", password, username };
  }
  const missing: string[] = [];
  if (!username) {
    missing.push(fields.username[0] ?? "username");
  }
  if (!password) {
    missing.push(fields.password[0] ?? "password");
  }
  return {
    kind: "absent",
    missing,
    reason: noStoredCredentialReason(connectorName, missing),
  };
}

/**
 * The owner-facing sentence for an absent credential.
 *
 * Deliberately says "no stored credential for this connection" rather than
 * anything about the page. Before this existed, a run with no credential
 * reported "sign-in form did not render" / "unexpected UI" — which reads as a
 * provider outage and sent owners to debug the wrong thing.
 */
export function noStoredCredentialReason(connectorName: string, missing: readonly string[]): string {
  const fieldList = missing.length > 0 ? missing.join(", ") : "username, password";
  return (
    `no stored credential for this ${connectorName} connection (missing: ${fieldList}). ` +
    "Automated sign-in was not attempted. Save this connection's credentials to enable it."
  );
}
