/**
 * Canonical `as.introspect` operation.
 *
 * Owns the RFC 7662-style introspection envelope semantics for `POST
 * /introspect`: token-presence validation, the call into the introspect
 * capability, and the redaction of the AS-internal
 * `grant_storage_binding` field from the public response.
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres,
 *   raw SQL handles, server-internal route/auth modules, sandbox modules, or
 *   `process` / `process.env`.
 */

export interface AsIntrospectInput {
  readonly token: string | null | undefined;
}

export type AsIntrospectInfo = Record<string, unknown> & {
  active?: boolean;
};

export interface AsIntrospectDependencies {
  introspect(token: string): Promise<AsIntrospectInfo> | AsIntrospectInfo;
}

export interface AsIntrospectSuccessOutcome {
  readonly outcome: "success";
  readonly publicInfo: AsIntrospectInfo;
}

export interface AsIntrospectFailureOutcome {
  readonly outcome: "failure";
  readonly status: 400;
  readonly errorCode: "invalid_request";
  readonly errorMessage: string;
}

export type AsIntrospectOutcome =
  | AsIntrospectSuccessOutcome
  | AsIntrospectFailureOutcome;

export async function executeAsIntrospect(
  input: AsIntrospectInput,
  deps: AsIntrospectDependencies,
): Promise<AsIntrospectOutcome> {
  if (!input.token) {
    return {
      outcome: "failure",
      status: 400,
      errorCode: "invalid_request",
      errorMessage: "Missing token parameter",
    };
  }
  const info = await deps.introspect(input.token);
  // The AS-internal `grant_storage_binding` field is never returned to
  // introspection callers. Redaction lives in the operation so any future
  // host that mounts this surface inherits the rule automatically.
  const { grant_storage_binding: _redacted, ...publicInfo } = info as Record<
    string,
    unknown
  >;
  return {
    outcome: "success",
    publicInfo: publicInfo as AsIntrospectInfo,
  };
}
