// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shape a connector uses to declare its local-collector participation.
 *
 * A connector that supports local (device-side) collection exports one
 * {@link LocalCollectorDefinition} as pure data next to its `index.ts`. The
 * publishable `@pdpp/local-collector` runtime is generic: it turns these
 * definitions into its runnable connector registry rather than hardcoding a
 * per-connector table. This keeps the direction of knowledge correct — the
 * connector defines its own collector; the runtime does not know specific
 * connectors.
 *
 * Type-only module: no runtime values, no imports beyond types, so it is safe
 * to pull into both the connector packages and the runner-side registry the
 * collector build re-exports.
 */

/** A runtime binding the connector requires from the collector host. */
export interface LocalCollectorBinding {
  readonly required: boolean;
}

export interface LocalCollectorDefinition {
  /** Runtime bindings the connector requires (e.g. `filesystem`). Keyed by binding name. */
  readonly bindings: Readonly<Record<string, LocalCollectorBinding>>;
  /** Stable connector id (matches the manifest + ingest envelope). */
  readonly connector_id: string;
  /**
   * The connector's directory name under `connectors/`, used by the runtime to
   * resolve the spawnable entry module (`connectors/<entry>/index.{js,ts}`).
   * Kept as a bare segment — never a path — so the runtime owns path shape and
   * the definition stays a pure, platform-independent value.
   */
  readonly entry: string;
  /**
   * Default streams an unscoped `run` should request. Operators can override
   * with `--streams`. Must be non-empty and manifest-declared.
   */
  readonly streams: readonly string[];
  /**
   * Streams an owner-declared `since` boundary can honestly bind to: exactly
   * those whose manifest declares a `consent_time_field`, mirrored here because
   * the published collector runtime ships no manifests (it knows only the
   * definitions injected into its registry) and must not guess.
   *
   * The direction of knowledge is the same as `streams`: the connector declares
   * what it can prove a bound against; the runtime enforces without knowing any
   * connector. A stream omitted here is NEVER silently narrowed against a field
   * it does not have — it is collected whole and reported as out-of-scope, which
   * is the honest outcome rather than an invisible drop.
   *
   * Absent/empty means the connector supports no time boundary at all.
   */
  readonly time_scopable_streams?: readonly string[];
}
