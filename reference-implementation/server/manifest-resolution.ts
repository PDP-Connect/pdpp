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
      new Error(`Unknown source: ${ownerScope.source.id || storageBinding?.connector_id || "unknown"}`),
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
  // The persisted storage binding and closed per-stream instance_ids are the
  // serving authority. Do not re-resolve a current instance or dispatch on
  // source.kind: kind is retained provenance, not a runtime type.
  const storageBinding = resolveGrantStorageBinding(tokenInfo);
  const source: SourceDescriptor | null = buildClientSourceDescriptor(tokenInfo);
  const manifestOptions =
    opts.nativeManifest === undefined
      ? {}
      : { nativeManifest: opts.nativeManifest as unknown as Record<string, unknown> };
  const manifest = await getManifestForStorageBinding(storageBinding, manifestOptions);
  if (!manifest) {
    const err = Object.assign(new Error(`Unknown source: ${source?.id || storageBinding?.connector_id || "unknown"}`), {
      code: "not_found",
    });
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
