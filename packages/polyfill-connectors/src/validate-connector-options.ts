/**
 * Pre-spawn options validation against a manifest-declared `options_schema`.
 *
 * Decision: reference/polyfill authoring metadata only (R.1). Credentials
 * SHALL NOT appear in `connector_options`; the no-overlap invariant is
 * enforced at build-time by `connector-config-schema-honesty.test.ts` (R.2).
 *
 * See openspec/changes/promote-connector-config-schema/specs/polyfill-runtime/spec.md
 */

export interface OptionsSchemaProperty {
  default?: unknown;
  description?: string;
  items?: { type?: string };
  type?: string | string[];
  [extra: string]: unknown;
}

export interface OptionsSchema {
  properties?: Record<string, OptionsSchemaProperty>;
  type?: string;
  [extra: string]: unknown;
}

export interface ManifestWithConfigSchemas {
  credentials_schema?: OptionsSchema;
  options_schema?: OptionsSchema;
}

export type OptionsValidationResult = { ok: true } | { issues: Array<{ field: string; reason: string }>; ok: false };

/**
 * Shape-validate `connector_options` against a manifest `options_schema`.
 *
 * - When no `options_schema` is declared, always returns `{ ok: true }`.
 * - Validates presence, type, and array-item type for each property.
 * - Unknown properties pass (the schema is informational/additive, not a
 *   whitelist; connectors ignore unknown env-var options already).
 */
export function validateConnectorOptions(
  manifest: ManifestWithConfigSchemas,
  connectorOptions: Record<string, unknown> | null | undefined
): OptionsValidationResult {
  const schema = manifest.options_schema;
  if (!schema) {
    return { ok: true };
  }
  const options = connectorOptions ?? {};
  const properties = schema.properties ?? {};
  const issues: Array<{ field: string; reason: string }> = [];

  for (const [field, prop] of Object.entries(properties)) {
    if (!Object.hasOwn(options, field)) {
      continue;
    }
    const value = options[field];
    const expectedType = prop.type;
    if (!expectedType) {
      continue;
    }
    const types = Array.isArray(expectedType) ? expectedType : [expectedType];
    if (!typeMatches(value, types, prop)) {
      issues.push({
        field,
        reason: `expected type ${expectedTypeLabel(types, prop)} but got ${valueTypeName(value)}`,
      });
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

function scalarTypeMatches(value: unknown, t: string): boolean {
  if (t === "null") {
    return value === null;
  }
  if (t === "string") {
    return typeof value === "string";
  }
  if (t === "number") {
    return typeof value === "number";
  }
  if (t === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  if (t === "boolean") {
    return typeof value === "boolean";
  }
  if (t === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  return false;
}

function arrayItemsMatch(value: unknown[], itemType: string): boolean {
  return value.every((item) => scalarTypeMatches(item, itemType));
}

function typeMatches(value: unknown, types: string[], prop: OptionsSchemaProperty): boolean {
  for (const t of types) {
    if (t === "array" && Array.isArray(value)) {
      const itemType = prop.items?.type;
      return !itemType || arrayItemsMatch(value as unknown[], itemType);
    }
    if (scalarTypeMatches(value, t)) {
      return true;
    }
  }
  return false;
}

function expectedTypeLabel(types: string[], prop: OptionsSchemaProperty): string {
  return types.map((t) => (t === "array" && prop.items?.type ? `array<${prop.items.type}>` : t)).join("|");
}

function valueTypeName(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}
