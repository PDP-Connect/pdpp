// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import {
  type ResolvedGrant,
  ResolvedGrantSchema,
  type SelectionRequest,
  SelectionRequestSchema,
  type SourceDeclaration,
  validateResolvedGrantSemantics,
  validateSelectionRequestSemantics,
} from "@pdpp/reference-contract/public/source";
import { passesGrantRecordConstraints } from "./record-filters.ts";
import { requireSourceDeclaration, snapshotSourceDeclaration } from "./source-declaration.ts";

type JsonObject = Record<string, unknown>;

export interface CoreSourceBinding {
  id: string;
  kind: "connector" | "provider_native";
}

export interface CoreStreamSelection {
  fields?: string[] | undefined;
  instance_ids?: string[] | undefined;
  name: string;
  resources?: string[] | undefined;
  time_constraint?: { field: string; since?: string; until?: string } | undefined;
  time_range?: { since?: string; until?: string } | undefined;
  view?: string | undefined;
}

export interface CoreSelection {
  access_mode: string;
  purpose_code: string;
  purpose_description?: string | undefined;
  retention?: unknown | undefined;
  selection_preset?: string | undefined;
  streams?: CoreStreamSelection[] | undefined;
  type: string;
}

export interface RetainedCoreConsentSnapshot {
  declaration: SourceDeclaration;
  declaration_version: string;
  resolved_streams: CoreStreamSelection[];
  snapshot_version: "reference.source-declaration-snapshot.v1";
  source: CoreSourceBinding;
  source_sensitivity: string;
}

interface SchemaError {
  instancePath?: string;
  message?: string;
}

interface SchemaValidator {
  errors?: SchemaError[] | null;
  (value: unknown): boolean;
}

interface AjvInstance {
  compile: (schema: object) => SchemaValidator;
}

interface PrecollectedRecord {
  data: JsonObject;
  instance_id: string;
  key: string;
  stream: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    fail("Retained consent evidence must contain only JSON values");
  }
  return encoded;
}

const requireFromContract = createRequire(import.meta.resolve("@pdpp/reference-contract"));
const Ajv2020 = requireFromContract("ajv/dist/2020.js") as new (options?: JsonObject) => AjvInstance;
const addFormats = requireFromContract("ajv-formats") as (ajv: AjvInstance) => void;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateResolvedGrantSchema = ajv.compile(ResolvedGrantSchema);
const validateSelectionRequestSchema = ajv.compile(SelectionRequestSchema);

export class CoreSourceAuthorizationError extends Error {
  readonly code = "source.authorization_details_invalid";
  /**
   * Stream names implicated by this error, in structured form. Populated so
   * a client can act on the failure programmatically instead of parsing
   * `message` prose — e.g. the hosted MCP picker re-render or an
   * authorization_details retry that narrows to the streams that remain
   * resolvable.
   */
  readonly streams?: readonly string[];

  constructor(message: string, streams?: readonly string[]) {
    super(message);
    if (streams) {
      this.streams = streams;
    }
  }
}

function fail(message: string, streams?: readonly string[]): never {
  throw new CoreSourceAuthorizationError(message, streams);
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!isObject(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && wanted.every((key, index) => actual[index] === key);
}

function requireSourceBinding(value: unknown): CoreSourceBinding {
  if (!hasExactKeys(value, ["id", "kind"])) {
    fail("Source must include only kind and id");
  }
  const source = value as JsonObject;
  if (!isNonEmptyString(source.id) || (source.kind !== "connector" && source.kind !== "provider_native")) {
    fail("Source kind and id are invalid");
  }
  return { id: source.id, kind: source.kind };
}

function manifestStreams(declaration: SourceDeclaration): SourceDeclaration["streams"] {
  return declaration.streams;
}

function requiredFields(stream: SourceDeclaration["streams"][number]): string[] {
  const required = stream.schema.required ?? [];
  if (!(Array.isArray(required) && required.every(isNonEmptyString)) || new Set(required).size !== required.length) {
    fail(`Stream '${stream.name}' schema.required must contain unique field names`);
  }
  return required;
}

export function coreSchemaRequiredFields(stream: SourceDeclaration["streams"][number]): string[] {
  return requiredFields(stream);
}

function includeRequiredFields(fields: string[], stream: SourceDeclaration["streams"][number]): string[] {
  return [...new Set([...fields, ...requiredFields(stream)])];
}

function resolveFields(
  request: CoreStreamSelection,
  stream: SourceDeclaration["streams"][number]
): Pick<CoreStreamSelection, "fields" | "view"> {
  if (request.view && request.fields) {
    fail(`Stream '${stream.name}' view and fields are mutually exclusive`);
  }
  if (request.view) {
    const view = stream.views?.find((candidate) => candidate.id === request.view);
    if (!(view && isNonEmptyStringArray(view.fields))) {
      fail(`Unknown view '${request.view}' on stream '${stream.name}'`);
    }
    return { fields: includeRequiredFields(view.fields, stream), view: request.view };
  }
  const properties = isObject(stream.schema.properties) ? stream.schema.properties : {};
  if (!request.fields) {
    // JSONB does not preserve object-key insertion order. Field sets must
    // resolve identically after a pending snapshot round-trips through either
    // persistence backend.
    const fields = Object.keys(properties).sort();
    if (fields.length === 0) {
      fail(`Stream '${stream.name}' snapshot has no fields to authorize`);
    }
    return { fields };
  }
  if (!(stream.selection.fields && isNonEmptyStringArray(request.fields))) {
    fail(`Stream '${stream.name}' does not support the requested field selection`);
  }
  const unknown = request.fields.filter((field) => !(field in properties));
  if (unknown.length > 0) {
    fail(`Unknown fields on stream '${stream.name}': ${unknown.join(", ")}`);
  }
  return { fields: includeRequiredFields(request.fields, stream) };
}

function resolveResources(
  resources: string[] | undefined,
  stream: SourceDeclaration["streams"][number]
): string[] | undefined {
  if (resources === undefined) {
    return;
  }
  if (
    !(stream.selection.resources && isNonEmptyStringArray(resources)) ||
    new Set(resources).size !== resources.length
  ) {
    fail(`Stream '${stream.name}' resources are not a supported unique non-empty selection`);
  }
  if (stream.primary_key.length === 1) {
    return [...resources];
  }
  for (const resource of resources) {
    let components: unknown;
    try {
      components = JSON.parse(resource);
    } catch {
      fail(`Stream '${stream.name}' compound resource keys must be minified JSON string arrays`);
    }
    if (
      !Array.isArray(components) ||
      components.length !== stream.primary_key.length ||
      !components.every((component) => typeof component === "string") ||
      JSON.stringify(components) !== resource
    ) {
      fail(`Stream '${stream.name}' compound resource key has the wrong shape`);
    }
  }
  return [...resources];
}

function resolveTimeConstraint(
  timeRange: CoreStreamSelection["time_range"],
  stream: SourceDeclaration["streams"][number]
): CoreStreamSelection["time_constraint"] {
  if (timeRange === undefined) {
    return;
  }
  if (!stream.consent_time_field) {
    fail(`Stream '${stream.name}' does not support time_range`);
  }
  if (timeRange.since && timeRange.until && Date.parse(timeRange.since) > Date.parse(timeRange.until)) {
    fail(`Stream '${stream.name}' time_range.since must not follow time_range.until`);
  }
  return {
    field: stream.consent_time_field,
    ...(timeRange.since ? { since: timeRange.since } : {}),
    ...(timeRange.until ? { until: timeRange.until } : {}),
  };
}

function projectResolvedStream(stream: CoreStreamSelection, requireInstances: boolean): CoreStreamSelection {
  if (!isNonEmptyString(stream.name) || stream.name === "*" || !isNonEmptyStringArray(stream.fields)) {
    fail("Resolved stream name and fields must be concrete and non-empty");
  }
  const instanceIds = stream.instance_ids ?? [];
  if (
    !Array.isArray(instanceIds) ||
    instanceIds.some((id) => !isNonEmptyString(id)) ||
    new Set(instanceIds).size !== instanceIds.length ||
    (requireInstances && instanceIds.length === 0)
  ) {
    fail(`Resolved stream '${stream.name}' has invalid instance_ids`);
  }
  return {
    fields: [...stream.fields],
    instance_ids: [...instanceIds],
    name: stream.name,
    ...(stream.resources ? { resources: cloneJson(stream.resources) } : {}),
    ...(stream.time_constraint ? { time_constraint: cloneJson(stream.time_constraint) } : {}),
  };
}

export function projectPendingCoreStream(stream: CoreStreamSelection): CoreStreamSelection {
  return projectResolvedStream(stream, false);
}

export function projectResolvedCoreGrantStream(stream: CoreStreamSelection): CoreStreamSelection {
  return projectResolvedStream(stream, true);
}

export function projectResolvedCoreGrantStreams(streams: CoreStreamSelection[]): CoreStreamSelection[] {
  return streams.map(projectResolvedCoreGrantStream);
}

export function resolveCoreSelection(
  selection: Pick<CoreSelection, "selection_preset" | "streams">,
  declarationInput: unknown
): CoreStreamSelection[] {
  const declaration = requireSourceDeclaration(declarationInput);
  let requests = selection.streams ?? [];
  if (selection.selection_preset) {
    const preset = declaration.selection_presets?.find((candidate) => candidate.id === selection.selection_preset);
    if (!preset) {
      fail(`Unknown selection_preset '${selection.selection_preset}'`);
    }
    requests = cloneJson(preset.streams) as CoreStreamSelection[];
  }
  if (requests.length === 1 && requests[0]?.name === "*") {
    const instanceIds = requests[0].instance_ids;
    requests = manifestStreams(declaration).map((stream) => ({
      ...(instanceIds ? { instance_ids: [...instanceIds] } : {}),
      name: stream.name,
    }));
  }
  return requests.map((request) => {
    const stream = declaration.streams.find((candidate) => candidate.name === request.name);
    if (!stream) {
      fail(`Unknown stream: ${request.name}`);
    }
    const fields = resolveFields(request, stream);
    const instanceIds = request.instance_ids ?? [];
    if (instanceIds.some((id) => !isNonEmptyString(id)) || new Set(instanceIds).size !== instanceIds.length) {
      fail(`Stream '${stream.name}' instance_ids must be unique opaque handles`);
    }
    const resources = resolveResources(request.resources, stream);
    const timeConstraint = resolveTimeConstraint(request.time_range, stream);
    return projectResolvedStream(
      {
        ...fields,
        instance_ids: [...instanceIds],
        name: stream.name,
        ...(resources ? { resources } : {}),
        ...(timeConstraint ? { time_constraint: timeConstraint } : {}),
      },
      false
    );
  });
}

export function validateCoreSelectionRequest(value: unknown): SelectionRequest {
  const candidate = cloneJson(value);
  if (!validateSelectionRequestSchema(candidate)) {
    const details = (validateSelectionRequestSchema.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message || "is invalid"}`)
      .join("; ");
    fail(`Selection request is invalid: ${details}`);
  }
  const request = candidate as SelectionRequest;
  const semantic = validateSelectionRequestSemantics(request);
  if (!semantic.ok) {
    fail(`Selection request semantics are invalid: ${semantic.failures.map((item) => item.code).join(", ")}`);
  }
  return request;
}

export function createRetainedCoreConsentSnapshot({
  declaration: declarationInput,
  selection,
  source,
  sourceSensitivity,
}: {
  declaration: unknown;
  selection: CoreSelection;
  source: unknown;
  sourceSensitivity: string;
}): RetainedCoreConsentSnapshot {
  const declaration = snapshotSourceDeclaration(declarationInput);
  const retainedSource = requireSourceBinding(source);
  if (declaration.source.id !== retainedSource.id || declaration.source.kind !== retainedSource.kind) {
    fail("SourceDeclaration does not match the requested source");
  }
  if (!isNonEmptyString(sourceSensitivity)) {
    fail("Source sensitivity is required for consent display");
  }
  return {
    declaration,
    declaration_version: declaration.declaration_version,
    resolved_streams: resolveCoreSelection(selection, declaration),
    snapshot_version: "reference.source-declaration-snapshot.v1",
    source: retainedSource,
    source_sensitivity: sourceSensitivity,
  };
}

export function readRetainedCoreConsentSnapshot({
  selection,
  snapshot: snapshotInput,
  source,
}: {
  selection: CoreSelection;
  snapshot: unknown;
  source: unknown;
}): RetainedCoreConsentSnapshot {
  if (!isObject(snapshotInput)) {
    fail("Pending consent declaration snapshot is missing");
  }
  if (
    !hasExactKeys(snapshotInput, [
      "declaration",
      "declaration_version",
      "resolved_streams",
      "snapshot_version",
      "source",
      "source_sensitivity",
    ])
  ) {
    fail("Pending consent declaration snapshot shape is unsupported");
  }
  const snapshot = snapshotInput as unknown as RetainedCoreConsentSnapshot;
  if (snapshot.snapshot_version !== "reference.source-declaration-snapshot.v1") {
    fail("Pending consent declaration snapshot version is unsupported");
  }
  if (!(Array.isArray(snapshot.resolved_streams) && isNonEmptyString(snapshot.source_sensitivity))) {
    fail("Pending consent resolved declaration snapshot is incomplete");
  }
  const declaration = requireSourceDeclaration(snapshot.declaration);
  const retainedSource = requireSourceBinding(snapshot.source);
  const requestSource = requireSourceBinding(source);
  if (
    retainedSource.id !== requestSource.id ||
    retainedSource.kind !== requestSource.kind ||
    declaration.source.id !== retainedSource.id ||
    declaration.source.kind !== retainedSource.kind
  ) {
    fail("Pending consent declaration snapshot source does not match the request");
  }
  if (snapshot.declaration_version !== declaration.declaration_version) {
    fail("Pending consent declaration snapshot metadata does not match its bytes");
  }
  const retainedStreams = snapshot.resolved_streams.map((stream) => projectResolvedStream(stream, false));
  const derivedStreams = resolveCoreSelection(selection, declaration);
  if (canonicalJson(retainedStreams) !== canonicalJson(derivedStreams)) {
    fail("Resolved streams are not derivable from the retained declaration and request");
  }
  return cloneJson({
    ...snapshot,
    declaration,
    resolved_streams: retainedStreams,
    source: retainedSource,
  });
}

export function renderRetainedCoreConsent(args: Parameters<typeof readRetainedCoreConsentSnapshot>[0]) {
  const snapshot = readRetainedCoreConsentSnapshot(args);
  return {
    display: cloneJson(snapshot.declaration.display),
    resolvedStreams: cloneJson(snapshot.resolved_streams),
    source: cloneJson(snapshot.source),
  };
}

// Sentinel distinguishing "this stream has zero eligible instances, drop it"
// from every other outcome of resolving one stream's instance_ids.
const ZERO_ELIGIBLE_INSTANCES = Symbol("zero_eligible_instances");

export function resolveCoreEligibleInstanceIds({
  eligibleInstanceIdsByStream,
  streams,
}: {
  eligibleInstanceIdsByStream: Readonly<Record<string, readonly string[]>>;
  streams: CoreStreamSelection[];
}): CoreStreamSelection[] {
  const droppedStreamNames: string[] = [];
  const resolved = streams.map((stream) => {
    const eligible = new Set(eligibleInstanceIdsByStream[stream.name] ?? []);
    const requested = stream.instance_ids ?? [];
    if (requested.length === 0) {
      // Zero eligible instances is not the same failure as genuine ambiguity
      // (eligible.size > 1, handled below — that case MUST keep failing: the
      // owner must disambiguate). Zero means no installed connector can serve
      // this stream at all, so it is dropped from the resolved set rather
      // than detonating authorization for every other requested stream.
      if (eligible.size === 0) {
        droppedStreamNames.push(stream.name);
        return ZERO_ELIGIBLE_INSTANCES;
      }
      if (eligible.size > 1) {
        fail(
          `Omitted instance_ids requires exactly one eligible instance for stream '${stream.name}', found ${eligible.size}`,
          [stream.name]
        );
      }
      return projectResolvedStream({ ...stream, instance_ids: [...eligible] }, true);
    }
    const unauthorized = requested.filter((instanceId) => !eligible.has(instanceId));
    if (unauthorized.length > 0) {
      fail(`Stream '${stream.name}' requested an ineligible instance handle`, [stream.name]);
    }
    return projectResolvedStream(stream, true);
  });
  const kept = resolved.filter((entry): entry is CoreStreamSelection => entry !== ZERO_ELIGIBLE_INSTANCES);
  if (kept.length === 0 && droppedStreamNames.length > 0) {
    // Every requested stream dropped — an empty scope is still an error, but
    // now an actionable one naming exactly which streams had no eligible
    // instance, instead of a generic "found 0" for whichever stream happened
    // to be scanned first.
    fail(`No eligible instance for any requested stream: ${droppedStreamNames.join(", ")}`, droppedStreamNames);
  }
  return kept;
}

export function materializeCoreResolvedGrant({
  accessMode,
  clientId,
  expiresAt,
  grantId,
  issuedAt,
  purposeCode,
  purposeDescription,
  resolvedStreams,
  retention,
  selectionPreset,
  snapshot,
  subjectId,
}: {
  accessMode: string;
  clientId: string;
  expiresAt: string | null;
  grantId: string;
  issuedAt: string;
  purposeCode: string;
  purposeDescription?: string | undefined;
  resolvedStreams: CoreStreamSelection[];
  retention?: unknown | undefined;
  selectionPreset?: string | undefined;
  snapshot: RetainedCoreConsentSnapshot;
  subjectId: string;
}): ResolvedGrant {
  const candidate = {
    access_mode: accessMode,
    client: { client_id: clientId },
    // Absent-only expiry: a grant with no expiry omits the field entirely
    // rather than carrying an explicit `null` (spec-core.md, Grant fields).
    ...(expiresAt === null || expiresAt === undefined ? {} : { expires_at: expiresAt }),
    grant_id: grantId,
    issued_at: issuedAt,
    purpose_code: purposeCode,
    ...(purposeDescription ? { purpose_description: purposeDescription } : {}),
    ...(retention ? { retention } : {}),
    ...(selectionPreset ? { selection_preset: selectionPreset } : {}),
    source: cloneJson(snapshot.source),
    source_declaration: { version: snapshot.declaration_version },
    streams: resolvedStreams.map((stream) => projectResolvedStream(stream, true)),
    subject: { id: subjectId },
    version: "0.1.0" as const,
  };
  return parseCoreResolvedGrant(candidate);
}

/**
 * Normalize a legacy explicit-null `expires_at` to the absent-only form.
 *
 * `expires_at` is absent-only: a grant with no expiry omits the field. Grants
 * issued before that normalization persisted an explicit `"expires_at": null`
 * in `grants.grant_json`, and those blobs are re-parsed on every read. Dropping
 * the member here — rather than rejecting it — keeps already-issued grants
 * readable while giving every caller downstream the single terminal shape.
 * `null` and absent already mean the same thing (no expiry), so this is a
 * representation change, not an authorization change.
 *
 * Exported because `grants.grant_json` is not the only durable home of a
 * resolved grant: `agent_connect_attempts` keeps its own `grant_json` and a
 * second copy nested in `response_json.grant`. Those blobs are legacy/partial
 * and cannot be round-tripped through `parseCoreResolvedGrant` (they would
 * fail full schema validation and break redemption), so the agent-connect
 * read path applies THIS rule directly. One exported normalizer keeps a single
 * authority for the representation instead of a second, drifting copy.
 */
export function normalizeAbsentOnlyExpiry(candidate: unknown): unknown {
  if (isObject(candidate) && "expires_at" in candidate && candidate.expires_at === null) {
    const { expires_at: _legacyNull, ...rest } = candidate;
    return rest;
  }
  return candidate;
}

/**
 * Parse the closed Source resolved-grant contract used by every binding.
 *
 * TOLERANT BY DESIGN, AND PERSISTED-STATE ONLY. This function deliberately
 * accepts one shape the current JSON Schema rejects: a legacy explicit
 * `"expires_at": null`. It drops that member (see `normalizeAbsentOnlyExpiry`)
 * BEFORE running the validator, so a grant blob written before the absent-only
 * normalization still parses.
 *
 * That tolerance is a persistence-compatibility bridge, NOT a wire contract.
 * The current wire contract is the JSON Schema, which rejects explicit null.
 * Nothing here licenses accepting an explicit null from a peer.
 *
 * Every current call site honours that restriction, which is what makes the
 * looser shape safe to keep here for now:
 *
 *   - `source-approved-authorization.ts` parses a grant read back from
 *     durable storage;
 *   - `source-introspection-context.ts` parses a grant this process just
 *     reconstructed field-by-field in `resolvedGrantInput()`, which omits
 *     `expires_at` rather than emitting null, and thereafter re-parses only
 *     that already-normalized internal object.
 *
 * No path feeds newly received, untrusted peer JSON straight into this
 * function. Keep it that way: if such a caller is ever added, it must NOT
 * inherit this tolerance.
 *
 * FOLLOW-UP (review of #242, "Optional parser-boundary refinement"): the
 * stronger terminal design splits this into two named boundaries --
 *
 *     parseCurrentResolvedGrant()
 *       - strict current schema
 *       - explicit null rejected
 *
 *     parseLegacyPersistedResolvedGrant()
 *       - permits only documented legacy deviations
 *       - normalizes
 *       - records migration/evidence
 *       - never used for new untrusted wire input
 *
 * That split does not block #242 because the call sites above are verified to
 * use the tolerant parser only for persisted/internal data. This comment is
 * the documented restriction the review asked for, so the migration exception
 * does not silently become permanent protocol acceptance.
 */
export function parseCoreResolvedGrant(value: unknown): ResolvedGrant {
  const candidate = normalizeAbsentOnlyExpiry(cloneJson(value));
  if (!validateResolvedGrantSchema(candidate)) {
    const details = (validateResolvedGrantSchema.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message || "is invalid"}`)
      .join("; ");
    fail(`Resolved grant is invalid: ${details}`);
  }
  const grant = candidate as ResolvedGrant;
  const semantic = validateResolvedGrantSemantics(grant);
  if (!semantic.ok) {
    fail(`Resolved grant semantics are invalid: ${semantic.failures.map((item) => item.code).join(", ")}`);
  }
  return grant;
}

export function servePrecollectedCoreRecords({
  grant,
  instanceId,
  records,
  stream,
}: {
  grant: ResolvedGrant;
  instanceId: string;
  records: PrecollectedRecord[];
  stream: string;
}): Array<{ data: JsonObject; key: string; stream: string }> {
  const streamGrant = grant.streams.find((entry) => entry.name === stream);
  if (!streamGrant?.instance_ids.includes(instanceId)) {
    fail(`Stream '${stream}' is not authorized for instance '${instanceId}'`);
  }
  return records
    .filter(
      (record) =>
        record.stream === stream &&
        record.instance_id === instanceId &&
        passesGrantRecordConstraints(record.data, record.key, streamGrant, {})
    )
    .map((record) => ({
      data: Object.fromEntries(
        streamGrant.fields.filter((field) => field in record.data).map((field) => [field, record.data[field]])
      ),
      key: record.key,
      stream: record.stream,
    }));
}
