// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connection-scoped run-environment resolver.
 *
 * Assembles the per-request credential/binding fragment that a connector run
 * needs: static-secret credentials, provider-auth tokens, or manual-upload
 * import-dir bindings. Each sub-resolver returns `null` when it does not own
 * the given connection, so they compose cleanly in priority order.
 *
 * The two store factories (createConnectorInstanceStore /
 * createConnectorInstanceCredentialStore) are injected rather than imported
 * from index.js, keeping this module a true leaf (no back-edge).
 */

import { resolveProviderAuthRunEnv } from './stores/provider-auth-run-credentials.js';
import { resolveStaticSecretRunEnv } from './stores/static-secret-run-credentials.js';

// Lazily loads the pure static-secret injection helpers from the
// polyfill-connectors runner slice. The reference server reaches connector
// code by relative path (it does not declare the package as a dependency), so
// this mirrors the controller's `await import("../../packages/...")` idiom and
// caches the resolved module after the first run.
let staticSecretInjectionModulePromise = null;
export function loadStaticSecretInjectionHelpers() {
  if (!staticSecretInjectionModulePromise) {
    staticSecretInjectionModulePromise = import(
      '../../packages/polyfill-connectors/src/static-secret-injection.ts'
    );
  }
  return staticSecretInjectionModulePromise;
}

// Build the route-facing static-secret credential prober. The reference-only
// probe seam lives in the connector package: the pure orchestration
// (`probeCredential`, `hasCredentialProbe`) and the live transport factory,
// which owns the provider dependency (imapflow / GitHub fetch). The server
// adapter turns a thrown probe error into the route's non-throwing typed
// result. This is NOT a Collection Profile message and is never exposed to /mcp
// or grant-scoped reads. Resolved once at startup and injected, so the route
// stays synchronous and tests inject a deterministic double instead.
export async function buildStaticSecretCredentialProber() {
  const [probe, transport, adapter] = await Promise.all([
    import('../../packages/polyfill-connectors/src/credential-probe.ts'),
    import('../../packages/polyfill-connectors/src/credential-probe-transport.ts'),
    import('./stores/static-secret-credential-probe.js'),
  ]);
  return adapter.createStaticSecretCredentialProber({
    probeCredential: probe.probeCredential,
    hasCredentialProbe: probe.hasCredentialProbe,
    createLiveCredentialProbeTransport: transport.createLiveCredentialProbeTransport,
  });
}

// Builds the controller's connection-scoped static-secret resolver (design
// Decision 5). For a static-secret connector that HAS an active stored
// credential, it returns the env fragment carrying only that connection's
// secret; the run then authenticates with exactly that secret, overriding any
// process-global one. It returns `null` for non-static-secret connectors and
// for browser-session source bindings that have no optional stored login
// credential. A missing/revoked/deleted credential on a true static-secret
// connection still fails closed: the run seam throws and the run is refused
// before any child can use a stale or deployment-wide provider-account secret.
function buildControllerStaticSecretRunEnvResolver({
  createConnectorInstanceStore,
  createConnectorInstanceCredentialStore,
}) {
  return async ({ connectorId, connectorInstanceId, ownerSubjectId }) => {
    const { isStaticSecretConnector, buildConnectionScopedSecretEnv } =
      await loadStaticSecretInjectionHelpers();
    if (!isStaticSecretConnector(connectorId)) {
      return null;
    }
    const credentialStore = createConnectorInstanceCredentialStore();
    const connectorInstance = await createConnectorInstanceStore().get(connectorInstanceId);
    return await resolveStaticSecretRunEnv({
      connectorId,
      connectorInstanceId,
      ownerSubjectId,
      sourceBinding: connectorInstance?.sourceBinding ?? null,
      credentialStore,
      isStaticSecretConnector,
      buildConnectionScopedSecretEnv,
    });
  };
}

function buildControllerManualUploadRunEnvResolver({ createConnectorInstanceStore }) {
  return async ({ connectorInstanceId }) => {
    const instance = await createConnectorInstanceStore().get(connectorInstanceId);
    const binding = instance?.sourceBinding;
    if (
      !binding ||
      typeof binding !== 'object' ||
      (binding.kind !== 'manual_upload_draft' && binding.kind !== 'manual_upload') ||
      typeof binding.import_dir !== 'string' ||
      typeof binding.import_dir_env_var !== 'string'
    ) {
      return null;
    }
    return { [binding.import_dir_env_var]: binding.import_dir };
  };
}

function buildControllerProviderAuthRunEnvResolver({
  createConnectorInstanceStore,
  createConnectorInstanceCredentialStore,
}) {
  return async ({ connectorId, connectorInstanceId, ownerSubjectId }) => {
    const connectorInstance = await createConnectorInstanceStore().get(connectorInstanceId);
    return resolveProviderAuthRunEnv({
      connectorId,
      connectorInstanceId,
      ownerSubjectId,
      sourceBinding: connectorInstance?.sourceBinding ?? null,
      credentialStore: createConnectorInstanceCredentialStore(),
    });
  };
}

/**
 * buildConnectionScopedRunEnvResolver(deps)
 *
 * @param {{ createConnectorInstanceStore: () => object, createConnectorInstanceCredentialStore: () => object }} deps
 * @returns {(args: { connectorId: string, connectorInstanceId: string, ownerSubjectId: string }) => Promise<object|null>}
 */
export function buildConnectionScopedRunEnvResolver({
  createConnectorInstanceStore,
  createConnectorInstanceCredentialStore,
}) {
  const staticSecretResolver = buildControllerStaticSecretRunEnvResolver({
    createConnectorInstanceStore,
    createConnectorInstanceCredentialStore,
  });
  const providerAuthResolver = buildControllerProviderAuthRunEnvResolver({
    createConnectorInstanceStore,
    createConnectorInstanceCredentialStore,
  });
  const manualUploadResolver = buildControllerManualUploadRunEnvResolver({
    createConnectorInstanceStore,
  });
  return async (args) => {
    const staticSecretEnv = await staticSecretResolver(args);
    if (staticSecretEnv !== null) {
      return staticSecretEnv;
    }
    const providerAuthEnv = await providerAuthResolver(args);
    if (providerAuthEnv !== null) {
      return providerAuthEnv;
    }
    return manualUploadResolver(args);
  };
}
