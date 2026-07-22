// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { canonicalConnectorKey } from './connector-key.js';
import { resolveRequestConnectionId } from './connection-id-request.js';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from './owner-auth.ts';
import { resolveOwnerConnectorInstanceNamespace } from './stores/connector-instance-store.js';
import {
  createRequestConnectorInstanceStore,
  storageTargetForConnectorNamespace,
} from './request-store-factories.js';

export function buildSourceDescriptor(sourceBinding = null) {
  if (sourceBinding?.kind === 'provider_native' && sourceBinding.id) {
    return { kind: 'provider_native', id: sourceBinding.id };
  }
  if (sourceBinding?.kind === 'connector' && sourceBinding.id) {
    return { kind: 'connector', id: sourceBinding.id };
  }
  return null;
}

export function resolveGrantStorageBinding(tokenInfo) {
  if (tokenInfo?.grant_storage_binding?.connector_id) return tokenInfo.grant_storage_binding;
  return null;
}

export function buildClientSourceDescriptor(tokenInfo) {
  const grantSource = buildSourceDescriptor(tokenInfo?.grant?.source);
  if (grantSource) return grantSource;

  const storageBinding = resolveGrantStorageBinding(tokenInfo);
  if (storageBinding?.connector_id) {
    return { kind: 'connector', id: storageBinding.connector_id };
  }
  return null;
}

export function buildOwnerQuerySourceDescriptor(req, opts = {}) {
  const nativeManifest = resolveNativeManifest(opts);
  if (nativeManifest?.provider_id) {
    return buildSourceDescriptor({ kind: 'provider_native', id: nativeManifest.provider_id });
  }

  const connectorId = resolveSingleConnectorIdQueryValue(req.query.connector_id);
  if (!connectorId) return null;
  const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;
  return buildSourceDescriptor({ kind: 'connector', id: connectorKey });
}

export function resolveNativeManifest(opts = {}) {
  return opts.nativeManifest || null;
}

export function resolveNativeStorageBinding(opts = {}) {
  const nativeManifest = resolveNativeManifest(opts);
  const connectorId = nativeManifest?.storage_binding?.connector_id;
  if (!connectorId) return null;
  return { connector_id: connectorId };
}

export async function resolveOwnerReadScope(req, opts = {}) {
  const nativeManifest = resolveNativeManifest(opts);
  const nativeStorageBinding = resolveNativeStorageBinding(opts);
  if (nativeManifest && nativeStorageBinding) {
    return {
      public_scope: 'native',
      owner_subject_id: getOwnerTokenSubjectId(req),
      source: { kind: 'provider_native', id: nativeManifest.provider_id },
      storage_binding: nativeStorageBinding,
    };
  }

  const ownerSubjectId = getOwnerTokenSubjectId(req);
  const connectorId = resolveSingleConnectorIdQueryValue(req.query.connector_id);
  const requestedConnection = resolveRequestConnectionId(req.query);
  if (requestedConnection.connectionId) {
    const connectorKey = connectorId ? (canonicalConnectorKey(connectorId) ?? connectorId) : null;
    const namespace = await resolveOwnerConnectorInstanceNamespace({
      ownerSubjectId,
      connectorId: connectorKey,
      connectorInstanceId: requestedConnection.connectionId,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      allowDefaultAccount: false,
    });
    return {
      public_scope: 'polyfill',
      owner_subject_id: ownerSubjectId,
      source: { kind: 'connector', id: namespace.connectorId },
      storage_binding: storageTargetForConnectorNamespace(namespace),
    };
  }

  if (!connectorId) {
    const err = new Error('connector_id must be a single non-empty string for polyfill owner access');
    err.code = 'invalid_request';
    throw err;
  }
  // Canonicalize the owner-supplied connector_id once, at the read-scope
  // construction boundary, so the owner read storage binding carries the same
  // canonical key the ingest path writes under (resolveOwnerConnectorNamespace
  // canonicalizes at line ~1332). Without this, a URL-shaped connector_id like
  // 'https://registry.pdpp.org/connectors/gmail' reaches connection admission
  // verbatim, listActiveByConnector finds zero rows (they are keyed 'gmail'),
  // and the read fails connection_not_found. The owner-facing source descriptor
  // still reflects the canonical key. See canonicalize-connector-keys Decision 1.
  const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;

  return {
    public_scope: 'polyfill',
    owner_subject_id: ownerSubjectId,
    source: { kind: 'connector', id: connectorKey },
    storage_binding: {
      connector_id: connectorKey,
      connector_instance_id: resolveSingleConnectorIdQueryValue(req.query.connector_instance_id),
    },
  };
}

export function getOwnerTokenSubjectId(req) {
  return req.tokenInfo?.subject_id || OWNER_AUTH_DEFAULT_SUBJECT_ID;
}

export function resolveSingleConnectorIdQueryValue(rawConnectorId) {
  if (typeof rawConnectorId !== 'string') return null;
  const trimmed = rawConnectorId.trim();
  return trimmed || null;
}
