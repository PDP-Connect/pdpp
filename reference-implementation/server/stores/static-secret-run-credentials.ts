// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { ConnectorInstanceCredentialError as ConnectorInstanceCredentialErrorClass } from "./connector-instance-credential-store.ts";

export const ConnectorInstanceCredentialError = ConnectorInstanceCredentialErrorClass;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Orchestration seam between the per-connection encrypted credential store and
 * connection-scoped subprocess injection.
 *
 * This is the single place a run-orchestration path calls to obtain the env
 * fragment for one static-secret connector run. It recovers the connection's
 * secret from the store (which fails closed when the credential is absent or
 * revoked) and maps it to the connector's env var(s) via the pure injection
 * registry from `@pdpp/polyfill-connectors/runner`.
 *
 * The injection functions (`isStaticSecretConnector`,
 * `buildConnectionScopedSecretEnv`) are INJECTED rather than imported so this
 * server-side seam does not hard-wire a new dependency edge onto the connector
 * package, matching the wider route-family adapter pattern (e.g.
 * `owner-connection-revoke.ts`). The eventual run/capture route supplies them
 * from the runner barrel.
 *
 * The returned fragment is spread into the per-run `connector.env`; it is never
 * placed in `process.env` and is never logged. The fail-closed behavior here is
 * the load-bearing guard: a revoked or deleted credential yields NO env
 * fragment, so a run cannot be assembled with a stale secret. See
 * add-static-secret-owner-connect-primitive design Decisions 5 & 7.
 */

export class StaticSecretRunCredentialError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StaticSecretRunCredentialError";
    this.code = code;
  }
}

/**
 * Resolve the connection-scoped secret env fragment for one run.
 *
 * @param {object} args
 * @param {string} args.connectorId - the connector type (e.g. 'gmail').
 * @param {string} args.connectorInstanceId - the connection being run.
 * @param {string} [args.ownerSubjectId] - owner scoping for recovery.
 * @param {unknown} [args.sourceBinding] - non-secret connection setup binding.
 * @param {object} args.credentialStore - a connector-instance credential store.
 * @param {(connectorId: string) => boolean} args.isStaticSecretConnector -
 *   injected from the runner barrel.
 * @param {(connectorId: string, recovered: object) => Record<string,string>}
 *   args.buildConnectionScopedSecretEnv - injected from the runner barrel.
 * @returns {Promise<Record<string,string> | null>} env fragment carrying only
 *   this connection's secret, or null when a browser-session connection has no
 *   optional stored login credential.
 * @throws {StaticSecretRunCredentialError} on a configuration/usage error.
 * @throws {ConnectorInstanceCredentialError} (fail closed) when the credential
 *   is absent, revoked, or provider-rejected.
 */
export interface RecoveredCredential {
  credentialKind: string;
  secret: string;
}

export interface StaticSecretCredentialStore {
  recoverSecret: (args: {
    connectorInstanceId: string;
    ownerSubjectId?: string | undefined;
  }) => Promise<RecoveredCredential>;
}

export async function resolveStaticSecretRunEnv({
  connectorId,
  connectorInstanceId,
  ownerSubjectId,
  sourceBinding,
  credentialStore,
  isStaticSecretConnector,
  buildConnectionScopedSecretEnv,
}: {
  buildConnectionScopedSecretEnv: (
    connectorId: string,
    recovered: RecoveredCredential,
    sourceBinding?: unknown
  ) => Record<string, string>;
  connectorId: string;
  connectorInstanceId: string;
  credentialStore: StaticSecretCredentialStore | null | undefined;
  isStaticSecretConnector: (connectorId: string) => boolean;
  ownerSubjectId?: string;
  sourceBinding?: unknown;
}): Promise<Record<string, string> | null> {
  if (typeof isStaticSecretConnector !== "function" || typeof buildConnectionScopedSecretEnv !== "function") {
    throw new StaticSecretRunCredentialError(
      "injection_helpers_required",
      "isStaticSecretConnector and buildConnectionScopedSecretEnv must be injected from the runner barrel."
    );
  }
  if (!isStaticSecretConnector(connectorId)) {
    throw new StaticSecretRunCredentialError(
      "not_a_static_secret_connector",
      `Connector '${connectorId}' is not a static-secret connector; no credential injection applies.`
    );
  }
  if (!credentialStore) {
    throw new StaticSecretRunCredentialError(
      "credential_store_required",
      "A connector-instance credential store is required to resolve a static-secret run env."
    );
  }
  const browserSessionSource =
    isRecord(sourceBinding) &&
    (sourceBinding.kind === "browser_collector" || sourceBinding.kind === "browser_enrollment_shell");
  // recoverSecret throws ConnectorInstanceCredentialError with code
  // 'credential_not_found', 'credential_revoked', or 'credential_rejected' —
  // the fail-closed path. We
  // let it propagate for true static-secret sources so the run is refused
  // rather than started with no/stale credential. Browser-session connections
  // can optionally use stored login credentials, but their primary credential is
  // the owner-authenticated browser session; absence of a static secret must not
  // block the secure browser repair path.
  let recovered: RecoveredCredential;
  try {
    recovered = await credentialStore.recoverSecret({ connectorInstanceId, ownerSubjectId });
  } catch (err) {
    if (
      browserSessionSource &&
      err instanceof ConnectorInstanceCredentialError &&
      (err.code === "credential_not_found" || err.code === "credential_revoked" || err.code === "credential_rejected")
    ) {
      return null;
    }
    throw err;
  }
  return buildConnectionScopedSecretEnv(connectorId, recovered, sourceBinding);
}
