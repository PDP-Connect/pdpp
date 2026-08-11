// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Final, pure stream-health acceptance authority.
 *
 * The older `auditStreamHealth` machine remains a narrow coverage-evidence
 * check. This module owns the acceptance score: one scored unit is one active
 * owner connection crossed with one production stream declared by its
 * manifest. A count, checkpoint, or green pill is never a substitute for a
 * successful runtime proof and committed coverage (or an explicit verified
 * empty proof).
 */

type JsonObject = Record<string, unknown>;

export const STREAM_HEALTH_CLASSES = [
  "green",
  "active_bounded_work",
  "owner_interaction",
  "provider_config_blocked",
  "unobserved",
  "failed",
  "stale",
  "optional_unsupported",
  "revoked",
  "synthetic_fixture",
  "projection_disagreement",
  "unknown_vocabulary",
  "inconclusive_auth",
  "inconclusive_suspense",
  "inconclusive_pagination",
  "inconclusive_revision",
  "manifest_unavailable",
] as const;

export type StreamHealthClass = (typeof STREAM_HEALTH_CLASSES)[number];

const KNOWN_CONNECTION_STATUSES = new Set(["active", "draft", "paused", "rejected", "revoked"]);
const KNOWN_OWNER_RESOLVERS = new Set([
  "blocked_maintainer",
  "collecting",
  "healthy",
  "needs_owner",
  "not_measured",
  "owner_paused",
  "refresh_due",
  "retired",
  "setup_in_progress",
  "system_degraded",
]);
const KNOWN_OWNER_OF_STATES = new Set(["maintainer", "owner", "system"]);
const KNOWN_OWNER_POSTURES = new Set(["frozen-since-last-run", "observed"]);
const KNOWN_HEALTH_STATES = new Set([
  "blocked",
  "cooling_off",
  "degraded",
  "healthy",
  "idle",
  "needs_attention",
  "unknown",
]);
const KNOWN_COVERAGE_AXES = new Set([
  "complete",
  "deferred",
  "gaps",
  "inventory_only",
  "partial",
  "retryable_gap",
  "terminal_gap",
  "unavailable",
  "unknown",
  "unsupported",
]);
const KNOWN_FRESHNESS_AXES = new Set(["fresh", "stale", "unknown"]);
const KNOWN_ATTENTION_AXES = new Set(["acknowledged", "in_progress", "none", "open"]);
const KNOWN_OUTBOX_AXES = new Set(["active", "idle", "stalled", "unknown"]);
const KNOWN_FORWARD_DISPOSITIONS = new Set([
  "awaiting_owner",
  "checking",
  "complete",
  "owner_refresh_due",
  "resumable",
  "terminal",
  "unmeasured",
]);
const KNOWN_PILL_TONES = new Set(["amber", "green", "grey", "red"]);
const KNOWN_RUN_STATUSES = new Set([
  "abandoned",
  "active",
  "cancelled",
  "completed",
  "deferred",
  "expired",
  "failed",
  "in_progress",
  "leased",
  "rejected",
  "released",
  "started",
  "starting_surface",
  "surface_failed",
  "succeeded",
  "success",
  "waiting_for_browser_surface",
]);
const KNOWN_COVERAGE_CONDITIONS = new Set([
  "complete",
  "deferred",
  "gaps",
  "inventory_only",
  "partial",
  "retryable_gap",
  "terminal_gap",
  "unavailable",
  "unknown",
  "unsupported",
]);
const KNOWN_COVERAGE_POLICIES = new Set(["collect", "deferred", "inventory_only", "unavailable", "unsupported"]);
const KNOWN_AVAILABILITY_STATES = new Set(["supported", "unsupported_in_mode", "experimental", "deprecated"]);
const KNOWN_COVERAGE_STRATEGIES = new Set([
  "checkpoint_window",
  "full_inventory",
  "parent_detail_accounting",
  "snapshot_import_receipt",
  "singleton_presence",
]);
const KNOWN_FRESHNESS_STRATEGIES = new Set([
  "device_heartbeat",
  "manual_as_of",
  "not_trackable",
  "scheduled_window",
  "source_reported_as_of",
]);
const KNOWN_COUNT_STATES = new Set(["known", "known_zero", "unobserved", "stale", "unknown"]);
const KNOWN_DECLARATION_STATES = new Set(["declared", "dormant", "unexpected", "unavailable"]);
const SUCCESSFUL_RUN_STATUSES = new Set(["completed", "succeeded", "success"]);
const FAILED_RUN_STATUSES = new Set(["abandoned", "failed", "rejected", "surface_failed"]);
const ACTIVE_RUN_STATUSES = new Set(["active", "in_progress", "leased", "started", "starting_surface"]);
const ACCEPTED_ABSENCE_POLICIES = new Set(["deferred", "inventory_only", "unavailable", "unsupported"]);
const EXPLICIT_TEST_ENVIRONMENTS = new Set(["fixture", "test", "testing"]);
const EXPLICIT_SYNTHETIC_KINDS = new Set(["fixture", "synthetic", "synthetic_fixture", "test_fixture"]);
const CHECKPOINT_UNKNOWN_VALUES = new Set(["", "none", "unknown", "unobserved", "pending"]);
const AUTH_FAILURE_PATTERN = /(?:\/owner\/login|name=["']password["']|sign\s+in\s+to\s+continue|owner\s+login)/i;
const SUSPENSE_TESTID_PATTERN = /data-testid=["'][^"']*(?:loading|suspense)[^"']*["']/i;
const SUSPENSE_BUSY_PATTERN = /aria-busy=["']true["']/i;
const SUSPENSE_CLASS_PATTERN = /(?:skeleton|animate-pulse)/i;
const HREF_PATTERN = /\bhref=(['"])(.*?)\1/gi;
const PAGE_CURSOR_PATTERN = /[?&]page_cursor=/;
const EXPLICIT_EMPTY_PATTERN = /data-testid=["']sources-empty["']/i;

export interface OwnerSourcesDomEvidence {
  authenticated?: boolean;
  connectionIds: readonly string[];
  nextPageHrefs?: readonly string[];
  paginationComplete?: boolean;
  reason?: string | null;
  resolved: boolean;
  streamKeys?: readonly { connectionId: string; stream: string }[];
  suspense?: boolean;
}

export interface StreamHealthAuthorityInput {
  auth?: { authenticated?: boolean; mode?: string; resolved: boolean };
  catalog?: readonly unknown[];
  connections: readonly unknown[];
  dom?: OwnerSourcesDomEvidence | string | null;
  expectedSha?: string | null;
  manifests?: readonly unknown[];
  paginationComplete?: boolean;
  revision?: {
    dom?: string | null;
    expected?: string | null;
    sha?: string | null;
    summaries?: string | null;
  };
}

export interface StreamHealthFinding {
  class: StreamHealthClass;
  connection_id: string | null;
  connector_id: string | null;
  denominator: boolean;
  green: boolean;
  reason: string;
  stream: string;
}

export interface StreamHealthScore {
  denominator: number;
  numerator: number;
  percentage: number | null;
  ratio: string;
}

export interface StreamHealthAuthorityResult {
  activeConnectionCount: number;
  classCounts: Record<StreamHealthClass, number>;
  connectionCount: number;
  domAgreement: {
    extraConnectionIds: string[];
    missingConnectionIds: string[];
    observedConnectionIds: string[];
    resolved: boolean;
    status: "agree" | "disagree" | "inconclusive";
  };
  findings: StreamHealthFinding[];
  gates: {
    auth: "resolved" | "inconclusive";
    dom: "resolved" | "inconclusive";
    pagination: "complete" | "inconclusive";
    revision: "exact" | "inconclusive" | "not_required";
    vocabulary: "known" | "inconclusive";
  };
  numerator: number;
  ok: boolean;
  perClass: Record<StreamHealthClass, number>;
  productionStreamCount: number;
  revisionReceipt: {
    exact: boolean;
    observedDom: string | null;
    observedSummaries: string | null;
    sha: string | null;
  };
  score: StreamHealthScore;
  status: "fail" | "inconclusive" | "pass";
  streams: StreamHealthFinding[];
  syntheticFixtureCount: number;
}

interface ManifestStream {
  name: string;
  raw: JsonObject;
}

interface ResolvedManifest {
  duplicate: boolean;
  missing: boolean;
  source: "catalog" | "connection" | "summary";
  streams: ManifestStream[];
  value: JsonObject;
}

interface ConnectionAssessment {
  duplicateManifest: boolean;
  manifest: ResolvedManifest | null;
  projectionDisagreement: string | null;
  unknownVocabulary: string[];
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nestedObject(value: unknown, key: string): JsonObject | null {
  return asObject(asObject(value)?.[key]);
}

function normalizeIdentity(value: string): string[] {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return [];
  }
  const values = new Set([trimmed]);
  try {
    const parsed = new URL(trimmed);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const last = parts.at(-1);
    if (last) {
      values.add(last);
    }
    if (parts.length >= 2 && parts.at(-2) === "connectors" && last) {
      values.add(`connectors/${last}`);
    }
  } catch {
    // Connector keys are not URLs. The exact normalized key remains usable.
  }
  return [...values];
}

function identityKeys(value: JsonObject): string[] {
  const keys = new Set<string>();
  for (const field of ["connector_id", "connector_key", "provider_id", "manifest_uri", "source_id"]) {
    const raw = value[field];
    if (typeof raw !== "string") {
      continue;
    }
    for (const key of normalizeIdentity(raw)) {
      keys.add(key);
    }
  }
  return [...keys];
}

function connectionId(connection: JsonObject): string | null {
  for (const field of ["connection_id", "connector_instance_id"]) {
    const id = asNonEmptyString(connection[field]);
    if (id) {
      return id;
    }
  }
  return null;
}

function connectionConnectorId(connection: JsonObject): string | null {
  return (
    asNonEmptyString(connection.connector_id) ??
    asNonEmptyString(connection.connector_key) ??
    asNonEmptyString(connection.provider_id)
  );
}

function isSyntheticMetadata(candidate: JsonObject, root: JsonObject): boolean {
  const booleanMarkers = [
    "synthetic",
    "synthetic_fixture",
    "test_fixture",
    "fixture",
    "is_synthetic",
    "is_test_fixture",
  ];
  if (booleanMarkers.some((key) => candidate[key] === true) || candidate.production === false) {
    return true;
  }
  const kindMarkers = [
    asNonEmptyString(candidate.environment)?.toLowerCase(),
    asNonEmptyString(candidate.kind)?.toLowerCase(),
    asNonEmptyString(candidate.catalog_status)?.toLowerCase(),
    candidate === root ? null : asNonEmptyString(candidate.status)?.toLowerCase(),
  ].filter((marker): marker is string => marker !== undefined && marker !== null);
  return kindMarkers.some((marker) => EXPLICIT_SYNTHETIC_KINDS.has(marker) || EXPLICIT_TEST_ENVIRONMENTS.has(marker));
}

function isExplicitSynthetic(value: unknown): boolean {
  const root = asObject(value);
  if (!root) {
    return false;
  }
  return [root, nestedObject(root, "catalog"), nestedObject(root, "catalog_metadata"), nestedObject(root, "metadata")]
    .filter((candidate): candidate is JsonObject => candidate !== null)
    .some((candidate) => isSyntheticMetadata(candidate, root));
}

function streamDefinitions(value: unknown): { invalid: boolean; streams: ManifestStream[] } {
  if (!Array.isArray(value)) {
    return { invalid: true, streams: [] };
  }
  const streams: ManifestStream[] = [];
  let invalid = false;
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) {
      streams.push({ name: entry.trim(), raw: { name: entry.trim() } });
      continue;
    }
    const object = asObject(entry);
    const name = asNonEmptyString(object?.name);
    if (!(object && name)) {
      invalid = true;
      continue;
    }
    streams.push({ name, raw: object });
  }
  return { invalid, streams };
}

function manifestFromCandidate(candidate: unknown): JsonObject | null {
  const object = asObject(candidate);
  if (!object) {
    return null;
  }
  const nested = asObject(object.manifest);
  return nested ?? object;
}

function manifestMatches(connection: JsonObject, manifest: JsonObject): boolean {
  const connectionKeys = new Set(identityKeys(connection));
  return identityKeys(manifest).some((key) => connectionKeys.has(key));
}

function manifestFingerprint(manifest: JsonObject): string {
  const streams = streamDefinitions(manifest.streams)
    .streams.map((stream) => ({
      availability: stream.raw.availability ?? null,
      coverage_policy: stream.raw.coverage_policy ?? null,
      coverage_strategy: stream.raw.coverage_strategy ?? null,
      freshness_strategy: stream.raw.freshness_strategy ?? null,
      name: stream.name,
      required: stream.raw.required !== false,
      unsupported: stream.raw.unsupported ?? null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return JSON.stringify({
    id: identityKeys(manifest).sort((left, right) => left.localeCompare(right)),
    synthetic: isExplicitSynthetic(manifest),
    version: manifest.version ?? null,
    streams,
  });
}

function manifestProjectionIsCurrent(connection: JsonObject): boolean {
  const declarationValue = connection.manifest_declaration;
  if (declarationValue !== undefined) {
    return nestedObject(connection, "manifest_declaration")?.state === "current";
  }
  return asNonEmptyString(connection.manifest_version) !== null;
}

function summaryManifest(connection: JsonObject): JsonObject | null {
  for (const [field, value] of [
    ["manifest", connection.manifest],
    ["manifest_excerpt", connection.manifest_excerpt],
    ["manifest_projection", connection.manifest_projection],
  ] as const) {
    const candidate = manifestFromCandidate(value);
    if (
      candidate &&
      Array.isArray(candidate.streams) &&
      (field === "manifest" || manifestProjectionIsCurrent(connection))
    ) {
      return candidate;
    }
  }
  const manifestStreams = connection.manifest_streams;
  if (Array.isArray(manifestStreams) && manifestProjectionIsCurrent(connection)) {
    return {
      connector_id: connectionConnectorId(connection),
      streams: manifestStreams,
      version: connection.manifest_version ?? null,
    };
  }
  const streams = streamDefinitions(connection.streams);
  if (streams.streams.length > 0 && !streams.invalid && manifestProjectionIsCurrent(connection)) {
    return {
      connector_id: connectionConnectorId(connection),
      streams: connection.streams,
      version: connection.manifest_version ?? null,
    };
  }
  return null;
}

function resolveManifest(connection: JsonObject, input: StreamHealthAuthorityInput): ResolvedManifest | null {
  const catalogProvided = input.manifests !== undefined || input.catalog !== undefined;
  const candidates = [...(input.manifests ?? []), ...(input.catalog ?? [])]
    .map(manifestFromCandidate)
    .filter((manifest): manifest is JsonObject => manifest !== null)
    .filter((manifest) => manifestMatches(connection, manifest));
  if (candidates.length > 0) {
    const chosen = candidates[0] as JsonObject;
    const parsed = streamDefinitions(chosen.streams);
    const duplicate = candidates.some((candidate) => manifestFingerprint(candidate) !== manifestFingerprint(chosen));
    return {
      duplicate,
      missing: parsed.invalid || parsed.streams.length === 0,
      source: "catalog",
      streams: parsed.streams,
      value: chosen,
    };
  }

  const fallback = summaryManifest(connection);
  if (!fallback) {
    return null;
  }
  const parsed = streamDefinitions(fallback.streams);
  return {
    duplicate: false,
    missing: parsed.invalid || parsed.streams.length === 0 || catalogProvided,
    source: connection.manifest ? "connection" : "summary",
    streams: parsed.streams,
    value: fallback,
  };
}

function checkVocabulary(value: unknown, allowed: ReadonlySet<string>, path: string, unknown: string[]): void {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "string" || !allowed.has(value)) {
    unknown.push(`${path}=${String(value)}`);
  }
}

function checkConnectionVocabulary(connection: JsonObject): string[] {
  const unknown: string[] = [];
  checkVocabulary(connection.status, KNOWN_CONNECTION_STATUSES, "status", unknown);
  const ownerState = nestedObject(connection, "owner_state");
  checkVocabulary(ownerState?.resolver, KNOWN_OWNER_RESOLVERS, "owner_state.resolver", unknown);
  checkVocabulary(ownerState?.owner_of_state, KNOWN_OWNER_OF_STATES, "owner_state.owner_of_state", unknown);
  checkVocabulary(ownerState?.posture, KNOWN_OWNER_POSTURES, "owner_state.posture", unknown);

  const health = nestedObject(connection, "connection_health");
  checkVocabulary(health?.state, KNOWN_HEALTH_STATES, "connection_health.state", unknown);
  checkVocabulary(
    health?.forward_disposition,
    KNOWN_FORWARD_DISPOSITIONS,
    "connection_health.forward_disposition",
    unknown
  );
  const axes = nestedObject(health, "axes");
  checkVocabulary(axes?.coverage, KNOWN_COVERAGE_AXES, "connection_health.axes.coverage", unknown);
  checkVocabulary(axes?.freshness, KNOWN_FRESHNESS_AXES, "connection_health.axes.freshness", unknown);
  checkVocabulary(axes?.attention, KNOWN_ATTENTION_AXES, "connection_health.axes.attention", unknown);
  checkVocabulary(axes?.outbox, KNOWN_OUTBOX_AXES, "connection_health.axes.outbox", unknown);

  const pill = nestedObject(nestedObject(connection, "rendered_verdict"), "pill");
  checkVocabulary(pill?.tone, KNOWN_PILL_TONES, "rendered_verdict.pill.tone", unknown);
  for (const [index, run] of [connection.last_run, connection.last_successful_run].entries()) {
    checkVocabulary(asObject(run)?.status, KNOWN_RUN_STATUSES, `run[${index}].status`, unknown);
  }
  const report = Array.isArray(connection.collection_report) ? connection.collection_report : [];
  for (const [index, entry] of report.entries()) {
    const object = asObject(entry);
    checkVocabulary(
      object?.coverage_condition,
      KNOWN_COVERAGE_CONDITIONS,
      `collection_report[${index}].coverage_condition`,
      unknown
    );
    checkVocabulary(
      object?.forward_disposition,
      KNOWN_FORWARD_DISPOSITIONS,
      `collection_report[${index}].forward_disposition`,
      unknown
    );
    checkVocabulary(
      object?.coverage_strategy,
      KNOWN_COVERAGE_STRATEGIES,
      `collection_report[${index}].coverage_strategy`,
      unknown
    );
    checkVocabulary(
      object?.freshness_strategy,
      KNOWN_FRESHNESS_STRATEGIES,
      `collection_report[${index}].freshness_strategy`,
      unknown
    );
  }
  const records = Array.isArray(connection.stream_records) ? connection.stream_records : [];
  for (const [index, record] of records.entries()) {
    const object = asObject(record);
    checkVocabulary(object?.count_state, KNOWN_COUNT_STATES, `stream_records[${index}].count_state`, unknown);
    checkVocabulary(
      object?.declaration_state,
      KNOWN_DECLARATION_STATES,
      `stream_records[${index}].declaration_state`,
      unknown
    );
  }
  return unknown;
}

function lifecycle(connection: JsonObject): "active" | "draft" | "paused" | "rejected" | "revoked" | "unknown" {
  if (connection.status === "revoked" || (connection.revoked_at !== null && connection.revoked_at !== undefined)) {
    return "revoked";
  }
  if (typeof connection.status === "string" && KNOWN_CONNECTION_STATUSES.has(connection.status)) {
    return connection.status as "active" | "draft" | "paused" | "rejected" | "revoked";
  }
  if (connection.status === undefined || connection.status === null) {
    return "unknown";
  }
  return "unknown";
}

function connectionIsSynthetic(connection: JsonObject, manifest: ResolvedManifest | null): boolean {
  return isExplicitSynthetic(connection) || isExplicitSynthetic(manifest?.value);
}

function streamIsOptionalUnsupported(stream: ManifestStream): boolean {
  const required = stream.raw.required !== false;
  if (required) {
    return false;
  }
  const policy = asNonEmptyString(stream.raw.coverage_policy)?.toLowerCase() ?? "";
  const availability = nestedObject(stream.raw, "availability");
  const availabilityState = asNonEmptyString(availability?.state)?.toLowerCase();
  return (
    (policy !== "" && ACCEPTED_ABSENCE_POLICIES.has(policy)) ||
    availabilityState === "unsupported" ||
    availabilityState === "unsupported_in_mode" ||
    stream.raw.unsupported === true
  );
}

function manifestVocabulary(manifest: ResolvedManifest | null): string[] {
  if (!manifest) {
    return [];
  }
  const unknown: string[] = [];
  for (const [index, stream] of manifest.streams.entries()) {
    const path = `manifest.streams[${index}]`;
    checkVocabulary(stream.raw.coverage_policy, KNOWN_COVERAGE_POLICIES, `${path}.coverage_policy`, unknown);
    checkVocabulary(stream.raw.coverage_strategy, KNOWN_COVERAGE_STRATEGIES, `${path}.coverage_strategy`, unknown);
    checkVocabulary(stream.raw.freshness_strategy, KNOWN_FRESHNESS_STRATEGIES, `${path}.freshness_strategy`, unknown);
    if (stream.raw.required !== undefined && typeof stream.raw.required !== "boolean") {
      unknown.push(`${path}.required=${String(stream.raw.required)}`);
    }
    if (stream.raw.unsupported !== undefined && typeof stream.raw.unsupported !== "boolean") {
      unknown.push(`${path}.unsupported=${String(stream.raw.unsupported)}`);
    }
    const availability = nestedObject(stream.raw, "availability");
    if (stream.raw.availability !== undefined && availability === null) {
      unknown.push(`${path}.availability=<malformed>`);
    }
    checkVocabulary(availability?.state, KNOWN_AVAILABILITY_STATES, `${path}.availability.state`, unknown);
  }
  return unknown;
}

function namedEntries(connection: JsonObject, key: string): { duplicates: string[]; map: Map<string, JsonObject> } {
  const map = new Map<string, JsonObject>();
  const duplicates: string[] = [];
  const values = Array.isArray(connection[key]) ? connection[key] : [];
  for (const value of values) {
    const object = asObject(value);
    const name = asNonEmptyString(object?.stream);
    if (!(object && name)) {
      continue;
    }
    if (map.has(name)) {
      duplicates.push(name);
    }
    map.set(name, object);
  }
  return { duplicates, map };
}

function declaredConnectionStreams(connection: JsonObject): string[] {
  const values = Array.isArray(connection.streams) ? connection.streams : [];
  return values
    .map((value) => (typeof value === "string" ? value.trim() : asNonEmptyString(asObject(value)?.name)))
    .filter((value): value is string => Boolean(value));
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this function compares independent owner, manifest, record, and health projections in a deliberate precedence order.
function projectionAgreement(connection: JsonObject, manifest: ResolvedManifest | null): string | null {
  if (!manifest) {
    return null;
  }
  if (manifest.duplicate) {
    return "multiple catalog manifests disagree";
  }
  const contradictoryStream = manifest.streams.find((stream) => {
    const policy = asNonEmptyString(stream.raw.coverage_policy)?.toLowerCase() ?? "";
    return stream.raw.required !== false && policy !== "" && ACCEPTED_ABSENCE_POLICIES.has(policy);
  });
  if (contradictoryStream) {
    return `required stream ${contradictoryStream.name} declares accepted absence`;
  }
  const manifestNames = new Set(manifest.streams.map((stream) => stream.name));
  const connectionNames = new Set(declaredConnectionStreams(connection));
  if (
    connectionNames.size > 0 &&
    (manifestNames.size !== connectionNames.size || [...manifestNames].some((name) => !connectionNames.has(name)))
  ) {
    return "connection stream membership disagrees with the manifest";
  }
  const report = namedEntries(connection, "collection_report");
  if (report.duplicates.length > 0) {
    return `collection_report repeats ${report.duplicates.join(", ")}`;
  }
  const records = namedEntries(connection, "stream_records");
  if (records.duplicates.length > 0) {
    return `stream_records repeats ${records.duplicates.join(", ")}`;
  }
  const inconsistentRecord = [...records.map.values()].find((record) => {
    const count = record.record_count;
    return (
      (record.count_state === "known_zero" && count !== 0) ||
      (record.count_state === "known" && count === 0) ||
      ((record.count_state === "known" || record.count_state === "known_zero") && typeof count !== "number")
    );
  });
  if (inconsistentRecord) {
    return `stream_records count state disagrees for ${String(inconsistentRecord.stream)}`;
  }
  const manifestVersion = asNonEmptyString(manifest.value.version);
  const connectionVersion = asNonEmptyString(connection.manifest_version);
  if (manifestVersion && connectionVersion && manifestVersion !== connectionVersion) {
    return "manifest version disagrees with the connection projection";
  }
  const unexpectedReport = [...report.map.keys()].find((name) => !manifestNames.has(name));
  if (unexpectedReport) {
    return `collection_report contains undeclared stream ${unexpectedReport}`;
  }
  const unexpectedRecord = [...records.map.keys()].find((name) => !manifestNames.has(name));
  if (unexpectedRecord) {
    return `stream_records contains undeclared stream ${unexpectedRecord}`;
  }
  const manifestByName = new Map(manifest.streams.map((stream) => [stream.name, stream]));
  const mismatchedRequired = [...report.map.values()].find((entry) => {
    const declared = manifestByName.get(String(entry.stream));
    return declared && typeof entry.required === "boolean" && entry.required !== (declared.raw.required !== false);
  });
  if (mismatchedRequired) {
    return `collection_report requiredness disagrees for ${String(mismatchedRequired.stream)}`;
  }

  const health = nestedObject(connection, "connection_health");
  const reliableCondition = (Array.isArray(health?.conditions) ? health.conditions : [])
    .map(asObject)
    .find((condition) => condition?.type === "ProjectionReliable");
  if (reliableCondition && reliableCondition.status !== "true") {
    return `ProjectionReliable is ${String(reliableCondition.status)}`;
  }
  const pill = nestedObject(nestedObject(connection, "rendered_verdict"), "pill");
  const healthState = health?.state;
  if (
    pill?.tone === "green" &&
    typeof healthState === "string" &&
    healthState !== "healthy" &&
    healthState !== "idle"
  ) {
    return "green rendered verdict disagrees with connection health state";
  }
  const axes = nestedObject(health, "axes");
  const reportConditions = [...report.map.values()]
    .map((entry) => asNonEmptyString(entry.coverage_condition))
    .filter((condition): condition is string => Boolean(condition));
  if (axes?.coverage === "complete" && reportConditions.some((condition) => condition !== "complete")) {
    return "complete health coverage disagrees with a non-complete collection report";
  }
  if (
    typeof axes?.coverage === "string" &&
    axes.coverage !== "complete" &&
    reportConditions.length > 0 &&
    reportConditions.every((condition) => condition === "complete")
  ) {
    return "health coverage disagrees with an entirely complete collection report";
  }
  return null;
}

function hasActiveBoundedWork(connection: JsonObject): boolean {
  const ownerState = nestedObject(connection, "owner_state");
  const health = nestedObject(connection, "connection_health");
  const axes = nestedObject(health, "axes");
  const badges = nestedObject(health, "badges");
  const lastRun = asObject(connection.last_run);
  const report = Array.isArray(connection.collection_report) ? connection.collection_report : [];
  return (
    ownerState?.resolver === "collecting" ||
    badges?.syncing === true ||
    axes?.outbox === "active" ||
    health?.forward_disposition === "checking" ||
    health?.forward_disposition === "resumable" ||
    report.some((entry) => asObject(entry)?.forward_disposition === "checking") ||
    (lastRun?.status !== "waiting_for_browser_surface" &&
      typeof lastRun?.status === "string" &&
      ACTIVE_RUN_STATUSES.has(lastRun.status))
  );
}

function needsOwnerInteraction(connection: JsonObject): boolean {
  const ownerState = nestedObject(connection, "owner_state");
  const health = nestedObject(connection, "connection_health");
  const axes = nestedObject(health, "axes");
  const nextAction = nestedObject(health, "next_action") ?? nestedObject(connection, "next_action");
  const lastRun = asObject(connection.last_run);
  return (
    ownerState?.resolver === "needs_owner" ||
    ownerState?.resolver === "setup_in_progress" ||
    ownerState?.resolver === "owner_paused" ||
    ownerState?.resolver === "refresh_due" ||
    axes?.attention === "open" ||
    axes?.attention === "in_progress" ||
    lastRun?.needs_input === true ||
    lastRun?.status === "waiting_for_browser_surface" ||
    nextAction?.owner_action === "provide_value" ||
    nextAction?.owner_action === "operate_attachment" ||
    nextAction?.owner_action === "act_elsewhere" ||
    health?.forward_disposition === "awaiting_owner" ||
    health?.forward_disposition === "owner_refresh_due"
  );
}

function isProviderConfigBlocked(connection: JsonObject): boolean {
  const health = nestedObject(connection, "connection_health");
  const axes = nestedObject(health, "axes");
  const ownerState = nestedObject(connection, "owner_state");
  return (
    health?.state === "blocked" ||
    ownerState?.resolver === "blocked_maintainer" ||
    ownerState?.resolver === "system_degraded" ||
    axes?.coverage === "unavailable" ||
    axes?.coverage === "unsupported"
  );
}

function isFailed(connection: JsonObject): boolean {
  const lastRun = asObject(connection.last_run);
  const health = nestedObject(connection, "connection_health");
  const axes = nestedObject(health, "axes");
  const pill = nestedObject(nestedObject(connection, "rendered_verdict"), "pill");
  return (
    (typeof lastRun?.status === "string" && FAILED_RUN_STATUSES.has(lastRun.status)) ||
    axes?.coverage === "terminal_gap" ||
    health?.forward_disposition === "terminal" ||
    (pill?.tone === "red" && health?.state !== "blocked")
  );
}

function isStale(connection: JsonObject, record: JsonObject | undefined): boolean {
  const health = nestedObject(connection, "connection_health");
  const axes = nestedObject(health, "axes");
  const badges = nestedObject(health, "badges");
  const snapshot = nestedObject(connection, "record_snapshot");
  return (
    snapshot?.state === "stale" ||
    axes?.freshness === "stale" ||
    badges?.stale === true ||
    record?.count_state === "stale"
  );
}

function isOwnerStateUnobserved(connection: JsonObject): boolean {
  const ownerState = nestedObject(connection, "owner_state");
  const health = nestedObject(connection, "connection_health");
  return (
    ownerState?.resolver === "not_measured" ||
    ownerState?.resolver === "retired" ||
    health?.forward_disposition === "unmeasured"
  );
}

function successfulRuntimeEvidence(connection: JsonObject): boolean {
  const lastSuccess = asObject(connection.last_successful_run);
  const lastRun = asObject(connection.last_run);
  return (
    (typeof lastSuccess?.status === "string" && SUCCESSFUL_RUN_STATUSES.has(lastSuccess.status)) ||
    (typeof lastRun?.status === "string" && SUCCESSFUL_RUN_STATUSES.has(lastRun.status))
  );
}

function latestRunFailed(connection: JsonObject): boolean {
  const lastRun = asObject(connection.last_run);
  return typeof lastRun?.status === "string" && FAILED_RUN_STATUSES.has(lastRun.status);
}

function committedCheckpoint(value: unknown): boolean {
  const checkpoint = asNonEmptyString(value);
  return checkpoint !== null && !CHECKPOINT_UNKNOWN_VALUES.has(checkpoint.toLowerCase());
}

function currentProjectionEvidence(connection: JsonObject): boolean {
  const snapshot = nestedObject(connection, "record_snapshot");
  const manifest = nestedObject(connection, "manifest_declaration");
  const terminal = nestedObject(connection, "terminal_facts");
  return (
    snapshot?.state === "current" &&
    (manifest === null || manifest.state === "current") &&
    (terminal === null || terminal.state === "current")
  );
}

function explicitVerifiedEmpty(connection: JsonObject, report: JsonObject): boolean {
  const candidates: unknown[] = [
    report.verified_empty,
    report.empty_proof,
    report.empty_evidence,
    connection.terminal_setup_disposition,
    nestedObject(connection, "terminal_facts")?.disposition,
  ];
  return candidates.some((candidate) => {
    if (candidate === true || candidate === "verified_empty" || candidate === "verified") {
      return true;
    }
    const object = asObject(candidate);
    const kind =
      asNonEmptyString(object?.kind) ?? asNonEmptyString(object?.state) ?? asNonEmptyString(object?.disposition);
    return kind === "verified_empty" || kind === "verified";
  });
}

function committedCoverageProof(report: JsonObject): boolean {
  const { considered, covered } = report;
  return (
    report.coverage_condition === "complete" &&
    (report.forward_disposition === undefined || report.forward_disposition === "complete") &&
    typeof report.coverage_strategy === "string" &&
    KNOWN_COVERAGE_STRATEGIES.has(report.coverage_strategy) &&
    typeof report.freshness_strategy === "string" &&
    KNOWN_FRESHNESS_STRATEGIES.has(report.freshness_strategy) &&
    committedCheckpoint(report.checkpoint) &&
    typeof considered === "number" &&
    Number.isFinite(considered) &&
    considered >= 0 &&
    typeof covered === "number" &&
    Number.isFinite(covered) &&
    covered >= 0 &&
    covered <= considered
  );
}

function isGreenStream(
  connection: JsonObject,
  stream: ManifestStream,
  report: JsonObject | undefined,
  record: JsonObject | undefined
): { green: boolean; reason: string } {
  if (!report) {
    return { green: false, reason: "no collection report for the manifest-declared stream" };
  }
  if (!successfulRuntimeEvidence(connection)) {
    return { green: false, reason: "no current successful runtime evidence" };
  }
  if (!currentProjectionEvidence(connection)) {
    return { green: false, reason: "record or manifest projection is not current" };
  }
  const considered = report.considered as number;
  const covered = report.covered as number;
  const verifiedEmpty = considered === 0 && covered === 0 && explicitVerifiedEmpty(connection, report);
  if (!(committedCoverageProof(report) || verifiedEmpty)) {
    return { green: false, reason: "committed coverage or explicit verified-empty proof is incomplete" };
  }
  if (verifiedEmpty) {
    return { green: true, reason: "successful runtime evidence plus explicit verified-empty proof" };
  }
  if (considered === 0 || covered === 0) {
    return { green: false, reason: "zero evidence is not explicitly verified empty" };
  }
  const recordCount = record?.record_count;
  if (typeof recordCount !== "number" || !Number.isFinite(recordCount) || recordCount < 0) {
    return { green: false, reason: "records are present without a usable retained-record projection" };
  }
  if (record?.count_state === "stale" || record?.count_state === "unobserved" || record?.count_state === "unknown") {
    return { green: false, reason: "retained-record projection is not authoritative" };
  }
  if (record?.declaration_state !== undefined && record.declaration_state !== "declared") {
    return { green: false, reason: "retained-record declaration is not current" };
  }
  if (recordCount === 0 && !explicitVerifiedEmpty(connection, report)) {
    return { green: false, reason: "record count zero has no explicit verified-empty proof" };
  }
  return { green: true, reason: `successful runtime evidence covers ${stream.name}` };
}

function defaultDomEvidence(
  connections: readonly JsonObject[],
  input: StreamHealthAuthorityInput
): OwnerSourcesDomEvidence {
  return {
    authenticated: true,
    connectionIds: connections
      .filter((connection) => !connectionIsSynthetic(connection, resolveManifest(connection, input)))
      .map(connectionId)
      .filter((id): id is string => id !== null),
    paginationComplete: true,
    resolved: true,
    suspense: false,
  };
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function sourceHrefParts(href: string): string[] {
  try {
    const url = new URL(decodeHtml(href), "https://pdpp.invalid");
    return url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return [];
  }
}

/** Parse the resolved, authenticated owner `/sources` HTML without a browser. */
export function parseOwnerSourcesDom(html: string): OwnerSourcesDomEvidence {
  const source = String(html);
  const authFailure = AUTH_FAILURE_PATTERN.test(source);
  const suspense =
    SUSPENSE_TESTID_PATTERN.test(source) || SUSPENSE_BUSY_PATTERN.test(source) || SUSPENSE_CLASS_PATTERN.test(source);
  const connectionIds = new Set<string>();
  const nextPageHrefs: string[] = [];
  const streamKeys: { connectionId: string; stream: string }[] = [];
  for (const match of source.matchAll(HREF_PATTERN)) {
    const href = match[2] ?? "";
    const parts = sourceHrefParts(href);
    if (parts[0] !== "sources") {
      continue;
    }
    if (parts.length === 2 && parts[1] !== "add") {
      connectionIds.add(parts[1] as string);
    }
    if (parts.length === 3 && parts[1] !== "add") {
      connectionIds.add(parts[1] as string);
      streamKeys.push({ connectionId: parts[1] as string, stream: parts[2] as string });
    }
    if (PAGE_CURSOR_PATTERN.test(href)) {
      nextPageHrefs.push(decodeHtml(href));
    }
  }
  const explicitEmpty = EXPLICIT_EMPTY_PATTERN.test(source);
  const resolved = !(authFailure || suspense) && (explicitEmpty || connectionIds.size > 0);
  let reason: string | null = null;
  if (authFailure) {
    reason = "owner authentication was not resolved";
  } else if (suspense) {
    reason = "owner page is still suspended/loading";
  }
  return {
    authenticated: !authFailure,
    connectionIds: [...connectionIds],
    nextPageHrefs,
    paginationComplete: true,
    resolved,
    streamKeys,
    suspense,
    reason,
  };
}

function normalizeDom(
  dom: StreamHealthAuthorityInput["dom"],
  connections: readonly JsonObject[],
  input: StreamHealthAuthorityInput
): OwnerSourcesDomEvidence {
  if (typeof dom === "string") {
    return parseOwnerSourcesDom(dom);
  }
  if (dom && typeof dom === "object") {
    return dom;
  }
  return defaultDomEvidence(connections, input);
}

function emptyClassCounts(): Record<StreamHealthClass, number> {
  return Object.fromEntries(STREAM_HEALTH_CLASSES.map((name) => [name, 0])) as Record<StreamHealthClass, number>;
}

function addFinding(
  findings: StreamHealthFinding[],
  counts: Record<StreamHealthClass, number>,
  input: Omit<StreamHealthFinding, "green">
): void {
  const finding = { ...input, green: input.class === "green" };
  findings.push(finding);
  counts[input.class] += 1;
}

function gateRevision(input: StreamHealthAuthorityInput): {
  gate: StreamHealthAuthorityResult["gates"]["revision"];
  receipt: StreamHealthAuthorityResult["revisionReceipt"];
} {
  if (!input.revision) {
    return {
      gate: "not_required",
      receipt: { exact: true, observedDom: null, observedSummaries: null, sha: null },
    };
  }
  const observedSummaries = input.revision.summaries?.trim() || null;
  const observedDom = input.revision.dom?.trim() || null;
  const expected = input.revision.expected?.trim() || null;
  const sha = input.revision.sha?.trim() || input.expectedSha?.trim() || null;
  const exact = Boolean(
    observedSummaries &&
      observedDom &&
      observedSummaries === observedDom &&
      (!expected || observedSummaries === expected)
  );
  const rawRevisionSuffix = observedSummaries?.split("+").at(-1) ?? null;
  const revisionSuffix = rawRevisionSuffix?.endsWith(".dirty")
    ? rawRevisionSuffix.slice(0, -".dirty".length)
    : rawRevisionSuffix;
  const shaMatches = !sha || observedSummaries === sha || revisionSuffix === sha;
  return {
    gate: exact && shaMatches ? "exact" : "inconclusive",
    receipt: { exact: exact && shaMatches, observedDom, observedSummaries, sha },
  };
}

function connectionAssessment(connection: JsonObject, input: StreamHealthAuthorityInput): ConnectionAssessment {
  const manifest = resolveManifest(connection, input);
  const unknownVocabulary = [...checkConnectionVocabulary(connection), ...manifestVocabulary(manifest)];
  return {
    duplicateManifest: manifest ? manifest.duplicate : false,
    manifest,
    projectionDisagreement: projectionAgreement(connection, manifest),
    unknownVocabulary,
  };
}

function classForStream(
  connection: JsonObject,
  stream: ManifestStream,
  report: JsonObject | undefined,
  record: JsonObject | undefined,
  assessment: ConnectionAssessment
): { class: StreamHealthClass; reason: string; denominator: boolean } {
  const state = lifecycle(connection);
  const denominator = state === "active";
  if (isExplicitSynthetic(stream.raw) || connectionIsSynthetic(connection, assessment.manifest)) {
    return {
      class: "synthetic_fixture",
      denominator: false,
      reason: "explicit catalog/test-fixture metadata excludes this stream",
    };
  }
  if (state === "revoked") {
    return {
      class: "revoked",
      denominator: false,
      reason: "revoked owner connection is outside the active denominator",
    };
  }
  if (streamIsOptionalUnsupported(stream)) {
    return {
      class: "optional_unsupported",
      denominator: false,
      reason: "optional unsupported manifest stream is outside the score",
    };
  }
  if (assessment.unknownVocabulary.length > 0) {
    return { class: "unknown_vocabulary", denominator, reason: assessment.unknownVocabulary.join("; ") };
  }
  if (assessment.projectionDisagreement) {
    return { class: "projection_disagreement", denominator, reason: assessment.projectionDisagreement };
  }
  if (state !== "active") {
    if (state === "unknown") {
      return { class: "unknown_vocabulary", denominator: false, reason: "connection lifecycle status is unknown" };
    }
    return { class: "owner_interaction", denominator: false, reason: `connection lifecycle is ${state}` };
  }
  if (needsOwnerInteraction(connection)) {
    return {
      class: "owner_interaction",
      denominator,
      reason: "owner interaction is required before collection can be accepted",
    };
  }
  if (hasActiveBoundedWork(connection)) {
    return { class: "active_bounded_work", denominator, reason: "bounded runtime work is still active" };
  }
  if (isProviderConfigBlocked(connection)) {
    return {
      class: "provider_config_blocked",
      denominator,
      reason: "provider or deployment configuration blocks collection",
    };
  }
  if (latestRunFailed(connection) || isFailed(connection)) {
    return { class: "failed", denominator, reason: "latest runtime evidence reports failure" };
  }
  if (isStale(connection, record)) {
    return { class: "stale", denominator, reason: "runtime or retained projection is stale" };
  }
  if (isOwnerStateUnobserved(connection)) {
    return { class: "unobserved", denominator, reason: "owner/runtime disposition is unmeasured" };
  }
  const green = isGreenStream(connection, stream, report, record);
  if (green.green) {
    return { class: "green", denominator, reason: green.reason };
  }
  return { class: "unobserved", denominator, reason: green.reason };
}

function compareDom(
  dom: OwnerSourcesDomEvidence,
  connections: readonly JsonObject[],
  input: StreamHealthAuthorityInput,
  findings: StreamHealthFinding[],
  counts: Record<StreamHealthClass, number>
): StreamHealthAuthorityResult["domAgreement"] {
  const observed = [...new Set(dom.connectionIds.map((id) => id.trim()).filter(Boolean))].sort();
  const expected = [
    ...new Set(
      connections
        .filter((connection) => !connectionIsSynthetic(connection, resolveManifest(connection, input)))
        .map(connectionId)
        .filter((id): id is string => id !== null)
    ),
  ].sort();
  if (!dom.resolved || dom.authenticated === false || dom.suspense === true) {
    return {
      extraConnectionIds: [],
      missingConnectionIds: expected,
      observedConnectionIds: observed,
      resolved: false,
      status: "inconclusive",
    };
  }
  const expectedSet = new Set(expected);
  const observedSet = new Set(observed);
  const missingConnectionIds = expected.filter((id) => !observedSet.has(id));
  const extraConnectionIds = observed.filter((id) => !expectedSet.has(id));
  if (missingConnectionIds.length > 0 || extraConnectionIds.length > 0) {
    addFinding(findings, counts, {
      class: "projection_disagreement",
      connection_id: null,
      connector_id: null,
      denominator: false,
      reason: `authenticated owner DOM differs from owner connection inventory (missing=${missingConnectionIds.length}, extra=${extraConnectionIds.length})`,
      stream: "<owner-dom>",
    });
    return {
      extraConnectionIds,
      missingConnectionIds,
      observedConnectionIds: observed,
      resolved: true,
      status: "disagree",
    };
  }
  return { extraConnectionIds, missingConnectionIds, observedConnectionIds: observed, resolved: true, status: "agree" };
}

function gateFindings(
  input: StreamHealthAuthorityInput,
  dom: OwnerSourcesDomEvidence,
  revisionGate: StreamHealthAuthorityResult["gates"]["revision"],
  vocabularyUnknown: boolean,
  findings: StreamHealthFinding[],
  counts: Record<StreamHealthClass, number>
): StreamHealthAuthorityResult["gates"] {
  const authResolved = input.auth?.resolved !== false && input.auth?.authenticated !== false;
  const paginationComplete = input.paginationComplete !== false && dom.paginationComplete !== false;
  if (!authResolved) {
    addFinding(findings, counts, {
      class: "inconclusive_auth",
      connection_id: null,
      connector_id: null,
      denominator: false,
      reason: "owner authentication was not resolved",
      stream: "<audit>",
    });
  }
  if (!dom.resolved || dom.authenticated === false || dom.suspense === true) {
    addFinding(findings, counts, {
      class: dom.authenticated === false ? "inconclusive_auth" : "inconclusive_suspense",
      connection_id: null,
      connector_id: null,
      denominator: false,
      reason: dom.reason ?? "authenticated owner DOM did not resolve",
      stream: "<owner-dom>",
    });
  }
  if (!paginationComplete) {
    addFinding(findings, counts, {
      class: "inconclusive_pagination",
      connection_id: null,
      connector_id: null,
      denominator: false,
      reason: "owner connection or owner DOM pagination did not complete",
      stream: "<pagination>",
    });
  }
  if (revisionGate === "inconclusive") {
    addFinding(findings, counts, {
      class: "inconclusive_revision",
      connection_id: null,
      connector_id: null,
      denominator: false,
      reason: "summary and authenticated DOM revision receipt is missing or disagrees",
      stream: "<revision>",
    });
  }
  if (vocabularyUnknown) {
    addFinding(findings, counts, {
      class: "unknown_vocabulary",
      connection_id: null,
      connector_id: null,
      denominator: false,
      reason: "a closed health vocabulary contained an unknown value",
      stream: "<vocabulary>",
    });
  }
  return {
    auth: authResolved ? "resolved" : "inconclusive",
    dom: dom.resolved && dom.authenticated !== false && !dom.suspense ? "resolved" : "inconclusive",
    pagination: paginationComplete ? "complete" : "inconclusive",
    revision: revisionGate,
    vocabulary: vocabularyUnknown ? "inconclusive" : "known",
  };
}

function resultStatus(
  findings: readonly StreamHealthFinding[],
  gates: StreamHealthAuthorityResult["gates"]
): "fail" | "inconclusive" | "pass" {
  const hardClasses = new Set<StreamHealthClass>([
    "owner_interaction",
    "provider_config_blocked",
    "unobserved",
    "failed",
    "stale",
    "projection_disagreement",
    "manifest_unavailable",
  ]);
  if (findings.some((finding) => hardClasses.has(finding.class) && finding.denominator)) {
    return "fail";
  }
  if (findings.some((finding) => finding.class === "projection_disagreement")) {
    return "fail";
  }
  if (
    gates.auth === "inconclusive" ||
    gates.dom === "inconclusive" ||
    gates.pagination === "inconclusive" ||
    gates.revision === "inconclusive" ||
    gates.vocabulary === "inconclusive" ||
    findings.some((finding) => finding.class === "manifest_unavailable") ||
    findings.some(
      (finding) =>
        finding.class === "active_bounded_work" ||
        finding.class === "owner_interaction" ||
        finding.class === "unknown_vocabulary" ||
        finding.class === "projection_disagreement"
    )
  ) {
    return "inconclusive";
  }
  return "pass";
}

interface AuthorityAggregation {
  counts: Record<StreamHealthClass, number>;
  findings: StreamHealthFinding[];
  seenConnectionIds: Set<string>;
}

interface ConnectionContribution {
  activeConnectionCount: number;
  productionStreamCount: number;
  syntheticFixtureCount: number;
  vocabularyUnknown: boolean;
}

function addManifestUnavailableFinding({
  aggregate,
  assessment,
  ownerConnectionId,
  ownerConnectorId,
  lifecycleState,
  syntheticConnection,
}: {
  aggregate: AuthorityAggregation;
  assessment: ConnectionAssessment;
  ownerConnectionId: string | null;
  ownerConnectorId: string | null;
  lifecycleState: ReturnType<typeof lifecycle>;
  syntheticConnection: boolean;
}): void {
  const manifestMissing = assessment.manifest ? assessment.manifest.missing : false;
  if (!(assessment.duplicateManifest || manifestMissing) || lifecycleState !== "active" || syntheticConnection) {
    return;
  }
  addFinding(aggregate.findings, aggregate.counts, {
    class: "manifest_unavailable",
    connection_id: ownerConnectionId,
    connector_id: ownerConnectorId,
    denominator: false,
    reason: assessment.duplicateManifest
      ? "multiple manifest projections disagree"
      : "manifest streams are missing or malformed",
    stream: "<manifest>",
  });
}

function evaluateDeclaredStreams({
  aggregate,
  assessment,
  connection,
  ownerConnectionId,
  ownerConnectorId,
  lifecycleState,
  syntheticConnection,
}: {
  aggregate: AuthorityAggregation;
  assessment: ConnectionAssessment;
  connection: JsonObject;
  ownerConnectionId: string | null;
  ownerConnectorId: string | null;
  lifecycleState: ReturnType<typeof lifecycle>;
  syntheticConnection: boolean;
}): Pick<ConnectionContribution, "productionStreamCount" | "syntheticFixtureCount"> {
  const streams = assessment.manifest ? assessment.manifest.streams : [];
  if (assessment.manifest?.missing && !syntheticConnection) {
    return { productionStreamCount: 0, syntheticFixtureCount: 0 };
  }
  if (streams.length === 0) {
    if (syntheticConnection) {
      const syntheticStreams = declaredConnectionStreams(connection);
      for (const stream of syntheticStreams) {
        addFinding(aggregate.findings, aggregate.counts, {
          class: "synthetic_fixture",
          connection_id: ownerConnectionId,
          connector_id: ownerConnectorId,
          denominator: false,
          reason: "explicit catalog/test-fixture metadata excludes this stream",
          stream,
        });
      }
      return { productionStreamCount: 0, syntheticFixtureCount: syntheticStreams.length };
    }
    if (lifecycleState !== "revoked" && !syntheticConnection) {
      addFinding(aggregate.findings, aggregate.counts, {
        class: "manifest_unavailable",
        connection_id: ownerConnectionId,
        connector_id: ownerConnectorId,
        denominator: false,
        reason: "no manifest-declared production stream is available",
        stream: "<manifest>",
      });
    }
    return { productionStreamCount: 0, syntheticFixtureCount: 0 };
  }

  const reports = namedEntries(connection, "collection_report");
  const records = namedEntries(connection, "stream_records");
  let productionStreamCount = 0;
  let syntheticFixtureCount = 0;
  for (const stream of streams) {
    const optionalUnsupported = streamIsOptionalUnsupported(stream);
    const synthetic = isExplicitSynthetic(stream.raw) || syntheticConnection;
    if (synthetic) {
      syntheticFixtureCount += 1;
    }
    if (!synthetic && lifecycleState === "active" && !optionalUnsupported) {
      productionStreamCount += 1;
    }
    const result = classForStream(
      connection,
      stream,
      reports.map.get(stream.name),
      records.map.get(stream.name),
      assessment
    );
    addFinding(aggregate.findings, aggregate.counts, {
      class: result.class,
      connection_id: ownerConnectionId,
      connector_id: ownerConnectorId,
      denominator: result.denominator && !optionalUnsupported && !synthetic,
      reason: result.reason,
      stream: stream.name,
    });
  }
  return { productionStreamCount, syntheticFixtureCount };
}

function evaluateConnection(
  connection: JsonObject,
  input: StreamHealthAuthorityInput,
  aggregate: AuthorityAggregation
): ConnectionContribution {
  const connectionIdValue = connectionId(connection);
  const connectorIdValue = connectionConnectorId(connection);
  if (connectionIdValue && aggregate.seenConnectionIds.has(connectionIdValue)) {
    addFinding(aggregate.findings, aggregate.counts, {
      class: "projection_disagreement",
      connection_id: connectionIdValue,
      connector_id: connectorIdValue,
      denominator: false,
      reason: "owner connection inventory contains a duplicate connection id",
      stream: "<connection>",
    });
    return { activeConnectionCount: 0, productionStreamCount: 0, syntheticFixtureCount: 0, vocabularyUnknown: false };
  }
  if (connectionIdValue) {
    aggregate.seenConnectionIds.add(connectionIdValue);
  }

  const assessment = connectionAssessment(connection, input);
  const { manifest, unknownVocabulary } = assessment;
  const syntheticConnection = connectionIsSynthetic(connection, manifest);
  const lifecycleState = lifecycle(connection);
  if (!(connectionIdValue || syntheticConnection)) {
    addFinding(aggregate.findings, aggregate.counts, {
      class: "projection_disagreement",
      connection_id: null,
      connector_id: connectorIdValue,
      denominator: false,
      reason: "owner connection inventory row has no stable connection id",
      stream: "<connection>",
    });
  }
  addManifestUnavailableFinding({
    aggregate,
    assessment,
    ownerConnectionId: connectionIdValue,
    ownerConnectorId: connectorIdValue,
    lifecycleState,
    syntheticConnection,
  });
  const streamContribution = evaluateDeclaredStreams({
    aggregate,
    assessment,
    connection,
    ownerConnectionId: connectionIdValue,
    ownerConnectorId: connectorIdValue,
    lifecycleState,
    syntheticConnection,
  });
  return {
    activeConnectionCount: lifecycleState === "active" && !syntheticConnection ? 1 : 0,
    productionStreamCount: streamContribution.productionStreamCount,
    syntheticFixtureCount: streamContribution.syntheticFixtureCount,
    vocabularyUnknown: unknownVocabulary.length > 0,
  };
}

/** Evaluate the final score from explicit owner/catalog/evidence surfaces. */
export function evaluateStreamHealthAuthority(input: StreamHealthAuthorityInput): StreamHealthAuthorityResult {
  const rawConnections = Array.isArray(input.connections) ? input.connections : [];
  const connections: JsonObject[] = [];
  const findings: StreamHealthFinding[] = [];
  const counts = emptyClassCounts();
  for (const [index, value] of rawConnections.entries()) {
    const connection = asObject(value);
    if (connection) {
      connections.push(connection);
      continue;
    }
    addFinding(findings, counts, {
      class: "projection_disagreement",
      connection_id: null,
      connector_id: null,
      denominator: false,
      reason: `owner connection inventory row ${index} is malformed`,
      stream: "<connection>",
    });
  }
  const dom = normalizeDom(input.dom, connections, input);
  const revision = gateRevision(input);
  let activeConnectionCount = 0;
  let productionStreamCount = 0;
  let syntheticFixtureCount = 0;
  let vocabularyUnknown = false;
  const aggregate: AuthorityAggregation = { counts, findings, seenConnectionIds: new Set<string>() };

  for (const connection of connections) {
    const contribution = evaluateConnection(connection, input, aggregate);
    activeConnectionCount += contribution.activeConnectionCount;
    productionStreamCount += contribution.productionStreamCount;
    syntheticFixtureCount += contribution.syntheticFixtureCount;
    vocabularyUnknown = vocabularyUnknown || contribution.vocabularyUnknown;
  }

  const domAgreement = compareDom(dom, connections, input, findings, counts);
  const gates = gateFindings(input, dom, revision.gate, vocabularyUnknown, findings, counts);
  const numerator = findings.filter((finding) => finding.class === "green" && finding.denominator).length;
  const denominator = findings.filter((finding) => finding.denominator).length;
  const percentage = denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 100;
  const score = { denominator, numerator, percentage, ratio: `${numerator}/${denominator}` };
  const status = resultStatus(findings, gates);
  const result: StreamHealthAuthorityResult = {
    activeConnectionCount,
    classCounts: counts,
    connectionCount: rawConnections.length,
    domAgreement,
    findings,
    gates,
    numerator,
    ok: status === "pass",
    perClass: counts,
    productionStreamCount,
    revisionReceipt: revision.receipt,
    score,
    status,
    streams: findings,
    syntheticFixtureCount,
  };
  return result;
}

/** Array-form convenience API for tests and small read-only callers. */
export function auditStreamHealthAuthority(
  connections: readonly unknown[],
  manifests: readonly unknown[] = [],
  options: Omit<StreamHealthAuthorityInput, "catalog" | "connections" | "manifests"> = {}
): StreamHealthAuthorityResult {
  return evaluateStreamHealthAuthority({
    ...options,
    connections,
    ...(manifests.length > 0 ? { manifests } : {}),
  });
}

export const auditFinalStreamHealth = evaluateStreamHealthAuthority;
