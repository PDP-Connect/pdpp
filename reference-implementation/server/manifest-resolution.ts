// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { getConnectorManifest, getManifestForStorageBinding, requireGrantContractAgainstManifest } from "./auth.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "./owner-auth.ts";
import { createRequestConnectorInstanceStore, storageTargetForConnectorNamespace } from "./request-store-factories.ts";
import {
  buildClientSourceDescriptor,
  type RequestWithQuery,
  resolveGrantStorageBinding,
  resolveOwnerReadScope,
  type SourceDescriptor,
  type SourceDescriptorOptions,
  type TokenInfo,
} from "./source-descriptor.ts";
import { resolveOwnerConnectorInstanceNamespace } from "./stores/connector-instance-store.ts";

interface OwnerScope {
  owner_subject_id?: string;
  public_scope: string;
  source: { id?: string | undefined; kind?: string | undefined };
  storage_binding: { connector_id?: string | undefined; connector_instance_id?: string | null | undefined } | null;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function resolveOwnerManifestFromScope(ownerScope: OwnerScope, opts: SourceDescriptorOptions = {}) {
  let storageBinding = ownerScope.storage_binding || null;
  if (ownerScope.public_scope === "polyfill" && storageBinding?.connector_id) {
    try {
      const namespace = await resolveOwnerConnectorInstanceNamespace({
        // Read/manifest resolution must never materialize a connection. If a
        // default-account row already exists, resolveActiveByConnector can use
        // it; if no real connection exists, downstream read binding resolution
        // fails closed instead of creating a phantom zero-record source.
        allowDefaultAccount: false,
        connectorId: storageBinding.connector_id,
        ...(storageBinding.connector_instance_id ? { connectorInstanceId: storageBinding.connector_instance_id } : {}),
        connectorInstanceStore: createRequestConnectorInstanceStore(),
        displayName: storageBinding.connector_id,
        ownerSubjectId: ownerScope.owner_subject_id || OWNER_AUTH_DEFAULT_SUBJECT_ID,
      });
      storageBinding = storageTargetForConnectorNamespace(namespace);
    } catch (err: unknown) {
      // Tolerate multi-connection ambiguity: the route layer fans in over
      // every active connection under the connector, so a single-binding
      // pin is no longer required. The storage binding stays scoped to
      // `connector_id` and the route resolves the binding set per
      // request via `resolveReadRequestBindings`.
      if (errorCode(err) === "ambiguous_connector_instance") {
        storageBinding = { connector_id: storageBinding.connector_id };
      } else if (errorCode(err) !== "connector_instance_not_found") {
        // Fall through to manifest-not-found if the connector is not
        // registered; route-level not_found mapping then returns a 404.
        throw err;
      }
    }
  }
  const manifestStorageBinding =
    typeof storageBinding?.connector_id === "string" ? { connector_id: storageBinding.connector_id } : null;
  const manifestOptions =
    opts.nativeManifest === undefined
      ? {}
      : { nativeManifest: opts.nativeManifest as unknown as Record<string, unknown> };
  const manifest = await getManifestForStorageBinding(manifestStorageBinding, manifestOptions);
  if (!manifest) {
    const err = Object.assign(
      new Error(
        ownerScope.source.kind === "provider_native"
          ? `Unknown source: { kind: 'provider_native', id: '${ownerScope.source.id}' }`
          : `Unknown connector: ${storageBinding?.connector_id || "unknown"}`
      ),
      { code: "not_found" }
    );
    throw err;
  }
  return { manifest, ownerScope, storageBinding };
}

export async function resolveOwnerManifest(req: RequestWithQuery, opts: SourceDescriptorOptions = {}) {
  const ownerScope = await resolveOwnerReadScope(req, opts);
  return resolveOwnerManifestFromScope(ownerScope, opts);
}

export async function resolveGrantManifest(
  tokenInfo: TokenInfo | null | undefined,
  opts: SourceDescriptorOptions = {}
) {
  let storageBinding = resolveGrantStorageBinding(tokenInfo);
  // Only resolve a connector_instance namespace for polyfill connector
  // sources. Native provider grants point at synthetic storage bindings
  // whose connector_id is not registered in the `connectors` catalog, so
  // forcing a connector_instances upsert would FK-fail and surface as
  // a 500 instead of the intended client-error rejection downstream.
  const grantSource = tokenInfo?.grant?.source;
  const grantSourceKind = isRecord(grantSource) && grantSource.kind === "provider_native" ? "provider_native" : null;
  if (storageBinding?.connector_id && grantSourceKind !== "provider_native") {
    try {
      const namespace = await resolveOwnerConnectorInstanceNamespace({
        // Client/grant reads are also side-effect-free. A grant naming an
        // unconnected connector must not create a default-account connection
        // simply because the client inspected schema or streams.
        allowDefaultAccount: false,
        connectorId: storageBinding.connector_id,
        ...(storageBinding.connector_instance_id ? { connectorInstanceId: storageBinding.connector_instance_id } : {}),
        connectorInstanceStore: createRequestConnectorInstanceStore(),
        displayName: storageBinding.connector_id,
        ownerSubjectId: tokenInfo?.grant?.subject?.id || tokenInfo?.subject_id || OWNER_AUTH_DEFAULT_SUBJECT_ID,
      });
      storageBinding = storageTargetForConnectorNamespace(namespace);
    } catch (err: unknown) {
      // Tolerate multi-connection ambiguity: the route layer fans in over
      // every active connection under the connector. The storage binding
      // stays scoped to `connector_id` only; the route uses the
      // fan-in resolver to pick / iterate concrete bindings.
      if (errorCode(err) === "ambiguous_connector_instance") {
        storageBinding = { connector_id: storageBinding.connector_id };
      } else if (errorCode(err) !== "connector_instance_not_found") {
        // If the connector is not registered, fall through to the
        // manifest-not-found path below so the route returns a clean 404
        // ("Unknown connector: …") instead of bubbling a 500.
        throw err;
      }
    }
  }
  const source: SourceDescriptor | null = buildClientSourceDescriptor(tokenInfo);
  const manifestOptions =
    opts.nativeManifest === undefined
      ? {}
      : { nativeManifest: opts.nativeManifest as unknown as Record<string, unknown> };
  const manifest = await getManifestForStorageBinding(storageBinding, manifestOptions);
  if (!manifest) {
    const err = Object.assign(
      source?.kind === "provider_native"
        ? new Error(`Unknown source: { kind: 'provider_native', id: '${source.id}' }`)
        : new Error(`Unknown connector: ${storageBinding?.connector_id || "unknown"}`),
      { code: "not_found" }
    );
    throw err;
  }
  requireGrantContractAgainstManifest(tokenInfo?.grant, manifest);
  return { manifest, source, storageBinding };
}

export async function resolveRegisteredConnectorManifest(connectorId: string) {
  const manifest = await getConnectorManifest(connectorId);
  if (!manifest) {
    const err = Object.assign(new Error(`Unknown connector: ${connectorId}`), { code: "not_found" });
    throw err;
  }
  return manifest;
}
