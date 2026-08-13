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

import type {
  CredentialProbeContext,
  CredentialProbeTransport,
} from "../../packages/polyfill-connectors/src/credential-probe.ts";
import type { RecoveredStaticSecret } from "../../packages/polyfill-connectors/src/static-secret-injection.ts";
import { resolveProviderAuthRunEnv } from "./stores/provider-auth-run-credentials.ts";
import { resolveStaticSecretRunEnv, type StaticSecretCredentialStore } from "./stores/static-secret-run-credentials.ts";

type RunEnv = Record<string, string>;

interface ConnectorInstance {
  readonly sourceBinding?: unknown;
}

interface ConnectorInstanceStore {
  get: (connectorInstanceId: string) => ConnectorInstance | null | Promise<ConnectorInstance | null>;
}

type ConnectorInstanceCredentialStore = StaticSecretCredentialStore;

interface RunEnvResolverArgs {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly ownerSubjectId: string;
}

type RunEnvResolver = (args: RunEnvResolverArgs) => Promise<RunEnv | null>;

interface ResolverDependencies {
  readonly createConnectorInstanceCredentialStore: () => ConnectorInstanceCredentialStore;
  readonly createConnectorInstanceStore: () => ConnectorInstanceStore;
}

interface ManualUploadBinding {
  readonly import_dir: string;
  readonly import_dir_env_var: string;
  readonly kind: "manual_upload_draft" | "manual_upload";
}

function isManualUploadBinding(value: unknown): value is ManualUploadBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const binding = value as Record<string, unknown>;
  return (
    (binding.kind === "manual_upload_draft" || binding.kind === "manual_upload") &&
    typeof binding.import_dir === "string" &&
    typeof binding.import_dir_env_var === "string"
  );
}

// Lazily loads the pure static-secret injection helpers from the
// polyfill-connectors runner slice. The reference server reaches connector
// code by relative path (it does not declare the package as a dependency), so
// this mirrors the controller's `await import("../../packages/...")` idiom and
// caches the resolved module after the first run.
let staticSecretInjectionModulePromise: Promise<
  typeof import("../../packages/polyfill-connectors/src/static-secret-injection.ts")
> | null = null;
export function loadStaticSecretInjectionHelpers() {
  if (!staticSecretInjectionModulePromise) {
    staticSecretInjectionModulePromise = import("../../packages/polyfill-connectors/src/static-secret-injection.ts");
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
  const [probe, transportModule, adapter] = await Promise.all([
    import("../../packages/polyfill-connectors/src/credential-probe.ts"),
    import("../../packages/polyfill-connectors/src/credential-probe-transport.ts"),
    import("./stores/static-secret-credential-probe.ts"),
  ]);
  return adapter.createStaticSecretCredentialProber({
    createLiveCredentialProbeTransport: transportModule.createLiveCredentialProbeTransport,
    hasCredentialProbe: probe.hasCredentialProbe,
    probeCredential: async ({ connectorKey, context, secret, transport: probeTransport }) =>
      probe.probeCredential({
        connectorKey,
        context: context as CredentialProbeContext,
        secret,
        transport: probeTransport as CredentialProbeTransport,
      }),
  });
}

// Builds the controller's connection-scoped static-secret resolver (design
// Decision 5). For a static-secret connector that HAS an active stored
// credential, it returns the env fragment carrying only that connection's
// secret; the run then authenticates with that explicit per-connection
// capability. It returns `null` for non-static-secret connectors,
// for browser-session source bindings that have no optional stored login
// credential, AND for any connector whose manifest declares
// `credential_capture.required: false` regardless of its
// connection's `sourceBinding.kind` - see `resolveStaticSecretRunEnv`'s doc.
// A missing/revoked/deleted credential on a true REQUIRED static-secret
// connection still fails closed: the run seam throws and the run is refused
// before any child can use an undeclared provider-account secret.
function buildControllerStaticSecretRunEnvResolver({
  createConnectorInstanceStore,
  createConnectorInstanceCredentialStore,
}: ResolverDependencies): RunEnvResolver {
  return async ({ connectorId, connectorInstanceId, ownerSubjectId }: RunEnvResolverArgs) => {
    const { isStaticSecretConnector, buildConnectionScopedSecretEnv } = await loadStaticSecretInjectionHelpers();
    if (!isStaticSecretConnector(connectorId)) {
      return null;
    }
    const credentialStore = createConnectorInstanceCredentialStore();
    const connectorInstance = await createConnectorInstanceStore().get(connectorInstanceId);
    return await resolveStaticSecretRunEnv({
      buildConnectionScopedSecretEnv: (id: string, recovered: object) =>
        buildConnectionScopedSecretEnv(id, recovered as RecoveredStaticSecret, connectorInstance?.sourceBinding),
      connectorId,
      connectorInstanceId,
      credentialStore,
      isStaticSecretConnector,
      ownerSubjectId,
      sourceBinding: connectorInstance?.sourceBinding ?? null,
    });
  };
}

function buildControllerManualUploadRunEnvResolver({
  createConnectorInstanceStore,
}: Pick<ResolverDependencies, "createConnectorInstanceStore">): RunEnvResolver {
  return async ({ connectorInstanceId }: RunEnvResolverArgs) => {
    const instance = await createConnectorInstanceStore().get(connectorInstanceId);
    const binding = instance?.sourceBinding;
    if (!isManualUploadBinding(binding)) {
      return null;
    }
    return { [binding.import_dir_env_var]: binding.import_dir };
  };
}

function buildControllerProviderAuthRunEnvResolver({
  createConnectorInstanceStore,
  createConnectorInstanceCredentialStore,
}: ResolverDependencies): RunEnvResolver {
  return async ({ connectorId, connectorInstanceId, ownerSubjectId }: RunEnvResolverArgs) => {
    const connectorInstance = await createConnectorInstanceStore().get(connectorInstanceId);
    return resolveProviderAuthRunEnv({
      connectorId,
      connectorInstanceId,
      credentialStore: createConnectorInstanceCredentialStore(),
      ownerSubjectId,
      sourceBinding: connectorInstance?.sourceBinding ?? null,
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
}: ResolverDependencies): RunEnvResolver {
  const staticSecretResolver = buildControllerStaticSecretRunEnvResolver({
    createConnectorInstanceCredentialStore,
    createConnectorInstanceStore,
  });
  const providerAuthResolver = buildControllerProviderAuthRunEnvResolver({
    createConnectorInstanceCredentialStore,
    createConnectorInstanceStore,
  });
  const manualUploadResolver = buildControllerManualUploadRunEnvResolver({
    createConnectorInstanceStore,
  });
  return async (args: RunEnvResolverArgs) => {
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
