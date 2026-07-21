// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure utility functions for connector-instance id derivation.
 *
 * These are shared by db.js (SQLite bootstrap) and postgres-storage.js
 * (Postgres bootstrap) without either importing from the other. A third
 * module (`stores/connector-instance-store.js`) also uses these and
 * re-exports the key-derivation helpers — it cannot import from db.js or
 * postgres-storage.js without creating a circular dependency, so the
 * canonical implementations live here.
 *
 * All functions are pure: no I/O, no side effects, no imports beyond
 * `node:crypto`.
 */

import { createHash } from "node:crypto";

export type SpineSourceKind = "connector" | "provider_native";

export interface SpineSource {
  id: string;
  kind: SpineSourceKind;
}

export function stableJson(value: unknown): string {
  if (value == null) {
    return "{}";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function makeConnectorInstanceSourceBindingKey(sourceBinding: unknown): string {
  return hashKey(stableJson(sourceBinding ?? {}));
}

export function makeConnectorInstanceId(
  ownerSubjectId: string,
  connectorId: string,
  sourceKind: string,
  sourceBindingKey: string
): string {
  return `cin_${hashKey(`${ownerSubjectId}\n${connectorId}\n${sourceKind}\n${sourceBindingKey}`).slice(0, 24)}`;
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function isSourceKind(value: unknown): value is SpineSourceKind {
  return value === "connector" || value === "provider_native";
}

export function parseSpineSourceShape(value: unknown): SpineSource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const source = value as Record<string, unknown>;
  const canonicalKind = nonEmptyString(source.kind);
  const canonicalId = nonEmptyString(source.id);
  if (isSourceKind(canonicalKind) && canonicalId) {
    return { kind: canonicalKind, id: canonicalId };
  }

  const legacyKind = nonEmptyString(source.binding_kind);
  if (legacyKind === "connector") {
    const id = nonEmptyString(source.connector_id);
    if (id) {
      return { kind: "connector", id };
    }
  }
  if (legacyKind === "provider_native") {
    const id = nonEmptyString(source.provider_id);
    if (id) {
      return { kind: "provider_native", id };
    }
  }

  const connectorId = nonEmptyString(source.connector_id);
  const providerId = nonEmptyString(source.provider_id);
  if (connectorId && !providerId) {
    return { kind: "connector", id: connectorId };
  }
  if (providerId && !connectorId) {
    return { kind: "provider_native", id: providerId };
  }

  return null;
}

// Resolve a spine source from an explicit request payload (the `source` /
// `source_binding` shapes, then bare connector_id/provider_id). Returns null
// when the payload carries no usable binding, so the caller can fall back to
// the persisted row columns.
function deriveSpineSourceFromPayload(payload: unknown): SpineSource | null {
  if (!(payload && typeof payload === "object") || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (Object.hasOwn(record, "source")) {
    const source = parseSpineSourceShape(record.source);
    if (source) {
      return source;
    }
  }
  if (Object.hasOwn(record, "source_binding")) {
    const source = parseSpineSourceShape(record.source_binding);
    if (source) {
      return source;
    }
  }
  const connectorId = nonEmptyString(record.connector_id);
  const providerId = nonEmptyString(record.provider_id);
  if (connectorId && !providerId) {
    return { kind: "connector", id: connectorId };
  }
  if (providerId && !connectorId) {
    return { kind: "provider_native", id: providerId };
  }
  return null;
}

export function deriveSpineSource(payload: unknown, row: Record<string, unknown>): SpineSource | null {
  const fromPayload = deriveSpineSourceFromPayload(payload);
  if (fromPayload) {
    return fromPayload;
  }

  const sourceKind = nonEmptyString(row.source_kind);
  const sourceId = nonEmptyString(row.source_id);
  if (isSourceKind(sourceKind) && sourceId) {
    return { kind: sourceKind, id: sourceId };
  }

  const providerId = nonEmptyString(row.provider_id);
  if (providerId) {
    return { kind: "provider_native", id: providerId };
  }

  const actorId = nonEmptyString(row.actor_id);
  if (row.actor_type === "runtime" && actorId) {
    return { kind: "connector", id: actorId };
  }

  return null;
}
