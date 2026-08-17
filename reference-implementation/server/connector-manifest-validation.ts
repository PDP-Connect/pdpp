// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure connector-manifest structural + capability validation (RFC-manifest schema).
 *
 * Invariant: a manifest is structurally valid + capability-consistent iff
 * validateConnectorManifest does not throw — validated deterministically from
 * the manifest JSON alone, zero external state, no grant/token/consent/security
 * logic.
 */

import {
  normalizeStaticSecretCredentialCapture,
  StaticSecretCredentialCaptureError,
  type StaticSecretCredentialCaptureLike,
} from "../../packages/polyfill-connectors/src/static-secret-credential-capture.ts";
import { canonicalConnectorKey, isConnectorKey } from "./connector-key.ts";
import { publicListingTierError } from "./public-listing-tier.ts";

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
  return rawType === null || rawType === undefined ? [] : [rawType];
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
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
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
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    throw invalidConnectorManifest(`Stream '${stream.name as string}' blob_ref must declare object properties`, code);
  }
  const props = properties as Record<string, Record<string, unknown>>;
  for (const [fieldName, expectedType] of Object.entries({
    blob_id: "string",
    mime_type: "string",
    sha256: "string",
    size_bytes: "integer",
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

/**
 * Registration-time gate for `setup.credential_capture`: a secret field
 * missing `label` or `env` aliases is a manifest contract violation (see
 * static-secret-credential-capture.ts's module doc), so it must fail here —
 * where every manifest is normalized before any request can observe it —
 * rather than surface later as a runtime 500 when setup or injection reads it.
 */
export function validateStaticSecretCredentialCapture(manifest: Record<string, unknown>, code: string): void {
  const connectorKey = String(manifest.connector_key ?? manifest.connector_id ?? "unknown");
  const setup = manifest.setup as { credential_capture?: StaticSecretCredentialCaptureLike | null } | null | undefined;
  try {
    normalizeStaticSecretCredentialCapture(connectorKey, setup?.credential_capture);
  } catch (err) {
    if (!(err instanceof StaticSecretCredentialCaptureError)) {
      throw err;
    }
    throw invalidConnectorManifest(err.message, code);
  }
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
export function validatePublicListingTier(manifest: Record<string, unknown>, code: string): void {
  const { capabilities } = manifest;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return;
  }
  const { public_listing: listing } = capabilities as Record<string, unknown>;
  if (listing === undefined || listing === null) {
    return;
  }
  const error = publicListingTierError(listing);
  if (error) {
    throw invalidConnectorManifest(error, code);
  }
}
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
  "max_cooldown_cycles",
  "max_recovery_attempts",
  "rationale",
]);

// Bounds for the two self-attested recovery/retry-budget fields
// (`max_cooldown_cycles`, `max_recovery_attempts`). These gate WHEN a stuck
// connection surfaces as `needs_attention` (§10-B) or a gap goes `terminal`
// (§10-A) — never WHETHER it eventually does (a connector can never opt out
// of escalation/terminalization by declaring an absurd budget). The range is
// centered on the RI-owned generic defaults (DEFAULT_COOLDOWN_PROFILE=12,
// DEFAULT_TERMINAL_GAP_PROFILE=5 in the respective runtime modules) with
// headroom for a legitimately slower-recovering provider, capped well short
// of "effectively never". This is the manifest-validation gate; the
// consuming modules additionally clamp to their own RI hard ceiling at the
// read site as defense in depth — a rejected-here value should never reach
// production code, but the read-site clamp holds even if it does.
export const REFRESH_POLICY_MAX_COOLDOWN_CYCLES_RANGE = { max: 24, min: 1 } as const;
export const REFRESH_POLICY_MAX_RECOVERY_ATTEMPTS_RANGE = { max: 20, min: 1 } as const;
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
const EXTERNAL_TOOL_DETECT_ALLOWED_KEYS = new Set(["args", "executable", "executable_env_override", "exit_code"]);

// Validates `runtime_requirements.bindings` (order-preserving). Returns `false`
// when `bindings` is absent — the original validator returns from the whole
// function in that case, so the caller must NOT go on to external_tools (a
// runtime_requirements object without bindings is accepted verbatim). Returns
// `true` once bindings are present and fully validated.
function validateRuntimeBindings(req: Record<string, unknown>, code: string): boolean {
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
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
  if (detect.executable_env_override !== undefined && !isNonEmptyString(detect.executable_env_override)) {
    throw invalidConnectorManifest(
      `runtime_requirements.external_tools[${index}].detect.executable_env_override must be a non-empty string`,
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

const LOCAL_PATH_ENTRY_ALLOWED_KEYS = new Set([
  "default_relative_to_home",
  "env_override",
  "label",
  "required_for_readiness",
]);

// Validates one `local_paths.paths[index]` entry (order-preserving).
function validateLocalPathEntry(entry: unknown, index: number, code: string): void {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw invalidConnectorManifest(`runtime_requirements.local_paths.paths[${index}] must be an object`, code);
  }
  const obj = entry as Record<string, unknown>;
  const unknownKeys = Object.keys(obj).filter((key) => !LOCAL_PATH_ENTRY_ALLOWED_KEYS.has(key));
  if (unknownKeys.length) {
    throw invalidConnectorManifest(
      `runtime_requirements.local_paths.paths[${index}] has unsupported keys: ${unknownKeys.join(", ")}`,
      code
    );
  }
  if (!isNonEmptyString(obj.default_relative_to_home)) {
    throw invalidConnectorManifest(
      `runtime_requirements.local_paths.paths[${index}].default_relative_to_home must be a non-empty string`,
      code
    );
  }
  if (!isNonEmptyString(obj.label)) {
    throw invalidConnectorManifest(
      `runtime_requirements.local_paths.paths[${index}].label must be a non-empty string`,
      code
    );
  }
  if (obj.env_override !== undefined && !isNonEmptyString(obj.env_override)) {
    throw invalidConnectorManifest(
      `runtime_requirements.local_paths.paths[${index}].env_override must be a non-empty string`,
      code
    );
  }
  if (obj.required_for_readiness !== undefined && typeof obj.required_for_readiness !== "boolean") {
    throw invalidConnectorManifest(
      `runtime_requirements.local_paths.paths[${index}].required_for_readiness must be a boolean`,
      code
    );
  }
}

const LOCAL_PATHS_ALLOWED_KEYS = new Set(["home_default_relative_to_user_home", "home_env_override", "paths"]);

// Validates `runtime_requirements.local_paths` (order-preserving).
function validateLocalPaths(req: Record<string, unknown>, code: string): void {
  const localPaths = req.local_paths;
  if (localPaths === undefined || localPaths === null) {
    return;
  }
  if (typeof localPaths !== "object" || Array.isArray(localPaths)) {
    throw invalidConnectorManifest("runtime_requirements.local_paths must be an object when declared", code);
  }
  const obj = localPaths as Record<string, unknown>;
  const unknownKeys = Object.keys(obj).filter((key) => !LOCAL_PATHS_ALLOWED_KEYS.has(key));
  if (unknownKeys.length) {
    throw invalidConnectorManifest(
      `runtime_requirements.local_paths has unsupported keys: ${unknownKeys.join(", ")}`,
      code
    );
  }
  if (!isNonEmptyString(obj.home_default_relative_to_user_home)) {
    throw invalidConnectorManifest(
      "runtime_requirements.local_paths.home_default_relative_to_user_home must be a non-empty string",
      code
    );
  }
  if (obj.home_env_override !== undefined && !isNonEmptyString(obj.home_env_override)) {
    throw invalidConnectorManifest(
      "runtime_requirements.local_paths.home_env_override must be a non-empty string",
      code
    );
  }
  if (!Array.isArray(obj.paths)) {
    throw invalidConnectorManifest("runtime_requirements.local_paths.paths must be an array", code);
  }
  for (const [index, entry] of obj.paths.entries()) {
    validateLocalPathEntry(entry, index, code);
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
  validateLocalPaths(req, code);
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

// Validates the two self-attested recovery/retry-budget fields
// (`max_cooldown_cycles`, `max_recovery_attempts`) against a bounded range —
// a connector MAY declare its own observed budget, but MUST NOT be able to
// self-attest an unbounded/extreme value that would let a stuck connection
// escape escalation (§10-B) or a dead resource escape terminalization
// (§10-A). Order-preserving; split out of validateRefreshPolicyFields to
// keep each helper's complexity within bounds.
function validateRefreshPolicyRecoveryBudgets(pol: Record<string, unknown>, code: string): void {
  if (pol.max_cooldown_cycles !== undefined) {
    const { max, min } = REFRESH_POLICY_MAX_COOLDOWN_CYCLES_RANGE;
    if (
      !isPositiveInteger(pol.max_cooldown_cycles) ||
      (pol.max_cooldown_cycles as number) < min ||
      (pol.max_cooldown_cycles as number) > max
    ) {
      throw invalidConnectorManifest(
        `capabilities.refresh_policy.max_cooldown_cycles must be an integer between ${min} and ${max} when declared`,
        code
      );
    }
  }
  if (pol.max_recovery_attempts !== undefined) {
    const { max, min } = REFRESH_POLICY_MAX_RECOVERY_ATTEMPTS_RANGE;
    if (
      !isPositiveInteger(pol.max_recovery_attempts) ||
      (pol.max_recovery_attempts as number) < min ||
      (pol.max_recovery_attempts as number) > max
    ) {
      throw invalidConnectorManifest(
        `capabilities.refresh_policy.max_recovery_attempts must be an integer between ${min} and ${max} when declared`,
        code
      );
    }
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
  validateRefreshPolicyRecoveryBudgets(pol, code);
}

export function validateRefreshPolicyCapability(manifest: Record<string, unknown>, code: string): void {
  validatePublicListingTier(manifest, code);
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
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

const PROVEN_ALLOWED_KEYS = new Set(["local_collector", "provider_auth_lifecycle", "static_secret_live"]);
const PROVEN_STATIC_SECRET_LIVE_ALLOWED_KEYS = new Set(["proven", "run_id", "date", "note"]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Validates a present `capabilities.proven.static_secret_live` object.
function validateProvenStaticSecretLive(value: Record<string, unknown>, code: string): void {
  const unknownKeys = Object.keys(value).filter((key) => !PROVEN_STATIC_SECRET_LIVE_ALLOWED_KEYS.has(key));
  if (unknownKeys.length) {
    throw invalidConnectorManifest(
      `capabilities.proven.static_secret_live has unsupported keys: ${unknownKeys.join(", ")}`,
      code
    );
  }
  if (typeof value.proven !== "boolean") {
    throw invalidConnectorManifest("capabilities.proven.static_secret_live.proven must be a boolean", code);
  }
  if (value.run_id !== undefined && value.run_id !== null && !isNonEmptyString(value.run_id)) {
    throw invalidConnectorManifest(
      "capabilities.proven.static_secret_live.run_id must be a non-empty string or null when declared",
      code
    );
  }
  if (value.date !== undefined && !(isNonEmptyString(value.date) && ISO_DATE_RE.test(value.date))) {
    throw invalidConnectorManifest(
      "capabilities.proven.static_secret_live.date must be an ISO yyyy-mm-dd string when declared",
      code
    );
  }
  if (value.note !== undefined && !isNonEmptyString(value.note)) {
    throw invalidConnectorManifest(
      "capabilities.proven.static_secret_live.note must be a non-empty string when declared",
      code
    );
  }
}

// Validates the field shapes of a present `capabilities.proven` object
// (order-preserving). Split out of validateProvenCapability so the latter
// only handles the capabilities/proven presence-and-type gate plus the
// cross-field proof-vs-modality consistency checks.
function validateProvenFields(provenObj: Record<string, unknown>, code: string): void {
  const unknownKeys = Object.keys(provenObj).filter((key) => !PROVEN_ALLOWED_KEYS.has(key));
  if (unknownKeys.length) {
    throw invalidConnectorManifest(`capabilities.proven has unsupported keys: ${unknownKeys.join(", ")}`, code);
  }
  if (provenObj.local_collector !== undefined && typeof provenObj.local_collector !== "boolean") {
    throw invalidConnectorManifest("capabilities.proven.local_collector must be a boolean when declared", code);
  }
  if (provenObj.provider_auth_lifecycle !== undefined && typeof provenObj.provider_auth_lifecycle !== "boolean") {
    throw invalidConnectorManifest("capabilities.proven.provider_auth_lifecycle must be a boolean when declared", code);
  }
  if (provenObj.static_secret_live === undefined) {
    return;
  }
  if (
    !provenObj.static_secret_live ||
    typeof provenObj.static_secret_live !== "object" ||
    Array.isArray(provenObj.static_secret_live)
  ) {
    throw invalidConnectorManifest("capabilities.proven.static_secret_live must be an object when declared", code);
  }
  validateProvenStaticSecretLive(provenObj.static_secret_live as Record<string, unknown>, code);
}

// Validates that a manifest claiming a proof also declares the setup
// modality / runtime binding that proof requires — a malformed manifest must
// not be able to claim a proof its own declared shape cannot support.
function validateProvenModalityConsistency(
  provenObj: Record<string, unknown>,
  manifest: Record<string, unknown>,
  code: string
): void {
  const setupModality = (manifest.setup as Record<string, unknown> | undefined)?.modality;
  if (
    provenObj.static_secret_live &&
    (provenObj.static_secret_live as Record<string, unknown>).proven === true &&
    setupModality !== "static_secret"
  ) {
    throw invalidConnectorManifest(
      'capabilities.proven.static_secret_live.proven=true requires setup.modality "static_secret"',
      code
    );
  }
  if (provenObj.provider_auth_lifecycle === true && setupModality !== "provider_authorization") {
    throw invalidConnectorManifest(
      'capabilities.proven.provider_auth_lifecycle=true requires setup.modality "provider_authorization"',
      code
    );
  }
  if (provenObj.local_collector !== true) {
    return;
  }
  const bindings = (manifest.runtime_requirements as Record<string, unknown> | undefined)?.bindings;
  const hasFilesystemBinding = Boolean(
    bindings && typeof bindings === "object" && Object.hasOwn(bindings, "filesystem")
  );
  if (!hasFilesystemBinding) {
    throw invalidConnectorManifest(
      "capabilities.proven.local_collector=true requires runtime_requirements.bindings.filesystem",
      code
    );
  }
}

/**
 * Validates a present `capabilities.proven` declaration — the schema for the
 * proof-gate traits `connection-setup-plan.ts` reads instead of hardcoding a
 * connector-id allowlist (`capabilities.proven.local_collector`,
 * `capabilities.proven.provider_auth_lifecycle`,
 * `capabilities.proven.static_secret_live.proven`). A manifest claiming a
 * proof its own `setup.modality` cannot support is rejected here rather than
 * only being caught by a test, so the invariant holds for any manifest
 * submitted through this validator, not just the shipped set.
 */
export function validateProvenCapability(manifest: Record<string, unknown>, code: string): void {
  const { capabilities } = manifest;
  if (capabilities === undefined || capabilities === null || typeof capabilities !== "object") {
    return;
  }
  const { proven } = capabilities as Record<string, unknown>;
  if (proven === undefined) {
    return;
  }
  if (!proven || typeof proven !== "object" || Array.isArray(proven)) {
    throw invalidConnectorManifest("capabilities.proven must be an object when declared", code);
  }
  const provenObj = proven as Record<string, unknown>;
  validateProvenFields(provenObj, code);
  validateProvenModalityConsistency(provenObj, manifest, code);
}

export function validateManifestSensitivity(manifest: Record<string, unknown>, code: string): void {
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const sensitivity = manifest.sensitivity;
  if (sensitivity === undefined) {
    return;
  }
  if (!(isNonEmptyString(sensitivity) && MANIFEST_SENSITIVITY_LEVELS.has(sensitivity))) {
    throw invalidConnectorManifest('sensitivity must be "standard" or "sensitive" when declared', code);
  }
}

// ---------------------------------------------------------------------------
// Manifest icon (optional brand glyph — see packages/pdpp-brand-react/src/connector-icon.tsx)
// ---------------------------------------------------------------------------

const MANIFEST_ICON_ALLOWED_KEYS = new Set(["kind", "svg", "color"]);
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// A brand glyph is shapes, not behavior: this is the complete element and
// attribute vocabulary an icon needs. Everything else — script, foreignObject,
// iframe, use, image, animate/animateTransform/set, style, a, and every
// href/xlink:href variant — is deliberately absent. There is no fetch, no
// script execution, and no navigation surface reachable from an SVG built
// only from this vocabulary.
const SVG_ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "rect",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "title",
  "defs",
]);
const SVG_ALLOWED_ATTRIBUTES = new Set([
  "viewbox",
  "xmlns",
  "width",
  "height",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "points",
  "opacity",
  "fill-rule",
  "clip-rule",
  "transform",
]);
// Any of these substrings inside an attribute value is grounds for outright
// rejection regardless of which attribute carries it — a shape-only icon has
// no legitimate use for a URL scheme or a CSS url() reference.
const SVG_ATTRIBUTE_VALUE_DENY_RE = /javascript:|data:|url\(/i;
const SVG_MAX_LENGTH = 10_000;

// Tokenizes top-level XML/SVG markup into tags and the text between them.
// Deliberately dumb: this only needs to walk `<tag ...>`, `<tag ... />`, and
// `</tag>` shapes far enough to hand each one to the allowlist checks below —
// it is not a general XML parser and does not need to be, since anything it
// cannot make sense of is rejected rather than passed through.
const SVG_TAG_RE = /<([^>]*)>/g;
// A single `name="value"` or `name='value'` pair inside a tag's attribute list.
const SVG_ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
// The element/tag name at the start of a tag body (after any leading `/`).
const SVG_TAG_NAME_RE = /^([a-zA-Z_:][-a-zA-Z0-9_:.]*)/;

interface ParsedSvgTag {
  attrs: Map<string, string>;
  attrsExhaustive: boolean;
  closing: boolean;
  name: string;
  selfClosing: boolean;
}

function parseSvgTag(raw: string): ParsedSvgTag | null {
  let body = raw.trim();
  const closing = body.startsWith("/");
  if (closing) {
    body = body.slice(1).trim();
  }
  const selfClosing = body.endsWith("/");
  if (selfClosing) {
    body = body.slice(0, -1).trim();
  }
  const nameMatch = SVG_TAG_NAME_RE.exec(body);
  const rawName = nameMatch?.[1];
  if (!rawName) {
    return null;
  }
  const name = rawName.toLowerCase();
  const attrSource = body.slice(rawName.length);
  const attrs = new Map<string, string>();
  SVG_ATTR_RE.lastIndex = 0;
  let match = SVG_ATTR_RE.exec(attrSource);
  while (match) {
    const [, rawAttrName, doubleQuoted, singleQuoted] = match;
    if (rawAttrName) {
      attrs.set(rawAttrName.toLowerCase(), doubleQuoted ?? singleQuoted ?? "");
    }
    match = SVG_ATTR_RE.exec(attrSource);
  }
  // Anything left over after stripping every recognized `name="value"` pair
  // means the attribute list contains something the tokenizer could not
  // classify (an unmatched `<`/`>`, a stray quote, an unquoted value) — that
  // markup is rejected rather than silently dropped.
  const attrsExhaustive = attrSource.replace(SVG_ATTR_RE, "").trim().length === 0;
  return { attrs, attrsExhaustive, closing, name, selfClosing };
}

// Validates one already-tokenized tag against the element/attribute
// allowlist (order-preserving). Split out of assertSvgIsAllowlisted so the
// latter only handles tokenizing the markup and tracking the bare-<svg>-root
// invariant; this handles the per-tag allowlist gate.
function assertTagIsAllowlisted(parsed: ParsedSvgTag, code: string): void {
  if (!parsed.attrsExhaustive) {
    throw invalidConnectorManifest("icon.svg contains malformed markup", code);
  }
  if (!SVG_ALLOWED_ELEMENTS.has(parsed.name)) {
    throw invalidConnectorManifest(`icon.svg contains a disallowed element: ${parsed.name}`, code);
  }
  for (const [attrName, attrValue] of parsed.attrs) {
    if (!SVG_ALLOWED_ATTRIBUTES.has(attrName)) {
      throw invalidConnectorManifest(`icon.svg contains a disallowed attribute: ${attrName}`, code);
    }
    if (SVG_ATTRIBUTE_VALUE_DENY_RE.test(attrValue)) {
      throw invalidConnectorManifest(`icon.svg attribute ${attrName} contains a disallowed value`, code);
    }
  }
}

/**
 * Validates that `svg` uses only the shape-only element/attribute vocabulary
 * declared above. This is the SOLE XSS defense for manifest-declared icons —
 * `icon.svg` reaches the DOM via dangerouslySetInnerHTML in
 * packages/pdpp-brand-react/src/connector-icon.tsx, and this function is the
 * single choke point that markup must pass through first. It is a strict
 * ALLOWLIST (reject anything not explicitly permitted), not a denylist —
 * nothing here enumerates attack vectors, because there is no elements/
 * attributes vocabulary through which script execution, external fetches, or
 * navigation are reachable in the first place.
 */
function assertSvgIsAllowlisted(svg: string, code: string): void {
  if (svg.length > SVG_MAX_LENGTH) {
    throw invalidConnectorManifest(`icon.svg must not exceed ${SVG_MAX_LENGTH} characters`, code);
  }
  SVG_TAG_RE.lastIndex = 0;
  const tags: ParsedSvgTag[] = [];
  let sawSvgRoot = false;
  let cursor = 0;
  let match = SVG_TAG_RE.exec(svg);
  while (match) {
    // Text strictly between tags is inert (SVG has no text-execution sink in
    // this vocabulary — <title> content is the only text ever rendered, and
    // it is not markup), but a bare `<` or `>` outside a well-formed tag is
    // grounds for rejection rather than silent tolerance.
    if (match.index !== cursor && svg.slice(cursor, match.index).includes("<")) {
      throw invalidConnectorManifest("icon.svg contains malformed markup", code);
    }
    cursor = SVG_TAG_RE.lastIndex;
    const parsed = parseSvgTag(match[1] ?? "");
    if (!parsed) {
      throw invalidConnectorManifest("icon.svg contains malformed markup", code);
    }
    assertTagIsAllowlisted(parsed, code);
    if (parsed.name === "svg" && !parsed.closing) {
      sawSvgRoot = true;
    }
    tags.push(parsed);
    match = SVG_TAG_RE.exec(svg);
  }
  if (cursor < svg.length && svg.slice(cursor).includes("<")) {
    throw invalidConnectorManifest("icon.svg contains malformed markup", code);
  }
  if (!sawSvgRoot) {
    throw invalidConnectorManifest("icon.svg must be a bare <svg> element", code);
  }
  const [rootTag] = tags;
  if (rootTag?.name !== "svg" || rootTag.closing) {
    throw invalidConnectorManifest("icon.svg must be a bare <svg> element", code);
  }
}

/**
 * Validates an optional manifest `icon` declaration. v1 supports exactly one
 * kind, `inline_svg`: the manifest carries the SVG markup itself, so no
 * runtime fetch and no connector-id -> icon map exists anywhere in the
 * console or reference implementation (the console renders whatever `icon`
 * value it is handed, unconditionally).
 *
 * `icon.svg` is untrusted manifest data — see assertSvgIsAllowlisted for the
 * XSS defense this delegates to.
 */
export function validateManifestIcon(manifest: Record<string, unknown>, code: string): void {
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const icon = manifest.icon;
  if (icon === undefined) {
    return;
  }
  if (!icon || typeof icon !== "object" || Array.isArray(icon)) {
    throw invalidConnectorManifest("icon must be an object when declared", code);
  }
  const iconObj = icon as Record<string, unknown>;
  const unknownKeys = Object.keys(iconObj).filter((key) => !MANIFEST_ICON_ALLOWED_KEYS.has(key));
  if (unknownKeys.length) {
    throw invalidConnectorManifest(`icon has unsupported keys: ${unknownKeys.join(", ")}`, code);
  }
  if (iconObj.kind !== "inline_svg") {
    throw invalidConnectorManifest('icon.kind must be "inline_svg"', code);
  }
  if (!isNonEmptyString(iconObj.svg)) {
    throw invalidConnectorManifest("icon.svg must be a non-empty string when icon.kind is inline_svg", code);
  }
  const svg = iconObj.svg.trim();
  assertSvgIsAllowlisted(svg, code);
  if (iconObj.color !== undefined && !(isNonEmptyString(iconObj.color) && HEX_COLOR_RE.test(iconObj.color))) {
    throw invalidConnectorManifest("icon.color must be a hex color (e.g. #1ED760) when declared", code);
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
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
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
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
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

function validateStreamParentStreamsDeclaration(
  stream: Record<string, unknown>,
  code: string,
  declaredStreamNames?: Set<string>
): void {
  if (stream.parent_streams === undefined) {
    return;
  }
  const streamName = stream.name as string;
  if (
    !Array.isArray(stream.parent_streams) ||
    stream.parent_streams.length === 0 ||
    stream.parent_streams.some((parent) => !isNonEmptyString(parent))
  ) {
    throw invalidConnectorManifest(`Stream '${streamName}' parent_streams must be a non-empty string array`, code);
  }
  const parents = stream.parent_streams as string[];
  if (new Set(parents).size !== parents.length) {
    throw invalidConnectorManifest(`Stream '${streamName}' parent_streams must not contain duplicates`, code);
  }
  if (parents.includes(streamName)) {
    throw invalidConnectorManifest(`Stream '${streamName}' parent_streams must not name the stream itself`, code);
  }
  const unknownParent = declaredStreamNames && parents.find((parent) => !declaredStreamNames.has(parent));
  if (unknownParent) {
    throw invalidConnectorManifest(
      `Stream '${streamName}' parent_streams entry '${unknownParent}' must name another declared stream`,
      code
    );
  }
  if (stream.coverage_strategy !== "parent_detail_accounting") {
    throw invalidConnectorManifest(
      `Stream '${streamName}' declares parent_streams, which is only valid with coverage_strategy "parent_detail_accounting" (got "${stream.coverage_strategy as string}")`,
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
  // Direct, explicit rejection of both checkpoint-dependency declaration
  // shapes on one stream. `state_stream` and `parent_streams` are gated to
  // different, mutually exclusive `coverage_strategy` values today, which
  // makes this combination unrepresentable as an incidental side effect —
  // but the profile's Validation rule 4 is normative regardless of that
  // side channel, so this check must fail closed on its own even if
  // `coverage_strategy`'s constraints ever change. See
  // spec-collection-profile.md, Checkpoint dependency > Validation, rule 4.
  if (stream.state_stream !== undefined && stream.parent_streams !== undefined) {
    throw invalidConnectorManifest(
      `Stream '${stream.name as string}' must not declare both state_stream and parent_streams`,
      code
    );
  }
  validateStreamStateStreamDeclaration(stream, code, declaredStreamNames);
  validateStreamParentStreamsDeclaration(stream, code, declaredStreamNames);
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
    if (
      streamObj[fieldName] !== null &&
      streamObj[fieldName] !== undefined &&
      !schemaFieldNames.has(streamObj[fieldName] as string)
    ) {
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
  if (typeof streamObj.cursor_field === "string" && !opts.skipCursorFieldSortCheck) {
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

// Provider-neutral cycle detection over the manifest's declared checkpoint-
// dependency graph (state_stream / parent_streams edges). Rules 1-5 above
// only reject a stream naming itself directly; two or more direct edges can
// still form a longer cycle (A.state_stream=B, B.state_stream=A, or
// A -> B -> C -> A), which those per-stream checks cannot see because each
// only inspects one stream's own declared edges in isolation. This performs
// a DFS with a visiting/visited coloring over the whole graph, purely from
// the declared edges — no connector-specific knowledge. See
// spec-collection-profile.md, Checkpoint dependency > Validation, rule 6.
function buildCheckpointDependencyGraph(
  manifestStreamsByName: Map<string, Record<string, unknown>>
): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const [name, stream] of manifestStreamsByName) {
    const edges: string[] = [];
    if (isNonEmptyString(stream.state_stream)) {
      edges.push(stream.state_stream as string);
    }
    if (Array.isArray(stream.parent_streams)) {
      for (const parent of stream.parent_streams as unknown[]) {
        if (isNonEmptyString(parent)) {
          edges.push(parent as string);
        }
      }
    }
    graph.set(name, edges);
  }
  return graph;
}

function findCheckpointDependencyCycle(graph: Map<string, string[]>): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  function visit(node: string): string[] | null {
    if (visited.has(node)) {
      return null;
    }
    if (visiting.has(node)) {
      const cycleStart = path.indexOf(node);
      return [...path.slice(cycleStart), node];
    }
    visiting.add(node);
    path.push(node);
    for (const neighbor of graph.get(node) || []) {
      const cycle = visit(neighbor);
      if (cycle) {
        return cycle;
      }
    }
    path.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  }

  for (const node of graph.keys()) {
    const cycle = visit(node);
    if (cycle) {
      return cycle;
    }
  }
  return null;
}

function validateCheckpointDependencyAcyclic(
  manifestStreamsByName: Map<string, Record<string, unknown>>,
  code: string
): void {
  const graph = buildCheckpointDependencyGraph(manifestStreamsByName);
  const cycle = findCheckpointDependencyCycle(graph);
  if (cycle) {
    throw invalidConnectorManifest(`Checkpoint-dependency cycle detected among streams: ${cycle.join(" -> ")}`, code);
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
  validateProvenCapability(manifest, code);
  validateManifestSensitivity(manifest, code);
  validateManifestIcon(manifest, code);
  validateStaticSecretCredentialCapture(manifest, code);

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
  validateCheckpointDependencyAcyclic(manifestStreamsByName, code);
}
