// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  getConnectorManifest,
  getManifestForStorageBinding,
  requireGrantContractAgainstManifest,
} from './auth.js';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from './owner-auth.ts';
import { resolveOwnerConnectorInstanceNamespace } from './stores/connector-instance-store.js';
import {
  createRequestConnectorInstanceStore,
  storageTargetForConnectorNamespace,
} from './request-store-factories.js';
import {
  buildClientSourceDescriptor,
  resolveGrantStorageBinding,
  resolveOwnerReadScope,
} from './source-descriptor.js';

export async function resolveOwnerManifestFromScope(ownerScope, opts = {}) {
  let storageBinding = ownerScope.storage_binding || null;
  if (ownerScope.public_scope === 'polyfill' && storageBinding?.connector_id) {
    try {
      const namespace = await resolveOwnerConnectorInstanceNamespace({
        ownerSubjectId: ownerScope.owner_subject_id || OWNER_AUTH_DEFAULT_SUBJECT_ID,
        connectorId: storageBinding.connector_id,
        connectorInstanceId: storageBinding.connector_instance_id,
        connectorInstanceStore: createRequestConnectorInstanceStore(),
        // Read/manifest resolution must never materialize a connection. If a
        // default-account row already exists, resolveActiveByConnector can use
        // it; if no real connection exists, downstream read binding resolution
        // fails closed instead of creating a phantom zero-record source.
        allowDefaultAccount: false,
        displayName: storageBinding.connector_id,
      });
      storageBinding = storageTargetForConnectorNamespace(namespace);
    } catch (err) {
      // Tolerate multi-connection ambiguity: the route layer fans in over
      // every active connection under the connector, so a single-binding
      // pin is no longer required. The storage binding stays scoped to
      // `connector_id` and the route resolves the binding set per
      // request via `resolveReadRequestBindings`.
      if (err?.code === 'ambiguous_connector_instance') {
        storageBinding = { connector_id: storageBinding.connector_id };
      } else if (err?.code !== 'connector_instance_not_found') {
        // Fall through to manifest-not-found if the connector is not
        // registered; route-level not_found mapping then returns a 404.
        throw err;
      }
    }
  }
  const manifest = await getManifestForStorageBinding(storageBinding, opts);
  if (!manifest) {
    const err = new Error(
      ownerScope.source.kind === 'provider_native'
        ? `Unknown source: { kind: 'provider_native', id: '${ownerScope.source.id}' }`
        : `Unknown connector: ${storageBinding?.connector_id || 'unknown'}`
    );
    err.code = 'not_found';
    throw err;
  }
  return { ownerScope, storageBinding, manifest };
}

export async function resolveOwnerManifest(req, opts = {}) {
  const ownerScope = await resolveOwnerReadScope(req, opts);
  return resolveOwnerManifestFromScope(ownerScope, opts);
}

export async function resolveGrantManifest(tokenInfo, opts = {}) {
  let storageBinding = resolveGrantStorageBinding(tokenInfo);
  // Only resolve a connector_instance namespace for polyfill connector
  // sources. Native provider grants point at synthetic storage bindings
  // whose connector_id is not registered in the `connectors` catalog, so
  // forcing a connector_instances upsert would FK-fail and surface as
  // a 500 instead of the intended client-error rejection downstream.
  const grantSourceKind = tokenInfo?.grant?.source?.kind;
  if (storageBinding?.connector_id && grantSourceKind !== 'provider_native') {
    try {
      const namespace = await resolveOwnerConnectorInstanceNamespace({
        ownerSubjectId: tokenInfo?.grant?.subject?.id || tokenInfo?.subject_id || OWNER_AUTH_DEFAULT_SUBJECT_ID,
        connectorId: storageBinding.connector_id,
        connectorInstanceId: storageBinding.connector_instance_id,
        connectorInstanceStore: createRequestConnectorInstanceStore(),
        // Client/grant reads are also side-effect-free. A grant naming an
        // unconnected connector must not create a default-account connection
        // simply because the client inspected schema or streams.
        allowDefaultAccount: false,
        displayName: storageBinding.connector_id,
      });
      storageBinding = storageTargetForConnectorNamespace(namespace);
    } catch (err) {
      // Tolerate multi-connection ambiguity: the route layer fans in over
      // every active connection under the connector. The storage binding
      // stays scoped to `connector_id` only; the route uses the
      // fan-in resolver to pick / iterate concrete bindings.
      if (err?.code === 'ambiguous_connector_instance') {
        storageBinding = { connector_id: storageBinding.connector_id };
      } else if (err?.code !== 'connector_instance_not_found') {
        // If the connector is not registered, fall through to the
        // manifest-not-found path below so the route returns a clean 404
        // ("Unknown connector: …") instead of bubbling a 500.
        throw err;
      }
    }
  }
  const source = buildClientSourceDescriptor(tokenInfo);
  const manifest = await getManifestForStorageBinding(storageBinding, opts);
  if (!manifest) {
    const err = source?.kind === 'provider_native'
      ? new Error(`Unknown source: { kind: 'provider_native', id: '${source.id}' }`)
      : new Error(`Unknown connector: ${storageBinding?.connector_id || 'unknown'}`);
    err.code = 'not_found';
    throw err;
  }
  requireGrantContractAgainstManifest(tokenInfo?.grant, manifest);
  return { storageBinding, source, manifest };
}

export async function resolveRegisteredConnectorManifest(connectorId) {
  const manifest = await getConnectorManifest(connectorId);
  if (!manifest) {
    const err = new Error(`Unknown connector: ${connectorId}`);
    err.code = 'not_found';
    throw err;
  }
  return manifest;
}
