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
}
