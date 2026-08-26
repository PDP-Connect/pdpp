// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolves a connector's owner-facing config form: the SHAPE it declares in
 * its own manifest `options_schema`, merged with the KIND the platform
 * decides in `connector-config-option-kind-registry.ts`.
 *
 * The split is the whole point, and it is deliberately asymmetric:
 *
 *   SHAPE is connector-owned. Field names, types, labels, defaults and
 *   validation bounds are that connector's own facts, declared as data in
 *   its manifest exactly like `streams` and `reason_display_messages`. This
 *   is what lets the config surface reach all 45 connectors without a
 *   core-repo edit per connector.
 *
 *   KIND is platform-owned. Whether a knob is `transport` (self-activates)
 *   or `collection_scope` (lands `proposed`, inert until the owner
 *   confirms) is decided ONLY by the registry. A manifest's
 *   `declared_option_kind` is never read by this module at all. It exists
 *   so `connector-config-option-kind-honesty.test.ts` can fail the build on
 *   a connector whose claim disagrees with the registry -- a documentation
 *   claim under test, not an input to any runtime decision.
 *
 * If a manifest value could influence the kind, a connector could label its
 * own collection-shaping knob `transport` and thereby self-activate it,
 * bypassing owner confirmation entirely. So this module fails closed twice
 * over: `resolveEnforcedOptionKind` returns `collection_scope` for any key
 * the registry does not know, and the manifest's claim is never consulted
 * as an input to that decision. An unregistered connector gets a fully
 * renderable form in which EVERY field requires owner confirmation -- the
 * safe direction to be wrong in.
 *
 * Shape validation is intentionally thin. It covers what a form actually
 * needs to render a control and reject bad input before it reaches the
 * config store, and nothing more; this is not a JSON Schema implementation
 * and should not grow into one.
 */

import {
  type ConfigOptionKind,
  platformOptionKind,
  resolveEnforcedOptionKind,
} from "./connector-config-option-kind-registry.ts";
import { readPolyfillManifests } from "./manifest-registry.ts";

/** The control a form renders, and how `readOptions` will coerce the value. */
export type ConfigOptionType = "boolean" | "integer" | "string" | "string_array";

export class ConnectorOptionsSchemaError extends Error {}

/** One option, after the connector's declared shape is merged with the platform's decided kind. */
export interface ResolvedConfigOption {
  /** Value used when the owner has set nothing. Always present and type-correct. */
  readonly defaultValue: boolean | number | string | readonly string[];
  /** Owner-facing explanation, from the manifest. */
  readonly description: string;
  /** Closed set of accepted values, when the connector declares one. */
  readonly enumValues: readonly string[] | null;
  /** Inclusive upper bound for `integer`, when declared. */
  readonly maximum: number | null;
  /** Inclusive lower bound for `integer`, when declared. */
  readonly minimum: number | null;
  /** The option key, matching `readOptions`' field name (e.g. `LOOKBACK_DAYS`). */
  readonly optionKey: string;
  /**
   * PLATFORM-DECIDED, never manifest-supplied. `transport` self-activates;
   * `collection_scope` requires an explicit owner confirm.
   */
  readonly optionKind: ConfigOptionKind;
  /**
   * True when the platform registry actually classified this key. False
   * means `optionKind` is the fail-closed `collection_scope` default, which
   * an owner-facing surface may want to say out loud.
   */
  readonly platformClassified: boolean;
  readonly type: ConfigOptionType;
}

/** One connector's whole owner-facing config form. */
export interface ResolvedConnectorOptionsSchema {
  readonly connectorKey: string;
  readonly description: string;
  /** Sorted by option key, so a rendered form and its tests are order-stable. */
  readonly options: readonly ResolvedConfigOption[];
}

const OPTION_TYPES: ReadonlySet<string> = new Set(["boolean", "integer", "string", "string_array"]);
const REGISTRY_URL_PREFIX = "https://registry.pdpp.dev/connectors/";
const JSON_SUFFIX_RE = /\.json$/;

interface ManifestLike {
  connector_id?: unknown;
  connector_key?: unknown;
  options_schema?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function manifestKey(manifest: ManifestLike, fallbackFile: string): string {
  if (typeof manifest.connector_key === "string" && manifest.connector_key.trim()) {
    return manifest.connector_key.trim();
  }
  if (typeof manifest.connector_id === "string" && manifest.connector_id.trim()) {
    return manifest.connector_id.startsWith(REGISTRY_URL_PREFIX)
      ? manifest.connector_id.slice(REGISTRY_URL_PREFIX.length)
      : manifest.connector_id;
  }
  return fallbackFile.replace(JSON_SUFFIX_RE, "");
}

/**
 * The declared JSON-Schema-ish `type`/`items` collapsed onto the closed set
 * of controls a form can actually render. Anything outside that set is a
 * manifest authoring error, not something to guess at.
 */
function readOptionType(where: string, prop: Record<string, unknown>): ConfigOptionType {
  const declared = prop.type;
  if (typeof declared !== "string" || !OPTION_TYPES.has(declared === "array" ? "string_array" : declared)) {
    throw new ConnectorOptionsSchemaError(
      `${where}: type must be one of boolean, integer, string, array (of string); got ${JSON.stringify(declared)}`
    );
  }
  if (declared !== "array") {
    return declared as ConfigOptionType;
  }
  const { items } = prop;
  if (!isRecord(items) || items.type !== "string") {
    throw new ConnectorOptionsSchemaError(`${where}: an array option must declare items.type "string"`);
  }
  return "string_array";
}

function readDefaultValue(
  where: string,
  type: ConfigOptionType,
  raw: unknown
): boolean | number | string | readonly string[] {
  if (raw === undefined) {
    throw new ConnectorOptionsSchemaError(`${where}: a default is required, so a form can render an unset option`);
  }
  switch (type) {
    case "boolean": {
      if (typeof raw !== "boolean") {
        throw new ConnectorOptionsSchemaError(`${where}: default must be a boolean`);
      }
      return raw;
    }
    case "integer": {
      if (typeof raw !== "number" || !Number.isInteger(raw)) {
        throw new ConnectorOptionsSchemaError(`${where}: default must be an integer`);
      }
      return raw;
    }
    case "string": {
      if (typeof raw !== "string") {
        throw new ConnectorOptionsSchemaError(`${where}: default must be a string`);
      }
      return raw;
    }
    default: {
      if (!(Array.isArray(raw) && raw.every((entry) => typeof entry === "string"))) {
        throw new ConnectorOptionsSchemaError(`${where}: default must be an array of strings`);
      }
      return Object.freeze([...(raw as string[])]);
    }
  }
}

function readBound(where: string, field: "maximum" | "minimum", raw: unknown): number | null {
  if (raw === undefined) {
    return null;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new ConnectorOptionsSchemaError(`${where}: ${field} must be an integer when declared`);
  }
  return raw;
}

function readEnumValues(where: string, raw: unknown): readonly string[] | null {
  if (raw === undefined) {
    return null;
  }
  if (!(Array.isArray(raw) && raw.length > 0 && raw.every((entry) => typeof entry === "string"))) {
    throw new ConnectorOptionsSchemaError(`${where}: enum must be a non-empty array of strings when declared`);
  }
  return Object.freeze([...(raw as string[])]);
}

function readDescription(where: string, raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ConnectorOptionsSchemaError(`${where}: description must be a non-empty string`);
  }
  return raw;
}

function resolveOption(
  connectorKey: string,
  where: string,
  optionKey: string,
  prop: Record<string, unknown>
): ResolvedConfigOption {
  const type = readOptionType(where, prop);
  const minimum = readBound(where, "minimum", prop.minimum);
  const maximum = readBound(where, "maximum", prop.maximum);
  if (minimum !== null && maximum !== null && minimum > maximum) {
    throw new ConnectorOptionsSchemaError(`${where}: minimum ${minimum} exceeds maximum ${maximum}`);
  }

  // The KIND comes from the platform registry and ONLY the platform
  // registry. `prop.declared_option_kind` is deliberately not read here: a
  // manifest that could influence this line could grant itself
  // self-activation. Unknown keys fall back to collection_scope.
  const platformKind = resolveEnforcedOptionKind(connectorKey, optionKey);

  return Object.freeze({
    defaultValue: readDefaultValue(where, type, prop.default),
    description: readDescription(where, prop.description),
    enumValues: readEnumValues(where, prop.enum),
    maximum,
    minimum,
    optionKind: platformKind,
    optionKey,
    // Distinguishes "the registry classified this key" from "the registry
    // has never heard of it, so it failed closed to collection_scope". Both
    // enforce identically; only the owner-facing explanation differs.
    platformClassified: platformOptionKind(connectorKey, optionKey) !== null,
    type,
  });
}

/** Parses one manifest's `options_schema`, or returns null when it declares none. */
export function resolveOptionsSchemaFromManifest(
  manifest: unknown,
  file: string
): ResolvedConnectorOptionsSchema | null {
  const typed = manifest as ManifestLike;
  const raw = typed.options_schema;
  if (raw === undefined) {
    return null;
  }
  const connectorKey = manifestKey(typed, file);
  if (!isRecord(raw)) {
    throw new ConnectorOptionsSchemaError(`${file}: options_schema must be an object`);
  }
  if (raw.type !== "object") {
    throw new ConnectorOptionsSchemaError(`${file}: options_schema.type must be "object"`);
  }
  const { properties } = raw;
  if (!isRecord(properties)) {
    throw new ConnectorOptionsSchemaError(`${file}: options_schema.properties must be an object`);
  }

  const options: ResolvedConfigOption[] = [];
  for (const optionKey of Object.keys(properties).sort()) {
    const prop = properties[optionKey];
    if (!isRecord(prop)) {
      throw new ConnectorOptionsSchemaError(`${file}: options_schema.properties.${optionKey} must be an object`);
    }
    options.push(resolveOption(connectorKey, `${file}: options_schema.${optionKey}`, optionKey, prop));
  }

  return Object.freeze({
    connectorKey,
    description: typeof raw.description === "string" ? raw.description : "",
    options: Object.freeze(options),
  });
}

/**
 * Every shipped connector's resolved config form, keyed by connector_key.
 * Connectors declaring no `options_schema` are absent. Re-derived per call
 * (manifests are small, this is not a hot path) so a test pointing
 * `PDPP_POLYFILL_MANIFESTS_DIR` at a scratch directory sees it immediately.
 */
export function connectorOptionsSchemas(): Readonly<Record<string, ResolvedConnectorOptionsSchema>> {
  const out: Record<string, ResolvedConnectorOptionsSchema> = {};
  for (const { file, manifest } of readPolyfillManifests()) {
    const resolved = resolveOptionsSchemaFromManifest(manifest, file);
    if (resolved) {
      out[resolved.connectorKey] = resolved;
    }
  }
  return Object.freeze(out);
}

/** One connector's resolved config form, or `null` when it declares no options. */
export function connectorOptionsSchema(connectorKey: string | null): ResolvedConnectorOptionsSchema | null {
  if (!connectorKey) {
    return null;
  }
  return connectorOptionsSchemas()[connectorKey] ?? null;
}
