// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `as.introspect` operation.
 *
 * Owns the RFC 7662-style introspection envelope semantics for `POST
 * /introspect`: token-presence validation, the call into the introspect
 * capability, and the optional projection of the AS-internal
 * `grant_storage_binding` field for a confidential resource server.
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
  includeStorageBinding?: boolean;
  introspect: (token: string) => Promise<AsIntrospectInfo> | AsIntrospectInfo;
}

export interface AsIntrospectSuccessOutcome {
  readonly outcome: "success";
  readonly publicInfo: AsIntrospectInfo;
}

export interface AsIntrospectFailureOutcome {
  readonly errorCode: "invalid_request";
  readonly errorMessage: string;
  readonly outcome: "failure";
  readonly status: 400;
}

export type AsIntrospectOutcome = AsIntrospectSuccessOutcome | AsIntrospectFailureOutcome;

export async function executeAsIntrospect(
  input: AsIntrospectInput,
  deps: AsIntrospectDependencies
): Promise<AsIntrospectOutcome> {
  if (!input.token) {
    return {
      errorCode: "invalid_request",
      errorMessage: "Missing token parameter",
      outcome: "failure",
      status: 400,
    };
  }
  const info = await deps.introspect(input.token);
  // Redact the AS-internal binding unless the authenticated host explicitly
  // identifies the caller as a confidential resource server.
  const { grant_storage_binding: _redacted, ...redactedInfo } = info as Record<string, unknown>;
  const publicInfo = deps.includeStorageBinding ? info : redactedInfo;
  return {
    outcome: "success",
    publicInfo: publicInfo as AsIntrospectInfo,
  };
}
