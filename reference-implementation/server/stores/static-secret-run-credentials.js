import { ConnectorInstanceCredentialError } from './connector-instance-credential-store.js';

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
  constructor(code, message) {
    super(message);
    this.name = 'StaticSecretRunCredentialError';
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
 *   is absent or revoked.
 */
export async function resolveStaticSecretRunEnv({
  connectorId,
  connectorInstanceId,
  ownerSubjectId,
  sourceBinding,
  credentialStore,
  isStaticSecretConnector,
  buildConnectionScopedSecretEnv,
}) {
  if (typeof isStaticSecretConnector !== 'function' || typeof buildConnectionScopedSecretEnv !== 'function') {
    throw new StaticSecretRunCredentialError(
      'injection_helpers_required',
      'isStaticSecretConnector and buildConnectionScopedSecretEnv must be injected from the runner barrel.',
    );
  }
  if (!isStaticSecretConnector(connectorId)) {
    throw new StaticSecretRunCredentialError(
      'not_a_static_secret_connector',
      `Connector '${connectorId}' is not a static-secret connector; no credential injection applies.`,
    );
  }
  if (!credentialStore) {
    throw new StaticSecretRunCredentialError(
      'credential_store_required',
      'A connector-instance credential store is required to resolve a static-secret run env.',
    );
  }
  const browserSessionSource =
    sourceBinding &&
    typeof sourceBinding === 'object' &&
    !Array.isArray(sourceBinding) &&
    (sourceBinding.kind === 'browser_collector' || sourceBinding.kind === 'browser_enrollment_shell');
  // recoverSecret throws ConnectorInstanceCredentialError with code
  // 'credential_not_found' or 'credential_revoked' — the fail-closed path. We
  // let it propagate for true static-secret sources so the run is refused
  // rather than started with no/stale credential. Browser-session connections
  // can optionally use stored login credentials, but their primary credential is
  // the owner-authenticated browser session; absence of a static secret must not
  // block the secure browser repair path.
  let recovered;
  try {
    recovered = await credentialStore.recoverSecret({ connectorInstanceId, ownerSubjectId });
  } catch (err) {
    if (
      browserSessionSource &&
      err instanceof ConnectorInstanceCredentialError &&
      (err.code === 'credential_not_found' || err.code === 'credential_revoked')
    ) {
      return null;
    }
    throw err;
  }
  return buildConnectionScopedSecretEnv(connectorId, recovered, sourceBinding);
}

export { ConnectorInstanceCredentialError };
