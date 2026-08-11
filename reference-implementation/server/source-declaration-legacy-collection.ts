// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { SourceDeclaration, SourceDeclarationStream } from "@pdpp/reference-contract/public/source";
import {
  InvalidSourceDeclarationError,
  requireSourceDeclaration,
  snapshotSourceDeclaration,
} from "./source-declaration.ts";

export const COLLECTION_PROFILE_URI = "https://pdpp.org/profile/collection";
export const LEGACY_CONNECTOR_PROJECTION_VERSION_PREFIX = "reference.legacy-connector-projection.v1";

export interface LegacyConnectorDeclarationAttribution {
  connectorImplementationId?: string;
  declarationVersion: string;
  publisherId: string;
  sourceId: string;
}

type JsonObject = Record<string, unknown>;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isObject(value)) {
    const members = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidSourceDeclarationError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireAbsoluteUri(value: unknown, field: string): string {
  const uri = requireNonEmptyString(value, field);
  if (!URL.canParse(uri)) {
    throw new InvalidSourceDeclarationError(`${field} must be an absolute URI`);
  }
  return uri;
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function requireLegacyStreams(manifest: JsonObject): JsonObject[] {
  if (!(Array.isArray(manifest.streams) && manifest.streams.length > 0)) {
    throw new InvalidSourceDeclarationError("manifest.streams must be a non-empty array");
  }
  const malformedIndex = manifest.streams.findIndex((stream) => !isObject(stream));
  if (malformedIndex !== -1) {
    throw new InvalidSourceDeclarationError(`manifest.streams[${malformedIndex}] must be an object`);
  }
  return manifest.streams as JsonObject[];
}

function sourceStreamFromLegacy(stream: JsonObject): SourceDeclarationStream {
  const commonKeys = [
    "consent_time_field",
    "cursor_field",
    "description",
    "display",
    "name",
    "primary_key",
    "query",
    "relationships",
    "schema",
    "semantics",
    "views",
  ] as const;
  const commonStream: JsonObject = {};
  for (const key of commonKeys) {
    if (stream[key] !== undefined) {
      commonStream[key] = cloneJson(stream[key]);
    }
  }
  if (commonStream.semantics === "append") {
    commonStream.semantics = "append_only";
  }
  const legacySelection = isObject(stream.selection) ? stream.selection : {};
  commonStream.selection = {
    fields: legacySelection.fields,
    resources: legacySelection.resources,
  };
  return commonStream as unknown as SourceDeclarationStream;
}

function collectionExtensionFromLegacy(
  manifest: JsonObject,
  streams: JsonObject[],
  connectorImplementationId: string,
  connectorVersion: string
): JsonObject {
  const runtimeRequirements = isObject(manifest.runtime_requirements) ? manifest.runtime_requirements : undefined;
  const extension: JsonObject = {
    connector: { id: connectorImplementationId, version: connectorVersion },
    runtime_requirements: {
      bindings: cloneJson(runtimeRequirements?.bindings ?? {}),
    },
  };
  const capabilities = isObject(manifest.capabilities) ? manifest.capabilities : undefined;
  if (capabilities?.human_interaction !== undefined) {
    extension.capabilities = { human_interaction: cloneJson(capabilities.human_interaction) };
  }
  const incrementalStreams = streams
    .filter((stream) => typeof stream.incremental === "boolean")
    .map((stream) => ({ incremental: stream.incremental, name: stream.name }));
  if (incrementalStreams.length > 0) {
    extension.streams = incrementalStreams;
  }
  return extension;
}

/**
 * Compatibility projection only. The legacy manifest remains authoritative
 * for reference-implementation setup and operational metadata.
 */
export function sourceDeclarationFromLegacyConnectorManifest(
  manifest: JsonObject,
  attribution: LegacyConnectorDeclarationAttribution
): SourceDeclaration {
  const sourceId = requireAbsoluteUri(attribution.sourceId, "sourceId");
  const publisherId = requireAbsoluteUri(attribution.publisherId, "publisherId");
  const declarationVersion = requireNonEmptyString(attribution.declarationVersion, "declarationVersion");
  const connectorVersion = requireNonEmptyString(manifest.version, "manifest.version");
  const connectorImplementationId = requireAbsoluteUri(
    attribution.connectorImplementationId ?? manifest.connector_id,
    "connectorImplementationId"
  );
  const streams = requireLegacyStreams(manifest);
  const protocolVersion = requireNonEmptyString(manifest.protocol_version, "manifest.protocol_version");
  if (protocolVersion !== "0.1.0") {
    throw new InvalidSourceDeclarationError(`manifest.protocol_version must be 0.1.0, received ${protocolVersion}`);
  }
  const declaration: SourceDeclaration = {
    declaration_version: declarationVersion,
    display: { name: requireNonEmptyString(manifest.display_name, "manifest.display_name") },
    extensions: {
      [COLLECTION_PROFILE_URI]: collectionExtensionFromLegacy(
        manifest,
        streams,
        connectorImplementationId,
        connectorVersion
      ),
    },
    protocol_version: protocolVersion,
    publisher: { id: publisherId },
    source: { id: sourceId, kind: "connector" },
    streams: streams.map(sourceStreamFromLegacy),
  };
  if (Array.isArray(manifest.profiles)) {
    declaration.selection_presets = cloneJson(manifest.profiles) as NonNullable<SourceDeclaration["selection_presets"]>;
  }
  return requireSourceDeclaration(declaration);
}

/** Project a legacy manifest into one detached immutable declaration value. */
export function snapshotSourceDeclarationFromLegacyConnectorManifest(
  manifest: JsonObject,
  attribution: LegacyConnectorDeclarationAttribution
): SourceDeclaration {
  return snapshotSourceDeclaration(sourceDeclarationFromLegacyConnectorManifest(manifest, attribution));
}

/**
 * Project a legacy connector manifest and identify the exact normalized
 * declaration content. The version excludes its own field from the digest so
 * the identity is deterministic and non-circular.
 */
export function snapshotContentAddressedSourceDeclarationFromLegacyConnectorManifest(
  manifest: JsonObject,
  attribution: Omit<LegacyConnectorDeclarationAttribution, "declarationVersion">
): SourceDeclaration {
  const provisional = sourceDeclarationFromLegacyConnectorManifest(manifest, {
    ...attribution,
    declarationVersion: `${LEGACY_CONNECTOR_PROJECTION_VERSION_PREFIX}:pending`,
  });
  const { declaration_version: _declarationVersion, ...content } = provisional;
  const digest = createHash("sha256").update(stableJson(content)).digest("hex");
  return snapshotSourceDeclaration({
    ...provisional,
    declaration_version: `${LEGACY_CONNECTOR_PROJECTION_VERSION_PREFIX}:sha256:${digest}`,
  });
}
