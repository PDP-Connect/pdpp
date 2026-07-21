/**
 * Pure connector-manifest structural + capability validation (RFC-manifest schema).
 *
 * Invariant: a manifest is structurally valid + capability-consistent iff
 * validateConnectorManifest does not throw — validated deterministically from
 * the manifest JSON alone, zero external state, no grant/token/consent/security
 * logic.
 */

import { canonicalConnectorKey, isConnectorKey } from "./connector-key.js";

// Inline copy — isNonEmptyString is used 30+ times in auth.js so moving it
// would create a back-edge import; a verbatim 1-liner copy is the cleanest
// solution for a trivial pure predicate.
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Schema-predicate helpers
// ---------------------------------------------------------------------------

export function isTopLevelSearchableStringField(fieldSchema: unknown): boolean {
  const schema = fieldSchema as Record<string, unknown> | null | undefined;
  const type = schema?.type;
  if (type === "string") {
    return true;
  }
  if (!(Array.isArray(type) && type.includes("string"))) {
    return false;
  }
  return (type as unknown[]).every((entry) => entry === "string" || entry === "null");
}

/**
 * Mirror of the records-path cursor-field compatibility check. Kept small and
 * colocated with the validator so authoring mistakes are caught at registration
 * rather than at first read. Must stay in sync with
 * reference-implementation/server/records.js::classifyCursorFieldSqlSupport.
 */
// Normalize a manifest `primary_key` declaration (array, single string, or
// absent/invalid) to a list; a non-array non-string collapses to an empty list
// so downstream validation rejects it.
function normalizePrimaryKeyDeclaration(rawPrimaryKey: unknown): unknown[] {
  if (Array.isArray(rawPrimaryKey)) {
    return rawPrimaryKey;
  }
  return isNonEmptyString(rawPrimaryKey) ? [rawPrimaryKey] : [];
}

// Normalize a JSON-schema `type` (array, scalar, or absent) to a list.
function toTypeList(rawType: unknown): unknown[] {
  if (Array.isArray(rawType)) {
    return rawType;
  }
  return rawType == null ? [] : [rawType];
}

export function isReferenceCompatibleCursorSchema(fieldSchema: unknown): boolean {
  if (!fieldSchema || typeof fieldSchema !== "object") {
    return false;
  }
  const schema = fieldSchema as Record<string, unknown>;
  const nonNull = toTypeList(schema.type).filter((t) => t !== "null");
  if (nonNull.length !== 1) {
    return false;
  }
  const only = nonNull[0];
  if (only === "integer" || only === "number") {
    return true;
  }
  if (only === "string") {
    return schema.format === "date" || schema.format === "date-time";
  }
  return false;
}

export function isRangeQueryableFieldSchema(fieldSchema: unknown): boolean {
  return isReferenceCompatibleCursorSchema(fieldSchema);
}

export function nonNullSchemaTypes(schema: unknown): unknown[] {
  const s = schema as Record<string, unknown> | null | undefined;
  return toTypeList(s?.type).filter((type) => type !== "null");
}

export function schemaTypeIncludes(fieldSchema: unknown, typeName: string): boolean {
  const schema = fieldSchema as Record<string, unknown> | null | undefined;
  const rawType = schema?.type;
  if (rawType === typeName) {
    return true;
  }
  return Array.isArray(rawType) && (rawType as unknown[]).includes(typeName);
}

export function validateBlobRefSchemaDeclaration(
  stream: Record<string, unknown>,
  fieldSchema: unknown,
  code: string
): void {
  if (!schemaTypeIncludes(fieldSchema, "object")) {
    throw invalidConnectorManifest(
      `Stream '${stream.name as string}' blob_ref must be an object or nullable object`,
      code
    );
  }
  const schema = fieldSchema as Record<string, unknown>;
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    throw invalidConnectorManifest(`Stream '${stream.name as string}' blob_ref must declare object properties`, code);
  }
  const props = properties as Record<string, Record<string, unknown>>;
  for (const [fieldName, expectedType] of Object.entries({
    blob_id: "string",
    mime_type: "string",
    size_bytes: "integer",
    sha256: "string",
  })) {
    if (!props[fieldName] || props[fieldName]?.type !== expectedType) {
      throw invalidConnectorManifest(
        `Stream '${stream.name as string}' blob_ref.${fieldName} must be type ${expectedType}`,
        code
      );
    }
  }
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
  if (!required.includes("blob_id")) {
    throw invalidConnectorManifest(`Stream '${stream.name as string}' blob_ref must require blob_id`, code);
  }
}

export function isNumericAggregateFieldSchema(fieldSchema: unknown): boolean {
  const nonNull = nonNullSchemaTypes(fieldSchema);
  return nonNull.length === 1 && (nonNull[0] === "integer" || nonNull[0] === "number");
}

export function isMinMaxAggregateFieldSchema(fieldSchema: unknown): boolean {
  return isReferenceCompatibleCursorSchema(fieldSchema);
}

export function isScalarAggregateGroupFieldSchema(fieldSchema: unknown): boolean {
  const nonNull = nonNullSchemaTypes(fieldSchema);
  if (nonNull.length !== 1) {
    return false;
  }
  return ["boolean", "integer", "number", "string"].includes(nonNull[0] as string);
}

// `group_by_time` buckets a date/date-time field with calendar `date_trunc`
// semantics, so the declared field must be a string with format date or
// date-time (nullable variant allowed). See:
//   openspec/changes/add-aggregate-time-buckets-and-distinct
export function isTimeBucketAggregateFieldSchema(fieldSchema: unknown): boolean {
  const nonNull = nonNullSchemaTypes(fieldSchema);
  if (nonNull.length !== 1 || nonNull[0] !== "string") {
    return false;
  }
  const schema = fieldSchema as Record<string, unknown> | null | undefined;
  return schema?.format === "date" || schema?.format === "date-time";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export function invalidConnectorManifest(message: string, code = "invalid_request"): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

export function isPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) > 0;
}

// Allowed values for the `capabilities.refresh_policy` declaration.
// Kept inline (rather than imported from a shared module) so the
// reference validator stays self-contained: this is reference/polyfill
// metadata, not normative PDPP core protocol, and the vocabulary
// SHOULD be promoted through a Collection Profile or companion spec
// before it is treated as portable across implementations. See
// `openspec/changes/add-connector-refresh-policy-controls/specs/polyfill-runtime/spec.md`.
export const REFRESH_POLICY_RECOMMENDED_MODES = new Set(["automatic", "manual", "paused"]);
export const REFRESH_POLICY_INTERACTION_POSTURES = new Set([
  "none",
  "credentials",
  "otp_likely",
  "manual_action_likely",
]);
export const REFRESH_POLICY_SENSITIVITY_LEVELS = new Set(["low", "medium", "high"]);
export const REFRESH_POLICY_ALLOWED_KEYS = new Set([
  "recommended_mode",
  "recommended_interval_seconds",
  "minimum_interval_seconds",
  "maximum_staleness_seconds",
  "assisted_after_owner_auth",
  "interaction_posture",
  "session_lifetime_seconds",
  "rate_limit_sensitivity",
  "bot_detection_sensitivity",
  "background_safe",
  "rationale",
]);
export const RUNTIME_REQUIREMENT_BINDINGS = new Set(["browser", "filesystem", "interactive", "network"]);
export const STREAM_AVAILABILITY_STATES = new Set(["supported", "unsupported_in_mode", "experimental", "deprecated"]);
export const STREAM_AVAILABILITY_ALLOWED_KEYS = new Set(["future_modes", "mode", "reason", "state"]);
export const STREAM_COVERAGE_POLICIES = new Set([
  "collect",
  "deferred",
  "inventory_only",
  "unavailable",
  "unsupported",
]);
export const STREAM_COVERAGE_STRATEGIES = new Set([
  "checkpoint_window",
  "full_inventory",
  "parent_detail_accounting",
  "snapshot_import_receipt",
  "singleton_presence",
]);
export const STREAM_FRESHNESS_STRATEGIES = new Set([
  "device_heartbeat",
  "manual_as_of",
  "not_trackable",
  "scheduled_window",
  "source_reported_as_of",
]);

export const MANIFEST_SENSITIVITY_LEVELS = new Set(["standard", "sensitive"]);
export const DEFAULT_MANIFEST_SENSITIVITY = "standard";

const SUPPORTED_RANGE_OPERATORS = new Set(["gte", "gt", "lte", "lt"]);

// ---------------------------------------------------------------------------
// Helper validators
// ---------------------------------------------------------------------------

const EXTERNAL_TOOL_ALLOWED_KEYS = new Set(["detect", "install_hint", "license", "min_version", "name", "purpose"]);
const EXTERNAL_TOOL_DETECT_ALLOWED_KEYS = new Set(["args", "executable", "exit_code"]);

// Validates `runtime_requirements.bindings` (order-preserving). Returns `false`
// when `bindings` is absent — the original validator returns from the whole
// function in that case, so the caller must NOT go on to external_tools (a
// runtime_requirements object without bindings is accepted verbatim). Returns
// `true` once bindings are present and fully validated.
function validateRuntimeBindings(req: Record<string, unknown>, code: string): boolean {
  const bindings = req.bindings;
  if (bindings === undefined || bindings === null) {
    return false;
  }
  if (typeof bindings !== "object" || Array.isArray(bindings)) {
    throw invalidConnectorManifest("runtime_requirements.bindings must be an object when declared", code);
  }
  const bindingsObj = bindings as Record<string, unknown>;
  const unknownBindings = Object.keys(bindingsObj).filter((binding) => !RUNTIME_REQUIREMENT_BINDINGS.has(binding));
  if (unknownBindings.length) {
    throw invalidConnectorManifest(
      `runtime_requirements.bindings has unsupported keys: ${unknownBindings.join(", ")}`,
      code
    );
  }
  for (const [binding, requirement] of Object.entries(bindingsObj)) {
    if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) {
      throw invalidConnectorManifest(`runtime_requirements.bindings.${binding} must be an object`, code);
    }
    const reqObj = requirement as Record<string, unknown>;
    if (reqObj.required !== undefined && typeof reqObj.required !== "boolean") {
      throw invalidConnectorManifest(`runtime_requirements.bindings.${binding}.required must be a boolean`, code);
    }
  }
  return true;
}

function validateExternalToolDetectExitCode(detect: Record<string, unknown>, index: number, code: string): void {
  if (detect.exit_code !== undefined && (!Number.isInteger(detect.exit_code) || (detect.exit_code as number) < 0)) {
    throw invalidConnectorManifest(
      `runtime_requirements.external_tools[${index}].detect.exit_code must be a non-negative integer`,
      code
    );
  }
}

function validateExternalToolDetectArgs(detect: Record<string, unknown>, index: number, code: string): void {
  if (
    detect.args !== undefined &&
    (!Array.isArray(detect.args) || (detect.args as unknown[]).some((arg) => typeof arg !== "string"))
  ) {
    throw invalidConnectorManifest(
      `runtime_requirements.external_tools[${index}].detect.args must be an array of strings`,
      code
    );
  }
}

function validateLegacyExternalToolDetect(detect: Record<string, unknown>, index: number, code: string): void {
  validateExternalToolDetectExitCode(detect, index, code);
  const legacyDetectKeys = new Set(["args", "command", "executable", "exit_code"]);
  const unknownLegacyKeys = Object.keys(detect).filter((key) => !legacyDetectKeys.has(key));
  if (unknownLegacyKeys.length) {
    throw invalidConnectorManifest(
      `runtime_requirements.external_tools[${index}].detect has unsupported keys: ${unknownLegacyKeys.join(", ")}`,
      code
    );
  }
  if (!(isNonEmptyString(detect.executable) || isNonEmptyString(detect.command))) {
    throw invalidConnectorManifest(
      `runtime_requirements.external_tools[${index}].detect.command must be a non-empty string`,
      code
    );
  }
}

function validateStrictExternalToolDetect(detect: Record<string, unknown>, index: number, code: string): void {
  const unknownDetectKeys = Object.keys(detect).filter((key) => !EXTERNAL_TOOL_DETECT_ALLOWED_KEYS.has(key));
  if (unknownDetectKeys.length) {
    throw invalidConnectorManifest(
      `runtime_requirements.external_tools[${index}].detect has unsupported keys: ${unknownDetectKeys.join(", ")}`,
      code
    );
  }
  if (!isNonEmptyString(detect.executable)) {
    throw invalidConnectorManifest(
      `runtime_requirements.external_tools[${index}].detect.executable must be a non-empty string`,
      code
    );
  }
  validateExternalToolDetectExitCode(detect, index, code);
}

function readExternalToolDetect(detectValue: unknown, index: number, code: string): Record<string, unknown> | null {
  if (detectValue === undefined) {
    return null;
  }
  if (!detectValue || typeof detectValue !== "object" || Array.isArray(detectValue)) {
    throw invalidConnectorManifest(`runtime_requirements.external_tools[${index}].detect must be an object`, code);
  }
  return detectValue as Record<string, unknown>;
}

// Validates one `external_tools[index].detect` sub-object (order-preserving).
function validateExternalToolDetect(
  detectValue: unknown,
  index: number,
  code: string,
  options: { allowLegacyCommand: boolean }
): void {
  const detect = readExternalToolDetect(detectValue, index, code);
  if (!detect) {
    return;
  }
  if (options.allowLegacyCommand) {
    validateLegacyExternalToolDetect(detect, index, code);
  } else {
    validateStrictExternalToolDetect(detect, index, code);
  }
  validateExternalToolDetectArgs(detect, index, code);
}

// Validates one `external_tools[index]` entry (order-preserving); tracks
// duplicate tool names via the shared `seenToolNames` set.
function validateExternalToolEntry(
  tool: unknown,
  index: number,
  seenToolNames: Set<string>,
  code: string,
  options: { allowLegacyCommand: boolean }
): void {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    throw invalidConnectorManifest(`runtime_requirements.external_tools[${index}] must be an object`, code);
  }
  const toolObj = tool as Record<string, unknown>;
  const unknownKeys = Object.keys(toolObj).filter((key) => !EXTERNAL_TOOL_ALLOWED_KEYS.has(key));
  if (unknownKeys.length) {
    throw invalidConnectorManifest(
      `runtime_requirements.external_tools[${index}] has unsupported keys: ${unknownKeys.join(", ")}`,
      code
    );
  }
  for (const fieldName of ["name", "license", "purpose"]) {
    if (!isNonEmptyString(toolObj[fieldName])) {
      throw invalidConnectorManifest(
        `runtime_requirements.external_tools[${index}].${fieldName} must be a non-empty string`,
        code
      );
    }
  }
  if (seenToolNames.has(toolObj.name as string)) {
    throw invalidConnectorManifest(
      `runtime_requirements.external_tools duplicates tool '${toolObj.name as string}'`,
      code
    );
  }
  seenToolNames.add(toolObj.name as string);
  for (const fieldName of ["install_hint", "min_version"]) {
    if (toolObj[fieldName] !== undefined && !isNonEmptyString(toolObj[fieldName])) {
      throw invalidConnectorManifest(
        `runtime_requirements.external_tools[${index}].${fieldName} must be a non-empty string`,
        code
      );
    }
  }
  validateExternalToolDetect(toolObj.detect, index, code, options);
}

// Validates `runtime_requirements.external_tools` (order-preserving).
function validateExternalTools(
  req: Record<string, unknown>,
  code: string,
  options: { allowLegacyCommand: boolean }
): void {
  const externalTools = req.external_tools;
  if (externalTools === undefined || externalTools === null) {
    return;
  }
  if (!Array.isArray(externalTools)) {
    throw invalidConnectorManifest("runtime_requirements.external_tools must be an array when declared", code);
  }
  const seenToolNames = new Set<string>();
  for (const [index, tool] of externalTools.entries()) {
    validateExternalToolEntry(tool, index, seenToolNames, code, options);
  }
}

// Decomposed into per-section validators (bindings, external_tools, tool detect).
// Full manifest validation keeps main's hardened `detect.executable` contract;
// runtime-requirements-only calls keep the branch's direct-helper compatibility
// for legacy unit coverage.
export function validateRuntimeRequirements(manifest: Record<string, unknown>, code: string): void {
  const requirements = manifest.runtime_requirements;
  if (requirements === undefined || requirements === null) {
    return;
  }
  if (typeof requirements !== "object" || Array.isArray(requirements)) {
    throw invalidConnectorManifest("runtime_requirements must be an object when declared", code);
  }
  const req = requirements as Record<string, unknown>;
  if (!validateRuntimeBindings(req, code)) {
    return;
  }
  validateExternalTools(req, code, { allowLegacyCommand: !Array.isArray(manifest.streams) });
}

// Validates the interval fields of a refresh_policy (positive-integer shape +
// the recommended>=minimum cross-check). Order-preserving; split out of
// validateRefreshPolicyFields to keep each helper's complexity within bounds.
function validateRefreshPolicyIntervals(pol: Record<string, unknown>, code: string): void {
  for (const intervalKey of [
    "recommended_interval_seconds",
    "minimum_interval_seconds",
    "maximum_staleness_seconds",
    "session_lifetime_seconds",
  ]) {
    if (pol[intervalKey] !== undefined && !isPositiveInteger(pol[intervalKey])) {
      throw invalidConnectorManifest(
        `capabilities.refresh_policy.${intervalKey} must be a positive integer when declared`,
        code
      );
    }
  }
  if (
    pol.recommended_interval_seconds !== undefined &&
    pol.minimum_interval_seconds !== undefined &&
    (pol.recommended_interval_seconds as number) < (pol.minimum_interval_seconds as number)
  ) {
    throw invalidConnectorManifest(
      "capabilities.refresh_policy.recommended_interval_seconds must be >= minimum_interval_seconds",
      code
    );
  }
}

// Validates the enum + boolean fields of a refresh_policy (interaction posture,
// sensitivity levels, background/assisted flags). Order-preserving; split out of
// validateRefreshPolicyFields to keep each helper's complexity within bounds.
function validateRefreshPolicyEnumsAndFlags(pol: Record<string, unknown>, code: string): void {
  if (
    pol.interaction_posture !== undefined &&
    !(isNonEmptyString(pol.interaction_posture) && REFRESH_POLICY_INTERACTION_POSTURES.has(pol.interaction_posture))
  ) {
    throw invalidConnectorManifest(
      "capabilities.refresh_policy.interaction_posture must be one of: none, credentials, otp_likely, manual_action_likely",
      code
    );
  }
  for (const sensitivityKey of ["rate_limit_sensitivity", "bot_detection_sensitivity"]) {
    if (
      pol[sensitivityKey] !== undefined &&
      !(isNonEmptyString(pol[sensitivityKey]) && REFRESH_POLICY_SENSITIVITY_LEVELS.has(pol[sensitivityKey] as string))
    ) {
      throw invalidConnectorManifest(
        `capabilities.refresh_policy.${sensitivityKey} must be one of: low, medium, high`,
        code
      );
    }
  }
  if (pol.background_safe !== undefined && typeof pol.background_safe !== "boolean") {
    throw invalidConnectorManifest("capabilities.refresh_policy.background_safe must be a boolean when declared", code);
  }
  if (pol.assisted_after_owner_auth !== undefined && typeof pol.assisted_after_owner_auth !== "boolean") {
    throw invalidConnectorManifest(
      "capabilities.refresh_policy.assisted_after_owner_auth must be a boolean when declared",
      code
    );
  }
}

// Validates the fields of a present `capabilities.refresh_policy` object
// (order-preserving). Split out of validateRefreshPolicyCapability so the
// latter only handles the capabilities/policy presence-and-type gate.
function validateRefreshPolicyFields(pol: Record<string, unknown>, code: string): void {
  const unknownKeys = Object.keys(pol).filter((key) => !REFRESH_POLICY_ALLOWED_KEYS.has(key));
  if (unknownKeys.length) {
    throw invalidConnectorManifest(`capabilities.refresh_policy has unsupported keys: ${unknownKeys.join(", ")}`, code);
  }
  if (!(isNonEmptyString(pol.recommended_mode) && REFRESH_POLICY_RECOMMENDED_MODES.has(pol.recommended_mode))) {
    throw invalidConnectorManifest(
      "capabilities.refresh_policy.recommended_mode must be one of: automatic, manual, paused",
      code
    );
  }
  if (!isNonEmptyString(pol.rationale)) {
    throw invalidConnectorManifest(
      "capabilities.refresh_policy.rationale must be a non-empty owner-readable string",
      code
    );
  }
  validateRefreshPolicyIntervals(pol, code);
  validateRefreshPolicyEnumsAndFlags(pol, code);
}

export function validateRefreshPolicyCapability(manifest: Record<string, unknown>, code: string): void {
  const capabilities = manifest.capabilities;
  if (capabilities === undefined || capabilities === null) {
    return;
  }
  if (typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw invalidConnectorManifest("capabilities must be an object when declared", code);
  }
  const caps = capabilities as Record<string, unknown>;
  const policy = caps.refresh_policy;
  if (policy === undefined) {
    return;
  }
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw invalidConnectorManifest("capabilities.refresh_policy must be an object when declared", code);
  }
  validateRefreshPolicyFields(policy as Record<string, unknown>, code);
}

export function validateManifestSensitivity(manifest: Record<string, unknown>, code: string): void {
  const sensitivity = manifest.sensitivity;
  if (sensitivity === undefined) {
    return;
  }
  if (!(isNonEmptyString(sensitivity) && MANIFEST_SENSITIVITY_LEVELS.has(sensitivity))) {
    throw invalidConnectorManifest('sensitivity must be "standard" or "sensitive" when declared', code);
  }
}

export function resolveManifestSensitivity(manifest: Record<string, unknown> = {}): string {
  return manifest.sensitivity === "sensitive" ? "sensitive" : DEFAULT_MANIFEST_SENSITIVITY;
}

// Validates a single query.expand entry (order-preserving) against its
// same-stream relationship and the related stream's schema. Split out of
// validateStreamExpandDeclarations so the latter only handles the expand
// presence/type gate, the relationships lookup, and duplicate tracking; the
// per-entry throw order and messages are identical to the inlined loop body.
// Validates the default_limit / max_limit declarations for one expand entry
// (order-preserving). Split out of validateExpandCapability; messages and throw
// order match the inlined block.
function validateExpandCapabilityLimits({
  cap,
  code,
  relationship,
  streamName,
}: {
  cap: Record<string, unknown> | null | undefined;
  code: string;
  relationship: Record<string, unknown>;
  streamName: string;
}): void {
  if (cap?.default_limit !== undefined && !isPositiveInteger(cap?.default_limit)) {
    throw invalidConnectorManifest(
      `Stream '${streamName}' query.expand entry '${cap?.name as string}' default_limit must be a positive integer`,
      code
    );
  }
  if (cap?.max_limit !== undefined && !isPositiveInteger(cap?.max_limit)) {
    throw invalidConnectorManifest(
      `Stream '${streamName}' query.expand entry '${cap?.name as string}' max_limit must be a positive integer`,
      code
    );
  }
  if (
    cap?.default_limit !== undefined &&
    cap?.max_limit !== undefined &&
    (cap?.default_limit as number) > (cap?.max_limit as number)
  ) {
    throw invalidConnectorManifest(
      `Stream '${streamName}' query.expand entry '${cap?.name as string}' default_limit must be less than or equal to max_limit`,
      code
    );
  }
  if (relationship.cardinality === "has_one" && (cap?.default_limit !== undefined || cap?.max_limit !== undefined)) {
    throw invalidConnectorManifest(
      `Stream '${streamName}' query.expand entry '${cap?.name as string}' must not declare limits for has_one relationships`,
      code
    );
  }
}

function validateExpandCapability({
  cap,
  code,
  manifestStreamsByName,
  relationships,
  schemaProperties,
  seen,
  streamName,
}: {
  cap: Record<string, unknown> | null | undefined;
  code: string;
  manifestStreamsByName: Map<string, Record<string, unknown>>;
  relationships: Map<string, Record<string, unknown>>;
  schemaProperties: Record<string, unknown>;
  seen: Set<string>;
  streamName: string;
}): void {
  if (!isNonEmptyString(cap?.name)) {
    throw invalidConnectorManifest(`Stream '${streamName}' query.expand entries must include a non-empty name`, code);
  }
  if (seen.has(cap?.name as string)) {
    throw invalidConnectorManifest(
      `Stream '${streamName}' query.expand has duplicate entry '${cap?.name as string}'`,
      code
    );
  }
  seen.add(cap?.name as string);

  const relationship = relationships.get(cap?.name as string);
  if (!relationship) {
    throw invalidConnectorManifest(
      `Stream '${streamName}' query.expand entry '${cap?.name as string}' must match a same-stream relationships[] entry`,
      code
    );
  }
  if (!isNonEmptyString(relationship.stream)) {
    throw invalidConnectorManifest(
      `Stream '${streamName}' relationship '${relationship.name as string}' must include a related stream`,
      code
    );
  }
  if (!isNonEmptyString(relationship.foreign_key)) {
    throw invalidConnectorManifest(
      `Stream '${streamName}' relationship '${relationship.name as string}' must include a foreign_key`,
      code
    );
  }
  if (!["has_one", "has_many"].includes(relationship.cardinality as string)) {
    throw invalidConnectorManifest(
      `Stream '${streamName}' relationship '${relationship.name as string}' must use cardinality has_one or has_many`,
      code
    );
  }

  const relatedStream = manifestStreamsByName.get(relationship.stream as string);
  if (!relatedStream) {
    throw invalidConnectorManifest(
      `Stream '${streamName}' query.expand entry '${cap?.name as string}' references unknown related stream '${relationship.stream as string}'`,
      code
    );
  }
  const relatedProperties = (relatedStream.schema as Record<string, unknown> | undefined)?.properties;
  if (!relatedProperties || typeof relatedProperties !== "object" || Array.isArray(relatedProperties)) {
    throw invalidConnectorManifest(
      `Stream '${streamName}' query.expand entry '${cap?.name as string}' related stream '${relationship.stream as string}' must include schema.properties`,
      code
    );
  }
  if (!Object.hasOwn(relatedProperties, relationship.foreign_key as string)) {
    throw invalidConnectorManifest(
      `Stream '${streamName}' query.expand entry '${cap?.name as string}' foreign_key '${relationship.foreign_key as string}' must be a top-level property on related stream '${relationship.stream as string}'`,
      code
    );
  }

  validateExpandCapabilityLimits({ cap, code, relationship, streamName });

  // The parent stream's schema was already validated above; this extra check
  // keeps the validator close to the runtime's parent-record-key join shape.
  if (!schemaProperties || typeof schemaProperties !== "object" || Array.isArray(schemaProperties)) {
    throw invalidConnectorManifest(`Stream '${streamName}' must include schema.properties`, code);
  }
}

export function validateStreamExpandDeclarations({
  code,
  manifestStreamsByName,
  schemaProperties,
  stream,
}: {
  code: string;
  manifestStreamsByName: Map<string, Record<string, unknown>>;
  schemaProperties: Record<string, unknown>;
  stream: Record<string, unknown>;
}): void {
  const query = stream.query as Record<string, unknown> | undefined;
  const declared = query?.expand;
  if (declared === undefined) {
    return;
  }
  if (!Array.isArray(declared) || declared.length === 0) {
    throw invalidConnectorManifest(`Stream '${stream.name as string}' query.expand must be a non-empty array`, code);
  }

  const relationships = new Map<string, Record<string, unknown>>();
  for (const relationship of (stream.relationships as unknown[] | undefined) || []) {
    const rel = relationship as Record<string, unknown> | null | undefined;
    if (!(rel && isNonEmptyString(rel.name))) {
      continue;
    }
    relationships.set(rel.name, rel);
  }

  const seen = new Set<string>();
  for (const capability of declared as unknown[]) {
    validateExpandCapability({
      cap: capability as Record<string, unknown> | null | undefined,
      code,
      manifestStreamsByName,
      relationships,
      schemaProperties,
      seen,
      streamName: stream.name as string,
    });
  }
}

export function validateStreamAvailabilityDeclaration(stream: Record<string, unknown>, code: string): void {
  const availability = stream.availability;
  if (availability === undefined || availability === null) {
    return;
  }
  if (typeof availability !== "object" || Array.isArray(availability)) {
    throw invalidConnectorManifest(`Stream '${stream.name as string}' availability must be an object`, code);
  }
  const avail = availability as Record<string, unknown>;
  const unknownKeys = Object.keys(avail).filter((key) => !STREAM_AVAILABILITY_ALLOWED_KEYS.has(key));
  if (unknownKeys.length) {
    throw invalidConnectorManifest(
      `Stream '${stream.name as string}' availability has unsupported keys: ${unknownKeys.join(", ")}`,
      code
    );
  }
  if (!(isNonEmptyString(avail.state) && STREAM_AVAILABILITY_STATES.has(avail.state))) {
    throw invalidConnectorManifest(
      `Stream '${stream.name as string}' availability.state must be one of: supported, unsupported_in_mode, experimental, deprecated`,
      code
    );
  }
  if (avail.state === "unsupported_in_mode" && !isNonEmptyString(avail.mode)) {
    throw invalidConnectorManifest(
      `Stream '${stream.name as string}' availability.mode must be a non-empty string when state is unsupported_in_mode`,
      code
    );
  }
  for (const fieldName of ["mode", "reason"]) {
    if (avail[fieldName] !== undefined && !isNonEmptyString(avail[fieldName])) {
      throw invalidConnectorManifest(
        `Stream '${stream.name as string}' availability.${fieldName} must be a non-empty string`,
        code
      );
    }
  }
  if (
    avail.future_modes !== undefined &&
    (!Array.isArray(avail.future_modes) ||
      (avail.future_modes as unknown[]).length === 0 ||
      (avail.future_modes as unknown[]).some((mode) => !isNonEmptyString(mode)))
  ) {
    throw invalidConnectorManifest(
      `Stream '${stream.name as string}' availability.future_modes must be a non-empty array of strings`,
      code
    );
  }
}

// `state_stream` declares the parent list stream whose committed checkpoint
// covers this co-emitted stream (e.g. Slack reactions -> messages). It is a
// checkpoint-parent declaration for `checkpoint_window` streams that ride a
// parent cursor and emit no DETAIL_COVERAGE; the runtime reads it to project the
// co-emitted stream's checkpoint from the parent's cursor. Split out of
// validateStreamEvidenceDeclarations to keep that validator under the
// cognitive-complexity ceiling; throw order and messages are unchanged.
function validateStreamStateStreamDeclaration(
  stream: Record<string, unknown>,
  code: string,
  declaredStreamNames?: Set<string>
): void {
  if (stream.state_stream === undefined) {
    return;
  }
  const streamName = stream.name as string;
  if (!isNonEmptyString(stream.state_stream)) {
    throw invalidConnectorManifest(`Stream '${streamName}' state_stream must be a non-empty string`, code);
  }
  if (stream.state_stream === streamName) {
    throw invalidConnectorManifest(
      `Stream '${streamName}' state_stream must name a different parent stream, not itself`,
      code
    );
  }
  if (declaredStreamNames && !declaredStreamNames.has(stream.state_stream as string)) {
    throw invalidConnectorManifest(
      `Stream '${streamName}' state_stream '${stream.state_stream as string}' must name another declared stream`,
      code
    );
  }
  if (stream.coverage_strategy !== "checkpoint_window") {
    throw invalidConnectorManifest(
      `Stream '${streamName}' declares state_stream, which is only valid with coverage_strategy "checkpoint_window" (got "${stream.coverage_strategy as string}")`,
      code
    );
  }
}

// Coverage policies that declare the manifest author's accepted-absence claim
// for a stream (anything other than the `collect` default). Mirrors
// packages/polyfill-connectors/src/coverage-policy-manifest-honesty.test.ts's
// `ACCEPTED_COVERAGE_POLICIES`.
const ACCEPTED_COVERAGE_POLICIES = new Set(["deferred", "inventory_only", "unavailable", "unsupported"]);

export function validateStreamEvidenceDeclarations(
  stream: Record<string, unknown>,
  code: string,
  declaredStreamNames?: Set<string>
): void {
  const streamName = stream.name as string;
  if (stream.coverage_policy !== undefined && !STREAM_COVERAGE_POLICIES.has(stream.coverage_policy as string)) {
    throw invalidConnectorManifest(
      `Stream '${streamName}' coverage_policy must be one of: collect, deferred, inventory_only, unavailable, unsupported`,
      code
    );
  }
  // A required stream (required !== false, the default) combined with an
  // accepted-absence coverage_policy is a contradictory manifest: the stream
  // is simultaneously load-bearing and accepted-absent. Mirrors
  // coverage-policy-manifest-honesty.test.ts's "accepted-coverage policy must
  // not combine with required: true" build-time check, so a scaffold cannot
  // register this contradiction merely by skipping that build-time test.
  // Unconditional and safe for legacy/third-party manifests: no manifest
  // authored before this check existed could have legitimately depended on
  // declaring a stream both load-bearing AND accepted-absent — that
  // combination was always a logical contradiction, not a valid historical
  // shape. This differs from a presence requirement (see "Design Notes:
  // rejected approaches" in
  // openspec/changes/harden-connector-green-default-boundary/proposal.md for
  // why unconditional coverage_strategy/freshness_strategy presence was
  // rejected as a write-time check: it broke registration for 80+ existing
  // minimal test/legacy manifests that never declared those fields).
  if (
    typeof stream.coverage_policy === "string" &&
    ACCEPTED_COVERAGE_POLICIES.has(stream.coverage_policy) &&
    stream.required !== false
  ) {
    throw invalidConnectorManifest(
      `Stream '${streamName}' coverage_policy "${stream.coverage_policy}" is contradictory with required: ${
        stream.required === undefined ? "absent (defaults true)" : String(stream.required)
      } — a stream cannot be both load-bearing and accepted-absent. Add "required": false or change coverage_policy to "collect".`,
      code
    );
  }
  if (stream.coverage_strategy !== undefined && !STREAM_COVERAGE_STRATEGIES.has(stream.coverage_strategy as string)) {
    throw invalidConnectorManifest(
      `Stream '${streamName}' coverage_strategy must be one of: checkpoint_window, full_inventory, parent_detail_accounting, snapshot_import_receipt, singleton_presence`,
      code
    );
  }
  if (
    stream.freshness_strategy !== undefined &&
    !STREAM_FRESHNESS_STRATEGIES.has(stream.freshness_strategy as string)
  ) {
    throw invalidConnectorManifest(
      `Stream '${streamName}' freshness_strategy must be one of: device_heartbeat, manual_as_of, not_trackable, scheduled_window, source_reported_as_of`,
      code
    );
  }
  validateStreamStateStreamDeclaration(stream, code, declaredStreamNames);
}

// ---------------------------------------------------------------------------
// Main validator
// ---------------------------------------------------------------------------

// Validates a single connector stream (order-preserving) against the manifest's
// stream map. Split out of validateConnectorManifest's per-stream loop so the
// top-level validator only handles connector-identity gates, sub-validator
// delegation, and iteration; the per-stream throw order and messages are
// identical to the inlined loop body. `seenStreamNames` is mutated across
// iterations for duplicate-name detection, so the caller owns and passes it in.
// Validates a stream's primary_key / cursor_field / consent_time_field / blob_ref
// declarations against its schema.properties (order-preserving). Split out of
// validateManifestStream; messages and throw order match the inlined block.
function validateStreamKeyFields({
  code,
  opts,
  schemaFieldNames,
  schemaProperties,
  streamObj,
}: {
  code: string;
  opts: { skipCursorFieldSortCheck?: boolean };
  schemaFieldNames: Set<string>;
  schemaProperties: Record<string, unknown>;
  streamObj: Record<string, unknown>;
}): void {
  const primaryKey = normalizePrimaryKeyDeclaration(streamObj.primary_key);
  if (!primaryKey.length || primaryKey.some((field) => !isNonEmptyString(field))) {
    throw invalidConnectorManifest(`Stream '${streamObj.name as string}' must include a non-empty primary_key`, code);
  }
  const unknownPrimaryKeyFields = primaryKey.filter((field) => !schemaFieldNames.has(field as string));
  if (unknownPrimaryKeyFields.length) {
    throw invalidConnectorManifest(
      `Stream '${streamObj.name as string}' primary_key fields must exist in schema.properties: ${unknownPrimaryKeyFields.join(", ")}`,
      code
    );
  }

  for (const fieldName of ["cursor_field", "consent_time_field"]) {
    if (streamObj[fieldName] != null && !schemaFieldNames.has(streamObj[fieldName] as string)) {
      throw invalidConnectorManifest(
        `Stream '${streamObj.name as string}' ${fieldName} must exist in schema.properties`,
        code
      );
    }
  }

  if (schemaProperties.blob_ref !== undefined) {
    validateBlobRefSchemaDeclaration(streamObj, schemaProperties.blob_ref, code);
  }

  // Reference guardrail: the SQL-backed records path only supports a narrow
  // set of `cursor_field` shapes (see
  // reference-implementation/server/records.js::classifyCursorFieldSqlSupport).
  // Reject incompatible declarations at registration time so the same bug
  // class (500s on /records for shipped manifests) cannot recur.
  //
  // Skipped on read (`skipCursorFieldSortCheck: true`): a DB that predates
  // this guardrail may still hold stale manifests; blocking reads on them
  // would defeat the whole point of the runtime JS-comparator fallback in
  // records.js. Registration-time paths always enforce the check.
  if (streamObj.cursor_field != null && !opts.skipCursorFieldSortCheck) {
    const cursorSchema = schemaProperties[streamObj.cursor_field as string];
    if (!isReferenceCompatibleCursorSchema(cursorSchema)) {
      const cs = cursorSchema as Record<string, unknown> | undefined;
      throw invalidConnectorManifest(
        `Stream '${streamObj.name as string}' cursor_field '${streamObj.cursor_field as string}' has an unsupported schema for the reference records path. ` +
          'Supported shapes: integer, number, string with format "date" or "date-time", or the nullable variants of those. ' +
          `Declared: type=${JSON.stringify(cs?.type)}${cs?.format ? ` format="${cs.format as string}"` : ""}.`,
        code
      );
    }
  }
}

// Validates a stream's `views[]` declarations (order-preserving). Split out of
// validateManifestStream; messages and throw order match the inlined block.
function validateStreamViews({
  code,
  schemaFieldNames,
  streamObj,
}: {
  code: string;
  schemaFieldNames: Set<string>;
  streamObj: Record<string, unknown>;
}): void {
  const seenViewIds = new Set<string>();
  for (const view of (streamObj.views as unknown[] | undefined) || []) {
    const v = view as Record<string, unknown> | null | undefined;
    if (!isNonEmptyString(v?.id)) {
      throw invalidConnectorManifest(`Stream '${streamObj.name as string}' views must include a non-empty id`, code);
    }
    const viewObj = view as Record<string, unknown>;
    if (seenViewIds.has(viewObj.id as string)) {
      throw invalidConnectorManifest(
        `Stream '${streamObj.name as string}' has duplicate view id '${viewObj.id as string}'`,
        code
      );
    }
    seenViewIds.add(viewObj.id as string);
    const viewFields = viewObj.fields as unknown[] | undefined;
    if (!(Array.isArray(viewFields) && viewFields.length) || viewFields.some((field) => !isNonEmptyString(field))) {
      throw invalidConnectorManifest(
        `Stream '${streamObj.name as string}' view '${viewObj.id as string}' must include a non-empty fields array`,
        code
      );
    }
    const unknownViewFields = viewFields.filter((field) => !schemaFieldNames.has(field as string));
    if (unknownViewFields.length) {
      throw invalidConnectorManifest(
        `Stream '${streamObj.name as string}' view '${viewObj.id as string}' references unknown fields: ${unknownViewFields.join(", ")}`,
        code
      );
    }
  }
}

// Validates one `query.search.<kind>_fields` array (lexical or semantic).
// Both kinds share identical v1 shape constraints; `kind` selects the label
// used in each message so the throw text matches the inlined block exactly.
function validateStreamSearchFieldSet({
  code,
  declared,
  kind,
  schemaFieldNames,
  schemaProperties,
  streamObj,
}: {
  code: string;
  declared: unknown;
  kind: "lexical" | "semantic";
  schemaFieldNames: Set<string>;
  schemaProperties: Record<string, unknown>;
  streamObj: Record<string, unknown>;
}): void {
  const label = `query.search.${kind}_fields`;
  if (!Array.isArray(declared) || (declared as unknown[]).length === 0) {
    throw invalidConnectorManifest(
      `Stream '${streamObj.name as string}' ${label} must be a non-empty array of strings`,
      code
    );
  }
  if ((declared as unknown[]).some((field) => !isNonEmptyString(field))) {
    throw invalidConnectorManifest(
      `Stream '${streamObj.name as string}' ${label} entries must be non-empty strings`,
      code
    );
  }
  for (const fieldName of declared as string[]) {
    if (!schemaFieldNames.has(fieldName)) {
      throw invalidConnectorManifest(
        `Stream '${streamObj.name as string}' ${label} references unknown field '${fieldName}'`,
        code
      );
    }
    const fieldSchema = schemaProperties[fieldName];
    if (!isTopLevelSearchableStringField(fieldSchema)) {
      throw invalidConnectorManifest(
        `Stream '${streamObj.name as string}' ${label} entry '${fieldName}' must be a top-level string or nullable-string field; v1 does not support nested paths, arrays, blobs, or non-string scalar types`,
        code
      );
    }
  }
}

// Validates a stream's `query.search` declaration (lexical + semantic fields).
// Split out of validateManifestStream; messages and throw order are identical.
function validateStreamSearchFields({
  code,
  schemaFieldNames,
  schemaProperties,
  streamObj,
  streamQuery,
}: {
  code: string;
  schemaFieldNames: Set<string>;
  schemaProperties: Record<string, unknown>;
  streamObj: Record<string, unknown>;
  streamQuery: Record<string, unknown> | undefined;
}): void {
  if (streamQuery?.search === undefined) {
    return;
  }
  const search = streamQuery.search as Record<string, unknown> | undefined;
  // query.search.lexical_fields — the public lexical-retrieval extension's
  // stream-level declaration. v1 accepts only top-level scalar text fields
  // declared in schema.properties: `type: "string"` and the common nullable
  // form `type: ["string", "null"]`. Nested paths, arrays, blobs, unknown
  // fields, and non-string scalar types are rejected. See:
  //   openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md
  if (search?.lexical_fields !== undefined) {
    validateStreamSearchFieldSet({
      code,
      declared: search.lexical_fields,
      kind: "lexical",
      schemaFieldNames,
      schemaProperties,
      streamObj,
    });
  }
  // query.search.semantic_fields — the public semantic-retrieval experimental
  // extension's stream-level declaration. Independent from lexical_fields:
  // either, both, or neither MAY be declared on a stream, and a field listed
  // in one is NOT automatically listed in the other. Same v1 shape constraints
  // as lexical_fields: top-level scalar text fields declared in schema.properties
  // (`type: "string"` or the common nullable form `type: ["string", "null"]`);
  // nested paths, arrays, blobs, non-string scalars, and unknown fields are
  // rejected. Records whose field value is actually null are skipped at index
  // time (see server/search-semantic.js::rebuildSemanticIndexForStream). See:
  //   openspec/changes/add-semantic-retrieval-experimental-extension/specs/semantic-retrieval/spec.md
  if (search?.semantic_fields !== undefined) {
    validateStreamSearchFieldSet({
      code,
      declared: search.semantic_fields,
      kind: "semantic",
      schemaFieldNames,
      schemaProperties,
      streamObj,
    });
  }
}

// Validates a stream's `query.range_filters` declaration (order-preserving).
// Split out of validateManifestStream; messages and throw order are identical.
function validateStreamRangeFilters({
  code,
  schemaFieldNames,
  schemaProperties,
  streamObj,
  streamQuery,
}: {
  code: string;
  schemaFieldNames: Set<string>;
  schemaProperties: Record<string, unknown>;
  streamObj: Record<string, unknown>;
  streamQuery: Record<string, unknown> | undefined;
}): void {
  if (streamQuery?.range_filters === undefined) {
    return;
  }
  const declared = streamQuery.range_filters;
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) {
    throw invalidConnectorManifest(
      `Stream '${streamObj.name as string}' query.range_filters must be an object keyed by field name`,
      code
    );
  }
  const rangeFilters = declared as Record<string, unknown>;
  for (const [fieldName, operators] of Object.entries(rangeFilters)) {
    if (!schemaFieldNames.has(fieldName)) {
      throw invalidConnectorManifest(
        `Stream '${streamObj.name as string}' query.range_filters references unknown field '${fieldName}'`,
        code
      );
    }
    if (
      !Array.isArray(operators) ||
      (operators as unknown[]).length === 0 ||
      (operators as unknown[]).some((operator) => !SUPPORTED_RANGE_OPERATORS.has(operator as string))
    ) {
      throw invalidConnectorManifest(
        `Stream '${streamObj.name as string}' query.range_filters entry '${fieldName}' must use supported operators: gte, gt, lte, lt`,
        code
      );
    }
    const fieldSchema = schemaProperties[fieldName];
    if (!isRangeQueryableFieldSchema(fieldSchema)) {
      throw invalidConnectorManifest(
        `Stream '${streamObj.name as string}' query.range_filters entry '${fieldName}' must be an integer, number, date, date-time, or nullable variant`,
        code
      );
    }
  }
}

// Validates the field-schema constraint for one aggregation entry, keyed by
// aggregation `key`. Split out of validateStreamAggregations; each message and
// the key→check mapping match the inlined block exactly.
function validateAggregationFieldSchema({
  code,
  fieldName,
  fieldSchema,
  key,
  streamObj,
}: {
  code: string;
  fieldName: string;
  fieldSchema: unknown;
  key: string;
  streamObj: Record<string, unknown>;
}): void {
  if (key === "sum" && !isNumericAggregateFieldSchema(fieldSchema)) {
    throw invalidConnectorManifest(
      `Stream '${streamObj.name as string}' query.aggregations.sum entry '${fieldName}' must be an integer, number, or nullable variant`,
      code
    );
  }
  if ((key === "min" || key === "max") && !isMinMaxAggregateFieldSchema(fieldSchema)) {
    throw invalidConnectorManifest(
      `Stream '${streamObj.name as string}' query.aggregations.${key} entry '${fieldName}' must be an integer, number, date, date-time, or nullable variant`,
      code
    );
  }
  if (key === "group_by" && !isScalarAggregateGroupFieldSchema(fieldSchema)) {
    throw invalidConnectorManifest(
      `Stream '${streamObj.name as string}' query.aggregations.group_by entry '${fieldName}' must be a top-level scalar field; arrays, objects, blobs, and ambiguous types are not supported`,
      code
    );
  }
  if (key === "group_by_time" && !isTimeBucketAggregateFieldSchema(fieldSchema)) {
    throw invalidConnectorManifest(
      `Stream '${streamObj.name as string}' query.aggregations.group_by_time entry '${fieldName}' must be a string field with format date or date-time, or the nullable variant`,
      code
    );
  }
  if (key === "count_distinct" && !isScalarAggregateGroupFieldSchema(fieldSchema)) {
    throw invalidConnectorManifest(
      `Stream '${streamObj.name as string}' query.aggregations.count_distinct entry '${fieldName}' must be a top-level scalar field; arrays, objects, blobs, and ambiguous types are not supported`,
      code
    );
  }
}

// Validates one keyed aggregation field-list (`sum`/`min`/`max`/`group_by`/
// `group_by_time`/`count_distinct`). Split out of validateStreamAggregations;
// messages and throw order are identical.
function validateAggregationFieldList({
  code,
  fields,
  key,
  schemaFieldNames,
  schemaProperties,
  streamObj,
}: {
  code: string;
  fields: unknown;
  key: string;
  schemaFieldNames: Set<string>;
  schemaProperties: Record<string, unknown>;
  streamObj: Record<string, unknown>;
}): void {
  if (
    !Array.isArray(fields) ||
    (fields as unknown[]).length === 0 ||
    (fields as unknown[]).some((field) => !isNonEmptyString(field))
  ) {
    throw invalidConnectorManifest(
      `Stream '${streamObj.name as string}' query.aggregations.${key} must be a non-empty array of field names`,
      code
    );
  }
  const seenFields = new Set<string>();
  for (const fieldName of fields as string[]) {
    if (seenFields.has(fieldName)) {
      throw invalidConnectorManifest(
        `Stream '${streamObj.name as string}' query.aggregations.${key} duplicates field '${fieldName}'`,
        code
      );
    }
    seenFields.add(fieldName);
    if (!schemaFieldNames.has(fieldName)) {
      throw invalidConnectorManifest(
        `Stream '${streamObj.name as string}' query.aggregations.${key} references unknown field '${fieldName}'`,
        code
      );
    }
    validateAggregationFieldSchema({ code, fieldName, fieldSchema: schemaProperties[fieldName], key, streamObj });
  }
}

// Validates a stream's `query.aggregations` declaration (order-preserving).
// Split out of validateManifestStream; messages and throw order are identical.
function validateStreamAggregations({
  code,
  schemaFieldNames,
  schemaProperties,
  streamObj,
  streamQuery,
}: {
  code: string;
  schemaFieldNames: Set<string>;
  schemaProperties: Record<string, unknown>;
  streamObj: Record<string, unknown>;
  streamQuery: Record<string, unknown> | undefined;
}): void {
  if (streamQuery?.aggregations === undefined) {
    return;
  }
  const declared = streamQuery.aggregations;
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) {
    throw invalidConnectorManifest(`Stream '${streamObj.name as string}' query.aggregations must be an object`, code);
  }
  const aggs = declared as Record<string, unknown>;
  const allowedKeys = new Set(["count", "sum", "min", "max", "group_by", "group_by_time", "count_distinct"]);
  const unknownKeys = Object.keys(aggs).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) {
    throw invalidConnectorManifest(
      `Stream '${streamObj.name as string}' query.aggregations has unsupported keys: ${unknownKeys.join(", ")}`,
      code
    );
  }
  if (aggs.count !== undefined && aggs.count !== true) {
    throw invalidConnectorManifest(
      `Stream '${streamObj.name as string}' query.aggregations.count must be true when declared`,
      code
    );
  }
  for (const key of ["sum", "min", "max", "group_by", "group_by_time", "count_distinct"]) {
    const fields = aggs[key];
    if (fields === undefined) {
      continue;
    }
    validateAggregationFieldList({ code, fields, key, schemaFieldNames, schemaProperties, streamObj });
  }
}

function validateManifestStream({
  code,
  manifestStreamsByName,
  opts,
  seenStreamNames,
  stream,
}: {
  code: string;
  manifestStreamsByName: Map<string, Record<string, unknown>>;
  opts: { skipCursorFieldSortCheck?: boolean };
  seenStreamNames: Set<string>;
  stream: unknown;
}): void {
  const s = stream as Record<string, unknown> | null | undefined;
  if (!isNonEmptyString(s?.name)) {
    throw invalidConnectorManifest("Each connector stream must include a non-empty name", code);
  }
  const streamObj = stream as Record<string, unknown>;
  if (seenStreamNames.has(streamObj.name as string)) {
    throw invalidConnectorManifest(`Duplicate stream name: ${streamObj.name as string}`, code);
  }
  seenStreamNames.add(streamObj.name as string);
  validateStreamAvailabilityDeclaration(streamObj, code);
  validateStreamEvidenceDeclarations(streamObj, code, new Set(manifestStreamsByName.keys()));

  const schema = streamObj.schema as Record<string, unknown> | undefined;
  const schemaProperties = schema?.properties as Record<string, unknown> | undefined;
  if (!schemaProperties || typeof schemaProperties !== "object" || Array.isArray(schemaProperties)) {
    throw invalidConnectorManifest(`Stream '${streamObj.name as string}' must include schema.properties`, code);
  }
  const schemaFieldNames = new Set(Object.keys(schemaProperties));

  validateStreamKeyFields({ code, opts, schemaFieldNames, schemaProperties, streamObj });
  validateStreamViews({ code, schemaFieldNames, streamObj });

  const streamQuery = streamObj.query as Record<string, unknown> | undefined;
  validateStreamSearchFields({ code, schemaFieldNames, schemaProperties, streamObj, streamQuery });
  validateStreamRangeFilters({ code, schemaFieldNames, schemaProperties, streamObj, streamQuery });
  validateStreamAggregations({ code, schemaFieldNames, schemaProperties, streamObj, streamQuery });

  validateStreamExpandDeclarations({
    code,
    manifestStreamsByName,
    schemaProperties,
    stream: streamObj,
  });
}

export function validateConnectorManifest(
  manifest: Record<string, unknown> = {},
  code = "invalid_request",
  opts: { skipCursorFieldSortCheck?: boolean } = {}
): void {
  const hasConnectorId = isNonEmptyString(manifest.connector_id);
  const hasConnectorKey = isNonEmptyString(manifest.connector_key);
  if (!(hasConnectorId || hasConnectorKey)) {
    throw invalidConnectorManifest("connector_key or connector_id is required", code);
  }
  if (hasConnectorKey && !isConnectorKey(manifest.connector_key)) {
    throw invalidConnectorManifest("connector_key must be a non-empty slug-like key, not a URL", code);
  }
  if (hasConnectorId && hasConnectorKey) {
    const connectorId = (manifest.connector_id as string).trim();
    const connectorKey = (manifest.connector_key as string).trim();
    const canonicalFromConnectorId = canonicalConnectorKey(manifest.connector_id);
    if (canonicalFromConnectorId && canonicalFromConnectorId !== connectorKey) {
      throw invalidConnectorManifest("connector_key must match the canonical key for connector_id", code);
    }
    if (!canonicalFromConnectorId && connectorId !== connectorKey) {
      throw invalidConnectorManifest(
        "connector_id must match connector_key; use manifest_uri for registry or document provenance",
        code
      );
    }
  }
  if (isNonEmptyString(manifest.provider_id)) {
    throw invalidConnectorManifest(
      "Connector registry only accepts connector manifests; provider_id is not allowed",
      code
    );
  }
  if (manifest.storage_binding !== undefined) {
    throw invalidConnectorManifest(
      "Connector registry only accepts connector manifests; storage_binding is not allowed",
      code
    );
  }
  if (!Array.isArray(manifest.streams) || (manifest.streams as unknown[]).length === 0) {
    throw invalidConnectorManifest("Connector manifests must include a non-empty streams array", code);
  }

  validateRuntimeRequirements(manifest, code);
  validateRefreshPolicyCapability(manifest, code);
  validateManifestSensitivity(manifest, code);

  const streams = manifest.streams as unknown[];
  const manifestStreamsByName = new Map<string, Record<string, unknown>>(
    streams
      .filter((stream) => isNonEmptyString((stream as Record<string, unknown> | null | undefined)?.name))
      .map((stream) => {
        const s = stream as Record<string, unknown>;
        return [s.name as string, s];
      })
  );
  const seenStreamNames = new Set<string>();
  for (const stream of streams) {
    validateManifestStream({ code, manifestStreamsByName, opts, seenStreamNames, stream });
  }
}
