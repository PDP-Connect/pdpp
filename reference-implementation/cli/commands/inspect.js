// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseArgs, requirePositional } from '../lib/args.js';
import { readJsonInput } from '../lib/common.js';
import { PdppUsageError } from '../lib/errors.js';
import { resolveFormat, writeData } from '../lib/output.js';

export async function runInspect(argv) {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  const source = requirePositional(positionals, 0, 'path-or--');
  const json = readJsonInput(source);
  const format = resolveFormat(flags, subcommand === 'manifest' ? 'table' : 'json', 'json');

  if (subcommand === 'grant') {
    writeData(renderGrant(json), format);
    return;
  }
  if (subcommand === 'request') {
    writeData(renderRequest(json), format);
    return;
  }
  if (subcommand === 'manifest') {
    writeData(renderManifest(json), format);
    return;
  }

  throw new PdppUsageError('Usage: pdpp inspect <grant|request|manifest> <path-or-> [--format json|table]');
}

function renderGrant(grant) {
  const sourceBinding = requireSourceBinding(grant.source, 'grant.source');
  if (grant.grant_storage_binding !== undefined) {
    const storageBinding = requireStorageBinding(grant.grant_storage_binding, 'grant.grant_storage_binding');
    requireCoherentBindings(sourceBinding, storageBinding, 'grant.source', 'grant.grant_storage_binding');
  }
  return {
    grant_id: grant.grant_id,
    client_id: grant.client?.client_id || '',
    client_display: grant.client?.client_display?.name || '',
    subject_id: grant.subject?.id || '',
    access_mode: grant.access_mode || '',
    purpose_code: grant.purpose_code || '',
    source_kind: sourceBinding.kind,
    source_id: sourceBinding.id,
    streams: (grant.streams || []).map((stream) => stream.name).join(', '),
    expires_at: grant.expires_at || '',
  };
}

function renderRequest(request) {
  const clientDisplay =
    request.client?.client_display?.name ||
    request.client?.client_id ||
    '';
  const purposeCode =
    request.selection?.purpose_code || '';
  const accessMode =
    request.selection?.access_mode || '';
  const streams =
    request.selection?.streams?.map((stream) => stream.name).join(', ') || '';
  const sourceBinding = requireSourceBinding(request.source_binding, 'request.source_binding');
  const storageBinding = requireStorageBinding(request.storage_binding, 'request.storage_binding');
  requireCoherentBindings(sourceBinding, storageBinding, 'request.source_binding', 'request.storage_binding');

  return {
    client_display: clientDisplay,
    purpose_code: purposeCode,
    access_mode: accessMode,
    source_kind: sourceBinding.kind,
    source_id: sourceBinding.id,
    streams,
  };
}

function renderManifest(manifest) {
  const { sourceKind, sourceId } = requireManifestSource(manifest);
  return (manifest.streams || []).map((stream) => ({
    source_id: sourceId,
    source_kind: sourceKind,
    stream: stream.name,
    semantics: stream.semantics,
    primary_key: Array.isArray(stream.primary_key)
      ? stream.primary_key.join(', ')
      : (stream.primary_key || ''),
  }));
}

function requireSourceBinding(sourceBinding, fieldName) {
  if (!sourceBinding || typeof sourceBinding !== 'object') {
    throw new PdppUsageError(`${fieldName} must be source: { kind: 'connector' | 'provider_native', id }`);
  }

  requireExactKeys(sourceBinding, ['kind', 'id'], fieldName);
  if (sourceBinding.kind !== 'connector' && sourceBinding.kind !== 'provider_native') {
    throw new PdppUsageError(`${fieldName}.kind must be 'connector' or 'provider_native'`);
  }
  if (typeof sourceBinding.id === 'string' && sourceBinding.id.trim()) {
    return { kind: sourceBinding.kind, id: sourceBinding.id.trim() };
  }

  throw new PdppUsageError(`${fieldName}.id is required`);
}

function requireStorageBinding(storageBinding, fieldName) {
  if (!storageBinding || typeof storageBinding !== 'object') {
    throw new PdppUsageError(`${fieldName} must use the current structured binding shape`);
  }

  requireExactKeys(storageBinding, ['connector_id'], fieldName);
  if (typeof storageBinding.connector_id === 'string' && storageBinding.connector_id.trim()) {
    return { connector_id: storageBinding.connector_id.trim() };
  }

  throw new PdppUsageError(`${fieldName}.connector_id is required`);
}

function requireExactKeys(input, allowedKeys, fieldName) {
  const unsupportedKeys = Object.keys(input).filter((key) => !allowedKeys.includes(key));
  if (unsupportedKeys.length) {
    throw new PdppUsageError(`${fieldName} must include only ${allowedKeys.join(' and ')}`);
  }
}

function requireCoherentBindings(sourceBinding, storageBinding, sourceFieldName, storageFieldName) {
  if (sourceBinding.kind === 'connector' && sourceBinding.id !== storageBinding.connector_id) {
    throw new PdppUsageError(`${sourceFieldName}.id must match ${storageFieldName}.connector_id for connector access`);
  }
}

function requireManifestSource(manifest) {
  const hasProviderId = typeof manifest?.provider_id === 'string' && manifest.provider_id.trim();
  const hasConnectorId = typeof manifest?.connector_id === 'string' && manifest.connector_id.trim();

  if (hasProviderId && hasConnectorId) {
    throw new PdppUsageError('manifest must not include both provider_id and connector_id');
  }
  if (hasProviderId) {
    requireStorageBinding(manifest.storage_binding, 'manifest.storage_binding');
    return { sourceKind: 'provider_native', sourceId: manifest.provider_id.trim() };
  }
  if (hasConnectorId) {
    if (manifest.storage_binding !== undefined) {
      throw new PdppUsageError('connector manifests must not include storage_binding');
    }
    return { sourceKind: 'connector', sourceId: manifest.connector_id.trim() };
  }

  throw new PdppUsageError('manifest must include either provider_id or connector_id');
}
