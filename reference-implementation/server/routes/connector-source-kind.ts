// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Manifest-derived connector-instance source-kind resolver, shared by the
// device-exporter enrollment-code and enroll routes (and available to the
// owner-connection-intent route, which classifies the same binding signal into
// an intent modality).
//
// This is the connector-instance source-binding axis only — `local_device` and
// `browser_collector` are peers on that axis. It is NOT the spine event
// `SourceKind` union (`connector | provider_native`) and is NOT PDPP Core
// protocol vocabulary. See
// `openspec/changes/add-browser-collector-enrollment-primitive/design.md`
// Decision 1.
//
// Binding precedence mirrors `classifyConnectorIntentModality`
// (`owner-connection-intent.ts`): `filesystem` wins over `browser` if a manifest
// somehow declares both, so the enroll path and the intent path agree on the
// same manifest-derived placement signal. Per design Decision 2:
//   - a `filesystem` binding              → `local_device`
//   - a `browser` binding (no filesystem) → `browser_collector`
//   - neither binding, or no manifest      → typed reject (never default)
//   - an explicit kind contradicting the   → typed reject
//     manifest

// The connector-instance source-binding source kinds this resolver assigns at
// enrollment. `account` and `manual` exist on the column but are not enrollment
// outcomes, so they are not part of this enrollment-derived union.
export type EnrolledSourceKind = "local_device" | "browser_collector";

// Minimal manifest shape this resolver reads. Manifests carry far more; only the
// runtime binding requirements drive the source-kind decision.
export interface SourceKindManifestLike {
  readonly runtime_requirements?: {
    readonly bindings?: Readonly<Record<string, unknown>> | null;
  } | null;
}

// Typed error raised when a source kind cannot be resolved or when a caller
// supplies a kind that contradicts the manifest. Carries an `invalid_request`
// code + param so the route's existing `handleError`/`pdppError` mapping turns
// it into a 400 without special-casing.
export class SourceKindResolutionError extends Error {
  readonly code = "invalid_request";
  readonly param: string;
  constructor(message: string, param = "connector_id") {
    super(message);
    this.name = "SourceKindResolutionError";
    this.param = param;
  }
}

// The source kind a manifest's bindings imply, or `null` when the manifest
// declares neither a `filesystem` nor a `browser` binding (or is absent).
export function sourceKindFromManifestBindings(
  manifest: SourceKindManifestLike | null | undefined
): EnrolledSourceKind | null {
  const bindings = manifest?.runtime_requirements?.bindings;
  if (!bindings || typeof bindings !== "object") {
    return null;
  }
  if (Object.hasOwn(bindings, "filesystem")) {
    return "local_device";
  }
  if (Object.hasOwn(bindings, "browser")) {
    return "browser_collector";
  }
  return null;
}

// Resolve the source kind to enroll for a connector, given its manifest and an
// optional caller-supplied explicit kind. Rejects (throws
// `SourceKindResolutionError`) when:
//   - the manifest declares no resolvable binding, or no manifest is registered;
//   - the caller supplies a kind that contradicts the manifest-derived kind.
// Never defaults to a source kind.
export function resolveEnrolledSourceKind(args: {
  connectorId: string;
  manifest: SourceKindManifestLike | null | undefined;
  requestedSourceKind?: string | null | undefined;
}): EnrolledSourceKind {
  const { connectorId, manifest, requestedSourceKind } = args;
  const derived = sourceKindFromManifestBindings(manifest);
  if (!derived) {
    throw new SourceKindResolutionError(
      `Cannot enroll connector '${connectorId}': no registered manifest declares a 'filesystem' or 'browser' binding, so the source kind cannot be resolved.`
    );
  }
  if (requestedSourceKind != null && requestedSourceKind !== derived) {
    throw new SourceKindResolutionError(
      `source_kind '${requestedSourceKind}' contradicts connector '${connectorId}' manifest bindings (expected '${derived}').`,
      "source_kind"
    );
  }
  return derived;
}
