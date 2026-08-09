// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Manifest-driven `ProviderAuthExchanger` (the route-facing interface
 * `ref-provider-auth.ts` calls) that dispatches every connector to its
 * connector-owned `ProviderAuthAdapter` (`provider-auth-adapter.ts`), keyed
 * by the manifest's `capabilities.auth.exchanger_kind`. This module names no
 * provider anywhere in its own source: the manifest supplies the adapter
 * kind, the URLs, the scopes, and the deployment-config keys; the adapter
 * supplies the provider-specific exchange/inventory/token-shaping logic.
 *
 * Replaces the per-provider exchangers this reference used to hardcode
 * (google-data-portability.ts, google-oauth-account.ts) — adding a new
 * OAuth-based connector no longer requires an RI code change, only a
 * manifest declaration and (if its token exchange needs provider-specific
 * shaping) a connector-owned adapter module.
 */

import type {
  DeploymentConfigResolver,
  ProviderAuthAdapter,
  ProviderAuthManifestLike,
} from "../../../packages/polyfill-connectors/src/provider-auth-adapter.ts";
import { resolveProviderAuthAdapter } from "../../../packages/polyfill-connectors/src/provider-auth-adapters.ts";
import type { ProviderAccount, ProviderAuthExchanger, ProviderAuthTokens } from "../routes/ref-provider-auth.ts";

export class GenericProviderAuthDispatchError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "GenericProviderAuthDispatchError";
    this.code = code;
    this.status = status;
  }
}

interface GenericProviderAuthDispatchOptions {
  readonly credentialStoreFactory: () => {
    capture: (args: {
      connectorInstanceId: string;
      credentialKind: "secret_bundle";
      now: string;
      ownerSubjectId: string;
      secret: string;
    }) => Promise<unknown> | unknown;
  };
  readonly deploymentConfigResolver: DeploymentConfigResolver;
  readonly resolveManifest: (connectorId: string) => Promise<ProviderAuthManifestLike | null>;
}

async function requireManifest(
  resolveManifest: (connectorId: string) => Promise<ProviderAuthManifestLike | null>,
  connectorId: string
): Promise<ProviderAuthManifestLike> {
  const manifest = await resolveManifest(connectorId);
  if (!manifest) {
    throw new GenericProviderAuthDispatchError("not_found", `Connector '${connectorId}' is not registered.`, 404);
  }
  return manifest;
}

async function requireAdapter(manifest: ProviderAuthManifestLike, connectorId: string): Promise<ProviderAuthAdapter> {
  const kind = manifest.capabilities?.auth?.exchanger_kind;
  if (typeof kind !== "string" || !kind.trim()) {
    throw new GenericProviderAuthDispatchError(
      "provider_auth_exchanger_kind_missing",
      `Connector '${connectorId}' manifest does not declare capabilities.auth.exchanger_kind.`,
      500
    );
  }
  const adapter = await resolveProviderAuthAdapter(kind.trim());
  if (!adapter) {
    throw new GenericProviderAuthDispatchError(
      "provider_auth_exchanger_kind_unregistered",
      `No provider-auth adapter is registered for exchanger_kind '${kind.trim()}' (connector '${connectorId}').`,
      500
    );
  }
  return adapter;
}

function secretBundleFromFields(fields: Readonly<Record<string, string>>): string {
  return JSON.stringify(fields);
}

/**
 * Recovers the adapter's `persistenceContext` from the account's own
 * `sourceBinding` — the same non-secret object `runInventoryOrTest` returned
 * on `ProviderAccount.sourceBinding`, round-tripped back to this call by
 * `ref-provider-auth.ts` within the SAME request. No module-scope map, no
 * value keyed by a raw access token: the object is passed directly through
 * ordinary call args for exactly one initiate->callback flow, and nothing
 * here retains it past this one call returning.
 */
function persistenceContextFromSourceBinding(
  sourceBinding: Record<string, unknown> | null | undefined
): Readonly<Record<string, unknown>> | undefined {
  return sourceBinding && typeof sourceBinding === "object" ? sourceBinding : undefined;
}

/**
 * Builds one `ProviderAuthExchanger` that dispatches every connector to its
 * manifest-declared adapter. A single instance is shared by every connector
 * `ref-provider-auth.ts` routes to — the adapter lookup happens per-call,
 * keyed by the connector's own manifest, so no per-connector construction is
 * needed the way the retired per-provider exchangers required. Holds no
 * per-flow state of its own: `runInventoryOrTest` and `storeTokens` are
 * always called for the same account within one `/_ref/provider-auth/callback`
 * request, and the only value that needs to cross that gap
 * (`persistenceContext`) travels through `ProviderAccount.sourceBinding`,
 * which the route already threads back on `storeTokens`'s call args.
 */
export function createGenericProviderAuthDispatch({
  credentialStoreFactory,
  deploymentConfigResolver,
  resolveManifest,
}: GenericProviderAuthDispatchOptions): ProviderAuthExchanger {
  return {
    async exchangeCode({ code, connectorId, redirectUri, state }): Promise<ProviderAuthTokens | null> {
      const manifest = await requireManifest(resolveManifest, connectorId);
      const adapter = await requireAdapter(manifest, connectorId);
      return adapter.exchangeCode({ code, deploymentConfigResolver, manifest, redirectUri, state });
    },

    async initiateAuthorization({ connectorId, redirectUri, state }) {
      const manifest = await requireManifest(resolveManifest, connectorId);
      const adapter = await requireAdapter(manifest, connectorId);
      return adapter.initiateAuthorization({ deploymentConfigResolver, manifest, redirectUri, state });
    },

    async runInventoryOrTest({ connectorId, tokens }): Promise<ProviderAccount[]> {
      const manifest = await requireManifest(resolveManifest, connectorId);
      const adapter = await requireAdapter(manifest, connectorId);
      const result = await adapter.runInventoryOrTest({ manifest, tokens });
      // persistenceContext is merged onto each account's own sourceBinding so
      // it round-trips to storeTokens via the route's normal per-account
      // call args — see persistenceContextFromSourceBinding above.
      return result.accounts.map((account) => ({
        ...account,
        sourceBinding: { ...account.sourceBinding, ...result.persistenceContext },
      })) as ProviderAccount[];
    },

    async storeTokens({ connectorId, now, connectorInstanceId, ownerSubjectId, sourceBinding, tokens }) {
      const manifest = await requireManifest(resolveManifest, connectorId);
      const adapter = await requireAdapter(manifest, connectorId);
      const persistenceContext = persistenceContextFromSourceBinding(sourceBinding);
      const fields = await adapter.storeTokens({
        manifest,
        tokens,
        ...(persistenceContext ? { persistenceContext } : {}),
      });
      await credentialStoreFactory().capture({
        connectorInstanceId,
        credentialKind: "secret_bundle",
        now,
        ownerSubjectId,
        secret: secretBundleFromFields(fields),
      });
    },
  };
}
