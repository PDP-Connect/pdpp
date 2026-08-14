// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { resolveRequestConnectionId } from "./connection-id-request.ts";
import { canonicalConnectorKey } from "./connector-key.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "./owner-auth.ts";
import { createRequestConnectorInstanceStore, storageTargetForConnectorNamespace } from "./request-store-factories.ts";
import { resolveOwnerConnectorInstanceNamespace } from "./stores/connector-instance-store.ts";

export interface SourceDescriptor {
  id: string;
  kind: "connector" | "provider_native";
}

export interface StorageBinding {
  connector_id: string;
  connector_instance_id?: string | null;
}

export interface NativeManifest {
  /** Retained only as an ignored implementation-specific manifest field. */
  provider_id?: string;
  source_declaration?: { source?: unknown };
  storage_binding?: StorageBinding;
}

export interface SourceDescriptorOptions {
  nativeManifest?: NativeManifest | null;
}

export interface TokenInfo {
  grant?: { source?: unknown; subject?: { id?: string } };
  grant_storage_binding?: StorageBinding;
  subject_id?: string;
}

export interface RequestWithQuery {
  query: Record<string, unknown>;
  tokenInfo?: { subject_id?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function buildSourceDescriptor(sourceBinding: unknown = null): SourceDescriptor | null {
  if (!isRecord(sourceBinding)) {
    return null;
  }
  if (sourceBinding.kind === "provider_native" && typeof sourceBinding.id === "string" && sourceBinding.id) {
    return { id: sourceBinding.id, kind: "provider_native" };
  }
  if (sourceBinding.kind === "connector" && typeof sourceBinding.id === "string" && sourceBinding.id) {
    return { id: sourceBinding.id, kind: "connector" };
  }
  return null;
}

export function resolveGrantStorageBinding(tokenInfo: TokenInfo | null | undefined): StorageBinding | null {
  if (tokenInfo?.grant_storage_binding?.connector_id) {
    return tokenInfo.grant_storage_binding;
  }
  return null;
}

export function buildClientSourceDescriptor(tokenInfo: TokenInfo | null | undefined): SourceDescriptor | null {
  return buildSourceDescriptor(tokenInfo?.grant?.source);
}

export function buildOwnerQuerySourceDescriptor(
  req: RequestWithQuery,
  opts: SourceDescriptorOptions = {}
): SourceDescriptor | null {
  const nativeManifest = resolveNativeManifest(opts);
  const configuredSource = buildSourceDescriptor(nativeManifest?.source_declaration?.source);
  if (configuredSource) {
    return configuredSource;
  }

  const connectorId = resolveSingleConnectorIdQueryValue(req.query.connector_id);
  if (!connectorId) {
    return null;
  }
  const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;
  return buildSourceDescriptor({ id: connectorKey, kind: "connector" });
}

export function resolveNativeManifest(opts: SourceDescriptorOptions = {}): NativeManifest | null {
  return opts.nativeManifest || null;
}

export function resolveNativeStorageBinding(opts: SourceDescriptorOptions = {}): StorageBinding | null {
  const nativeManifest = resolveNativeManifest(opts);
  const connectorId = nativeManifest?.storage_binding?.connector_id;
  if (!connectorId) {
    return null;
  }
  return { connector_id: connectorId };
}

export async function resolveOwnerReadScope(req: RequestWithQuery, opts: SourceDescriptorOptions = {}) {
  const nativeManifest = resolveNativeManifest(opts);
  const nativeStorageBinding = resolveNativeStorageBinding(opts);
  if (nativeManifest && nativeStorageBinding) {
    const configuredSource = buildSourceDescriptor(nativeManifest.source_declaration?.source);
    if (!configuredSource) {
      const err = Object.assign(new Error("Configured SourceDeclaration source is missing"), {
        code: "invalid_request",
      });
      throw err;
    }
    return {
      owner_subject_id: getOwnerTokenSubjectId(req),
      public_scope: "native",
      source: configuredSource,
      storage_binding: nativeStorageBinding,
    };
  }

  const ownerSubjectId = getOwnerTokenSubjectId(req);
  const connectorId = resolveSingleConnectorIdQueryValue(req.query.connector_id);
  const requestedConnection = resolveRequestConnectionId(req.query);
  if (requestedConnection.connectionId) {
    const connectorKey = connectorId ? (canonicalConnectorKey(connectorId) ?? connectorId) : null;
    const namespace = await resolveOwnerConnectorInstanceNamespace({
      allowDefaultAccount: false,
      connectorId: connectorKey,
      connectorInstanceId: requestedConnection.connectionId,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId,
    });
    return {
      owner_subject_id: ownerSubjectId,
      public_scope: "polyfill",
      source: { id: namespace.connectorId, kind: "connector" },
      storage_binding: storageTargetForConnectorNamespace(namespace),
    };
  }

  if (!connectorId) {
    const err = Object.assign(new Error("connector_id must be a single non-empty string for polyfill owner access"), {
      code: "invalid_request",
    });
    throw err;
  }
  // Canonicalize the owner-supplied connector_id once, at the read-scope
  // construction boundary, so the owner read storage binding carries the same
  // canonical key the ingest path writes under (resolveOwnerConnectorNamespace
  // canonicalizes at line ~1332). Without this, a URL-shaped connector_id like
  // 'https://registry.pdpp.dev/connectors/gmail' reaches connection admission
  // verbatim, listActiveByConnector finds zero rows (they are keyed 'gmail'),
  // and the read fails connection_not_found. The owner-facing source descriptor
  // still reflects the canonical key. See canonicalize-connector-keys Decision 1.
  const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;

  return {
    owner_subject_id: ownerSubjectId,
    public_scope: "polyfill",
    source: { id: connectorKey, kind: "connector" },
    storage_binding: {
      connector_id: connectorKey,
      connector_instance_id: resolveSingleConnectorIdQueryValue(req.query.connector_instance_id),
    },
  };
}

export function getOwnerTokenSubjectId(req: { tokenInfo?: { subject_id?: string } }): string {
  return req.tokenInfo?.subject_id || OWNER_AUTH_DEFAULT_SUBJECT_ID;
}

export function resolveSingleConnectorIdQueryValue(rawConnectorId: unknown): string | null {
  if (typeof rawConnectorId !== "string") {
    return null;
  }
  const trimmed = rawConnectorId.trim();
  return trimmed || null;
}
