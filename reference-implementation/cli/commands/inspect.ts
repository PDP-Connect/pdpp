// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseArgs, requirePositional } from "../lib/args.ts";
import { readJsonInput } from "../lib/common.ts";
import { PdppUsageError } from "../lib/errors.ts";
import { resolveFormat, writeData } from "../lib/output.ts";

// `pdpp inspect` renders arbitrary caller-supplied JSON (a grant, a pending
// consent request, or a connector manifest read from a file or stdin). None
// of these shapes are trusted input, so every accessor below validates
// before use; the loose index-signature record types here exist only to let
// the manual `require*` guards narrow, not to assert the input is honest.
type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

// Async to keep a uniform Promise<void> signature across index.ts's
// COMMANDS dispatch table; inspect only renders caller-supplied JSON and
// needs no local await.
// biome-ignore lint/suspicious/useAwait: see comment above
export async function runInspect(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  const source = requirePositional(positionals, 0, "path-or--");
  const json = readJsonInput(source);
  const format = resolveFormat(flags, subcommand === "manifest" ? "table" : "json", "json");

  if (subcommand === "grant") {
    writeData(renderGrant(json), format);
    return;
  }
  if (subcommand === "request") {
    writeData(renderRequest(json), format);
    return;
  }
  if (subcommand === "manifest") {
    writeData(renderManifest(json), format);
    return;
  }

  throw new PdppUsageError("Usage: pdpp inspect <grant|request|manifest> <path-or-> [--format json|table]");
}

function renderGrant(grantInput: unknown) {
  const grant = asRecord(grantInput);
  const sourceBinding = requireSourceBinding(grant.source, "grant.source");
  if (grant.grant_storage_binding !== undefined) {
    const storageBinding = requireStorageBinding(grant.grant_storage_binding, "grant.grant_storage_binding");
    requireCoherentBindings(sourceBinding, storageBinding, "grant.source", "grant.grant_storage_binding");
  }
  const client = asRecord(grant.client);
  const clientDisplay = asRecord(client.client_display);
  const subject = asRecord(grant.subject);
  const streams = Array.isArray(grant.streams) ? grant.streams : [];
  return {
    access_mode: grant.access_mode || "",
    client_display: clientDisplay.name || "",
    client_id: client.client_id || "",
    expires_at: grant.expires_at || "",
    grant_id: grant.grant_id,
    purpose_code: grant.purpose_code || "",
    source_id: sourceBinding.id,
    source_kind: sourceBinding.kind,
    streams: streams.map((stream) => asRecord(stream).name).join(", "),
    subject_id: subject.id || "",
  };
}

function renderRequest(requestInput: unknown) {
  const request = asRecord(requestInput);
  const client = asRecord(request.client);
  const clientDisplay = asRecord(client.client_display);
  const selection = asRecord(request.selection);
  const clientDisplayName = clientDisplay.name || client.client_id || "";
  const purposeCode = selection.purpose_code || "";
  const accessMode = selection.access_mode || "";
  const selectionStreams = Array.isArray(selection.streams) ? selection.streams : [];
  const streams = selectionStreams.map((stream) => asRecord(stream).name).join(", ") || "";
  const sourceBinding = requireSourceBinding(request.source_binding, "request.source_binding");
  const storageBinding = requireStorageBinding(request.storage_binding, "request.storage_binding");
  requireCoherentBindings(sourceBinding, storageBinding, "request.source_binding", "request.storage_binding");

  return {
    access_mode: accessMode,
    client_display: clientDisplayName,
    purpose_code: purposeCode,
    source_id: sourceBinding.id,
    source_kind: sourceBinding.kind,
    streams,
  };
}

function renderManifest(manifestInput: unknown) {
  const manifest = asRecord(manifestInput);
  const { sourceKind, sourceId } = requireManifestSource(manifest);
  const streams = Array.isArray(manifest.streams) ? manifest.streams : [];
  return streams.map((streamInput) => {
    const stream = asRecord(streamInput);
    return {
      primary_key: Array.isArray(stream.primary_key) ? stream.primary_key.join(", ") : stream.primary_key || "",
      semantics: stream.semantics,
      source_id: sourceId,
      source_kind: sourceKind,
      stream: stream.name,
    };
  });
}

interface SourceBindingResult {
  id: string;
  kind: "connector" | "provider_native";
}

function requireSourceBinding(sourceBindingInput: unknown, fieldName: string): SourceBindingResult {
  if (!sourceBindingInput || typeof sourceBindingInput !== "object") {
    throw new PdppUsageError(`${fieldName} must be source: { kind: 'connector' | 'provider_native', id }`);
  }
  const sourceBinding = sourceBindingInput as UnknownRecord;

  requireExactKeys(sourceBinding, ["kind", "id"], fieldName);
  if (sourceBinding.kind !== "connector" && sourceBinding.kind !== "provider_native") {
    throw new PdppUsageError(`${fieldName}.kind must be 'connector' or 'provider_native'`);
  }
  if (typeof sourceBinding.id === "string" && sourceBinding.id.trim()) {
    return { id: sourceBinding.id.trim(), kind: sourceBinding.kind };
  }

  throw new PdppUsageError(`${fieldName}.id is required`);
}

interface StorageBindingResult {
  connector_id: string;
}

function requireStorageBinding(storageBindingInput: unknown, fieldName: string): StorageBindingResult {
  if (!storageBindingInput || typeof storageBindingInput !== "object") {
    throw new PdppUsageError(`${fieldName} must use the current structured binding shape`);
  }
  const storageBinding = storageBindingInput as UnknownRecord;

  requireExactKeys(storageBinding, ["connector_id"], fieldName);
  if (typeof storageBinding.connector_id === "string" && storageBinding.connector_id.trim()) {
    return { connector_id: storageBinding.connector_id.trim() };
  }

  throw new PdppUsageError(`${fieldName}.connector_id is required`);
}

function requireExactKeys(input: UnknownRecord, allowedKeys: string[], fieldName: string): void {
  const unsupportedKeys = Object.keys(input).filter((key) => !allowedKeys.includes(key));
  if (unsupportedKeys.length) {
    throw new PdppUsageError(`${fieldName} must include only ${allowedKeys.join(" and ")}`);
  }
}

function requireCoherentBindings(
  sourceBinding: SourceBindingResult,
  storageBinding: StorageBindingResult,
  sourceFieldName: string,
  storageFieldName: string
): void {
  if (sourceBinding.kind === "connector" && sourceBinding.id !== storageBinding.connector_id) {
    throw new PdppUsageError(`${sourceFieldName}.id must match ${storageFieldName}.connector_id for connector access`);
  }
}

function requireManifestSource(manifest: UnknownRecord): {
  sourceKind: "connector" | "provider_native";
  sourceId: string;
} {
  const providerId = typeof manifest.provider_id === "string" ? manifest.provider_id : null;
  const connectorId = typeof manifest.connector_id === "string" ? manifest.connector_id : null;
  const hasProviderId = Boolean(providerId?.trim());
  const hasConnectorId = Boolean(connectorId?.trim());

  if (hasProviderId && hasConnectorId) {
    throw new PdppUsageError("manifest must not include both provider_id and connector_id");
  }
  if (hasProviderId && providerId) {
    requireStorageBinding(manifest.storage_binding, "manifest.storage_binding");
    return { sourceId: providerId.trim(), sourceKind: "provider_native" };
  }
  if (hasConnectorId && connectorId) {
    if (manifest.storage_binding !== undefined) {
      throw new PdppUsageError("connector manifests must not include storage_binding");
    }
    return { sourceId: connectorId.trim(), sourceKind: "connector" };
  }

  throw new PdppUsageError("manifest must include either provider_id or connector_id");
}
