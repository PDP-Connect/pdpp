// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Final, pure stream-health acceptance authority.
 *
 * This module owns the acceptance score: one scored unit is one active
 * owner connection crossed with one production stream declared by its
 * manifest. A count, checkpoint, or green pill is never a substitute for a
 * successful runtime proof and committed coverage (or an explicit verified
 * empty proof).
 */

import {
  type CoverageProofStrategy,
  evaluateStreamCoherence,
} from "../../packages/reference-contract/src/evidence/index.ts";

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
const KNOWN_REMOTE_SURFACE_AXES = new Set(["failed", "idle", "leased", "none", "unknown", "waiting"]);
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
  "error",
  "failed",
  "in_progress",
  "leased",
  "rejected",
  "released",
  "started",
  "starting_surface",
  "surface_failed",
  "succeeded",
  "succeeded_with_gaps",
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
const FAILED_RUN_STATUSES = new Set([
  "abandoned",
  "cancelled",
  "error",
  "expired",
  "failed",
  "rejected",
  "surface_failed",
]);
const OWNER_CANCEL_TERMINAL_REASONS = new Set(["owner_cancel_forced", "owner_cancelled"]);
const ACTIVE_RUN_STATUSES = new Set(["active", "in_progress", "leased", "started", "starting_surface"]);
const ACCEPTED_ABSENCE_POLICIES = new Set(["deferred", "inventory_only", "unavailable", "unsupported"]);
const KNOWN_CONDITION_TYPES = new Set([
  "AttentionClear",
  "BacklogClear",
  "CollectionSucceeded",
  "CredentialContinuity",
  "CredentialsValid",
  "Fresh",
  "LocalExporterAvailable",
  "ProjectionReliable",
  "RemoteSurfaceAvailable",
  "RetryPolicyClear",
  "RuntimeAvailable",
  "ScheduleEligible",
  "SourceCoverageComplete",
]);
const KNOWN_CONDITION_STATUSES = new Set(["false", "not_applicable", "true", "unknown"]);
const KNOWN_CONDITION_SEVERITIES = new Set(["blocked", "error", "info", "warning"]);
const KNOWN_CONDITION_ORIGINS = new Set([
  "connector",
  "local_device",
  "operator",
  "read_model",
  "readiness",
  "remote_surface",
  "runtime",
  "scheduler",
]);
const KNOWN_CONDITION_SENSITIVITIES = new Set(["owner", "public", "secret_redacted"]);
const KNOWN_EVIDENCE_REASON_CODES = new Set([
  "manifest_generation_changed",
  "manifest_invalid",
  "manifest_unavailable",
  "record_checkpoint_lag",
  "record_snapshot_failed",
  "repair_lock_unavailable",
  "retained_bytes_unavailable",
  "summary_evidence_unavailable",
  "summary_missing",
  "terminal_facts_historical",
  "terminal_fold_failed",
]);
const KNOWN_CONDITION_REASONS = new Set([
  "attention_expired",
  "attention_required",
  "backoff_expired",
  "browser_runtime_not_configured",
  "collection_failed",
  "collection_not_observed",
  "collection_succeeded",
  "collection_succeeded_local_device",
  "coverage_unknown",
  "credential_continuity_not_applicable",
  "credential_continuity_proven",
  "credential_continuity_unproven",
  "credential_rejected",
  "credential_required",
  "credentials_accepted",
  "credentials_not_probed",
  "external_tool_unavailable",
  "interaction_timeout",
  "connector_reported_failed",
  "credentials_required",
  "fresh",
  "freshness_unknown",
  "local_exporter_active",
  "local_exporter_dead_letter_backlog",
  "local_exporter_idle",
  "local_exporter_not_applicable",
  "local_exporter_stale_heartbeat",
  "local_exporter_stale_pending",
  "local_exporter_stalled",
  "local_exporter_state_read_failed",
  "local_exporter_transient_upload_failure",
  "local_exporter_unknown",
  "missing_browser_surface",
  "no_active_backoff",
  "no_open_attention",
  "outbox_active",
  "outbox_dead_letter_backlog",
  "outbox_idle",
  "outbox_not_applicable",
  "outbox_stale_heartbeat",
  "outbox_stale_pending",
  "outbox_stalled",
  "outbox_state_read_failed",
  "outbox_transient_upload_failure",
  "outbox_unknown",
  "projection_current",
  "projection_unreliable",
  "remote_surface_available",
  "remote_surface_failed",
  "remote_surface_not_required",
  "remote_surface_unknown",
  "runtime_available",
  "runtime_binding_missing",
  "runtime_not_managed",
  "runtime_state_unknown",
  "runtime_unavailable",
  "retry_not_applicable",
  "schedule_enabled",
  "schedule_not_configured",
  "schedule_paused",
  "scheduler_backoff_active",
  "scheduler_error",
  "stale",
  "stale_assisted_refresh",
  "stale_manual_refresh",
  ...KNOWN_COVERAGE_AXES,
]);
const KNOWN_CONDITION_REMEDIATION_ACTIONS = new Set([
  "check_runtime",
  "clear_backlog",
  "refresh_credentials",
  "retry_by_runtime",
  "satisfy_attention",
  "update_connector",
  "wait",
]);
const KNOWN_OWNER_ACTION_SURFACES = new Set([
  "browser_session",
  "local_device",
  "maintainer",
  "none",
  "provider_interaction",
  "runtime_retry",
  "schedule",
  "stored_credential",
]);
const KNOWN_NEXT_ACTION_NOTIFICATION_STATES = new Set(["acknowledged", "failed", "pending", "sent", "suppressed"]);
const KNOWN_NEXT_ACTION_OWNER_ACTIONS = new Set(["act_elsewhere", "operate_attachment", "provide_value"]);
const KNOWN_NEXT_ACTION_RESPONSE_CONTRACTS = new Set(["response_required", "none"]);
const KNOWN_NEXT_ACTION_SOURCES = new Set(["none", "schedule_fallback", "structured"]);
const KNOWN_SYNC_TARGET_KINDS = new Set(["sync"]);
const KNOWN_LOCAL_DEVICE_TARGET_KINDS = new Set(["local_device"]);
const KNOWN_RENDERED_CHANNELS = new Set(["advisory", "attention", "calm"]);
const KNOWN_ANNOTATION_KINDS = new Set(["activity", "attention", "coverage", "freshness", "outbox", "schedule"]);
const KNOWN_REQUIRED_ACTION_KINDS = new Set([
  "add_info",
  "backfill",
  "code_fix",
  "contact_support",
  "reattach_schedule",
  "reauth",
  "refresh_now",
  "retry_gap",
  "wait",
]);
const KNOWN_ACTION_AUDIENCES = new Set(["maintainer", "none", "owner"]);
const KNOWN_ACTION_URGENCIES = new Set(["now", "overdue", "soon", "verifying"]);
const KNOWN_VERDICT_LABELS = new Set([
  "Can't collect",
  "Checking",
  "Degraded",
  "Healthy",
  "Needs refresh",
  "Not measured",
  "Syncing",
]);
const KNOWN_SATISFACTION_KINDS = new Set([
  "attention_resolved",
  "backfill_window_covered",
  "confirming_run_succeeded",
  "credential_present_and_unrejected",
  "gap_recovered",
  "none",
  "schedule_attached_and_enabled",
]);
const KNOWN_PROGRESS_MODES = new Set(["deferred", "local_device", "manual", "scheduled"]);
const KNOWN_SUPPRESSED_SIGNAL_KINDS = new Set(["cooldown", "drain", "runtime_fault", "syncing"]);
const KNOWN_REMEDIATION_KINDS = new Set(["local_collector_recovery"]);
const KNOWN_REMEDIATION_CAUSES = new Set([
  "dead_letter_backlog",
  "stale_heartbeat",
  "stale_pending",
  "state_read_failed",
  "stalled_unknown",
  "transient_upload_failure",
]);
const KNOWN_REMEDIATION_COMMAND_KINDS = new Set([
  "local_collector_doctor",
  "local_collector_recover_apply",
  "local_collector_recover_preview",
  "local_collector_retry_dead_letters_apply",
  "local_collector_retry_dead_letters_preview",
  "local_collector_run",
]);
const EXPLICIT_TEST_ENVIRONMENTS = new Set(["fixture", "test", "testing"]);
const EXPLICIT_SYNTHETIC_KINDS = new Set(["fixture", "synthetic", "synthetic_fixture", "test_fixture"]);
const CHECKPOINT_UNKNOWN_VALUES = new Set(["", "none", "unknown", "unobserved", "pending"]);
const AUTH_FAILURE_PATTERN = /(?:\/owner\/login|name=["']password["']|sign\s+in\s+to\s+continue|owner\s+login)/i;
const SUSPENSE_TESTID_PATTERN = /data-testid=["'][^"']*(?:loading|suspense)[^"']*["']/i;
const SUSPENSE_BUSY_PATTERN = /aria-busy=["']true["']/i;
const SUSPENSE_CLASS_PATTERN = /(?:skeleton|animate-pulse)/i;
const DOM_REVISION_PATTERN = /\bdata-pdpp-reference-revision=(['"])(.*?)\1/i;
const HREF_PATTERN = /\bhref=(['"])(.*?)\1/gi;
const PAGE_CURSOR_PATTERN = /[?&]page_cursor=/;
const EXPLICIT_EMPTY_PATTERN = /data-testid=["']sources-empty["']/i;
const HTML_TAG_PATTERN = /<[^>]+>/g;
const NON_RENDERED_HTML_PATTERN =
  /<!--[\s\S]*?-->|<(?:script|style|template|noscript)\b[\s\S]*?<\/(?:script|style|template|noscript)>|<[^>]*(?:\bhidden\b|aria-hidden\s*=\s*["']true["']|style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["'])[^>]*>[\s\S]*?<\/[^>]+>/gi;
const ATTRIBUTE_PATTERN = /(?:^|\s)([A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*=\s*(?:(["'])(.*?)\2|([^\s>]+)))?/g;
const ROW_ATTRIBUTE_NAMES = new Set([
  "data-pdpp-source-row",
  "data-pdpp-selected-source",
  "data-pdpp-stream-row",
  "data-connection-id",
  "data-stream-name",
  "href",
]);

export interface OwnerSourcesDomEvidence {
  authenticated: boolean;
  connectionIds: readonly string[];
  nextPageHrefs: readonly string[];
  paginationComplete: boolean;
  reason?: string | null;
  renderedRows: boolean;
  resolved: boolean;
  revision?: string | null;
  selectedConnectionId?: string | null;
  streamKeys: readonly { connectionId: string; stream: string }[];
  suspense: boolean;
}

export interface StreamHealthAuthorityInput {
  auth: { authenticated: boolean; mode: string; resolved: boolean };
  connections: readonly unknown[];
  dom: OwnerSourcesDomEvidence | string | null;
  manifests: readonly unknown[];
  paginationComplete: boolean;
  revision: {
    dom: string | null;
    expected: string | null;
    sha: string | null;
    summaries: string | null;
  } | null;
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
  /** Structured manifest/summary coverage, independent of transport and rendered-DOM gates. */
  coverageStatus: "fail" | "inconclusive" | "pass";
  domAgreement: {
    extraConnectionIds: string[];
    extraStreamKeys: string[];
    invalidStreamKeys: string[];
    missingConnectionIds: string[];
    observedConnectionIds: string[];
    observedStreamKeys: string[];
    resolved: boolean;
    status: "agree" | "disagree" | "inconclusive";
  };
  findings: StreamHealthFinding[];
  gates: {
    auth: "resolved" | "inconclusive";
    dom: "resolved" | "inconclusive";
    pagination: "complete" | "inconclusive";
    revision: "exact" | "inconclusive";
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
  const names = new Set<string>();
  let invalid = false;
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) {
      const name = entry.trim();
      if (names.has(name)) {
        invalid = true;
      }
      names.add(name);
      streams.push({ name, raw: { name } });
      continue;
    }
    const object = asObject(entry);
    const name = asNonEmptyString(object?.name);
    if (!(object && name)) {
      invalid = true;
      continue;
    }
    if (names.has(name)) {
      invalid = true;
    }
    names.add(name);
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

function resolveManifest(connection: JsonObject, input: StreamHealthAuthorityInput): ResolvedManifest | null {
  const candidates = (input.manifests ?? [])
    .map(manifestFromCandidate)
    .filter((manifest): manifest is JsonObject => manifest !== null)
    .filter((manifest) => manifestMatches(connection, manifest));
  if (candidates.length > 0) {
    const chosen = candidates[0] as JsonObject;
    const parsed = streamDefinitions(chosen.streams);
    const duplicate =
      candidates.length > 1 ||
      candidates.some((candidate) => manifestFingerprint(candidate) !== manifestFingerprint(chosen));
    return {
      duplicate,
      missing: parsed.invalid || parsed.streams.length === 0,
      streams: parsed.streams,
      value: chosen,
    };
  }
  return null;
}

function checkVocabulary(value: unknown, allowed: ReadonlySet<string>, path: string, unknown: string[]): void {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "string" || !allowed.has(value)) {
    unknown.push(`${path}=${String(value)}`);
  }
}

function checkNextActionVocabulary(candidate: JsonObject | null, path: string, unknown: string[]): void {
  if (!candidate) {
    return;
  }
  checkVocabulary(
    candidate.notification_state,
    KNOWN_NEXT_ACTION_NOTIFICATION_STATES,
    `${path}.notification_state`,
    unknown
  );
  checkVocabulary(candidate.owner_action, KNOWN_NEXT_ACTION_OWNER_ACTIONS, `${path}.owner_action`, unknown);
  checkVocabulary(
    candidate.response_contract,
    KNOWN_NEXT_ACTION_RESPONSE_CONTRACTS,
    `${path}.response_contract`,
    unknown
  );
  checkVocabulary(candidate.source, KNOWN_NEXT_ACTION_SOURCES, `${path}.source`, unknown);
  if (
    candidate.action_target !== undefined &&
    candidate.action_target !== null &&
    typeof candidate.action_target !== "string"
  ) {
    unknown.push(`${path}.action_target=${String(candidate.action_target)}`);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the canonical condition envelope is intentionally checked field-by-field at this trust boundary.
function checkConditionVocabulary(health: JsonObject | null, unknown: string[]): void {
  const conditions = health?.conditions;
  if (conditions !== undefined && !Array.isArray(conditions)) {
    unknown.push("connection_health.conditions=<malformed>");
  }
  for (const [index, condition] of (Array.isArray(conditions) ? conditions : []).entries()) {
    const object = asObject(condition);
    if (!object) {
      unknown.push(`connection_health.conditions[${index}]=<malformed>`);
      continue;
    }
    const path = `connection_health.conditions[${index}]`;
    const required = [
      "current",
      "expires_at",
      "id",
      "message",
      "observed_at",
      "origin",
      "reason",
      "reason_code",
      "remediation",
      "sensitivity",
      "severity",
      "status",
      "type",
    ];
    for (const key of required) {
      if (!(key in object)) {
        unknown.push(`${path}.${key}=<missing>`);
      }
    }
    if (typeof object.current !== "boolean") {
      unknown.push(`${path}.current=<malformed>`);
    }
    if (object.expires_at !== null && typeof object.expires_at !== "string") {
      unknown.push(`${path}.expires_at=<malformed>`);
    }
    if (typeof object.id !== "string" || !object.id.trim()) {
      unknown.push(`${path}.id=<malformed>`);
    }
    if (typeof object.message !== "string") {
      unknown.push(`${path}.message=<malformed>`);
    }
    if (object.observed_at !== null && typeof object.observed_at !== "string") {
      unknown.push(`${path}.observed_at=<malformed>`);
    }
    if (typeof object.reason !== "string" || !object.reason.trim()) {
      unknown.push(`${path}.reason=<malformed>`);
    } else if (!KNOWN_CONDITION_REASONS.has(object.reason)) {
      unknown.push(`${path}.reason=${object.reason}`);
    }
    if (object.reason_code !== null && typeof object.reason_code !== "string") {
      unknown.push(`${path}.reason_code=<malformed>`);
    }
    if (object.remediation !== null && !asObject(object.remediation)) {
      unknown.push(`${path}.remediation=<malformed>`);
    }
    if (
      typeof object.sensitivity !== "string" ||
      typeof object.severity !== "string" ||
      typeof object.status !== "string"
    ) {
      unknown.push(`${path}=<malformed>`);
    }
    checkVocabulary(object.type, KNOWN_CONDITION_TYPES, `${path}.type`, unknown);
    checkVocabulary(object.status, KNOWN_CONDITION_STATUSES, `${path}.status`, unknown);
    checkVocabulary(object.severity, KNOWN_CONDITION_SEVERITIES, `${path}.severity`, unknown);
    checkVocabulary(object.origin, KNOWN_CONDITION_ORIGINS, `${path}.origin`, unknown);
    checkVocabulary(object.sensitivity, KNOWN_CONDITION_SENSITIVITIES, `${path}.sensitivity`, unknown);
    if (object.reason_code !== null && (typeof object.reason_code !== "string" || !object.reason_code.trim())) {
      unknown.push(`${path}.reason_code=<malformed>`);
    }
    const remediation = nestedObject(object, "remediation");
    checkVocabulary(remediation?.action, KNOWN_CONDITION_REMEDIATION_ACTIONS, `${path}.remediation.action`, unknown);
    checkVocabulary(
      nestedObject(remediation, "surface")?.kind,
      KNOWN_OWNER_ACTION_SURFACES,
      `${path}.remediation.surface.kind`,
      unknown
    );
  }
}

function checkEvidenceComponent(
  value: unknown,
  path: string,
  states: ReadonlySet<string>,
  unknown: string[],
  terminal = false
): void {
  const component = asObject(value);
  if (!component) {
    unknown.push(`${path}=<malformed projection evidence>`);
    return;
  }
  for (const key of terminal ? ["state", "event_seq", "as_of", "reason_code"] : ["state", "as_of", "reason_code"]) {
    if (!(key in component)) {
      unknown.push(`${path}.${key}=<missing>`);
    }
  }
  checkVocabulary(component.state, states, `${path}.state`, unknown);
  if (component.as_of !== null && (typeof component.as_of !== "string" || !component.as_of.trim())) {
    unknown.push(`${path}.as_of=<malformed>`);
  }
  if (
    component.reason_code !== null &&
    (typeof component.reason_code !== "string" || !KNOWN_EVIDENCE_REASON_CODES.has(component.reason_code))
  ) {
    unknown.push(`${path}.reason_code=${String(component.reason_code)}`);
  }
  if (terminal && component.event_seq !== null && !isNonNegativeInteger(component.event_seq)) {
    unknown.push(`${path}.event_seq=<malformed>`);
  }
}

function checkStructuredEvidence(connection: JsonObject, unknown: string[]): void {
  const states = new Set(["current", "failed", "stale", "unobserved", "unavailable"]);
  checkEvidenceComponent(
    connection.manifest_declaration,
    "manifest_declaration",
    new Set(["current", "failed", "unavailable"]),
    unknown
  );
  checkEvidenceComponent(connection.record_snapshot, "record_snapshot", states, unknown);
  checkEvidenceComponent(connection.terminal_facts, "terminal_facts", states, unknown, true);
}

function checkRequiredActionVocabulary(action: unknown, index: number, unknown: string[]): void {
  const object = asObject(action);
  const path = `rendered_verdict.required_actions[${index}]`;
  if (!object) {
    unknown.push(`${path}=<malformed>`);
    return;
  }
  checkVocabulary(object.kind, KNOWN_REQUIRED_ACTION_KINDS, `${path}.kind`, unknown);
  checkVocabulary(object.audience, KNOWN_ACTION_AUDIENCES, `${path}.audience`, unknown);
  checkVocabulary(object.urgency, KNOWN_ACTION_URGENCIES, `${path}.urgency`, unknown);
  checkVocabulary(
    nestedObject(object, "satisfied_when")?.kind,
    KNOWN_SATISFACTION_KINDS,
    `${path}.satisfied_when.kind`,
    unknown
  );
  checkVocabulary(nestedObject(object, "surface")?.kind, KNOWN_OWNER_ACTION_SURFACES, `${path}.surface.kind`, unknown);
  checkVocabulary(nestedObject(object, "target")?.kind, KNOWN_SYNC_TARGET_KINDS, `${path}.target.kind`, unknown);
  const remediation = nestedObject(object, "remediation");
  checkVocabulary(remediation?.kind, KNOWN_REMEDIATION_KINDS, `${path}.remediation.kind`, unknown);
  checkVocabulary(remediation?.cause, KNOWN_REMEDIATION_CAUSES, `${path}.remediation.cause`, unknown);
  checkVocabulary(
    nestedObject(remediation, "target")?.kind,
    KNOWN_LOCAL_DEVICE_TARGET_KINDS,
    `${path}.remediation.target.kind`,
    unknown
  );
  const commands = remediation?.commands;
  if (commands !== undefined && !Array.isArray(commands)) {
    unknown.push(`${path}.remediation.commands=<malformed>`);
  }
  for (const [commandIndex, command] of (Array.isArray(commands) ? commands : []).entries()) {
    checkVocabulary(
      asObject(command)?.kind,
      KNOWN_REMEDIATION_COMMAND_KINDS,
      `${path}.remediation.commands[${commandIndex}].kind`,
      unknown
    );
  }
  if (object.terminal !== undefined && typeof object.terminal !== "boolean") {
    unknown.push(`${path}.terminal=${String(object.terminal)}`);
  }
}

function checkRenderedAnnotations(annotations: unknown, unknown: string[]): void {
  if (annotations !== undefined && !Array.isArray(annotations)) {
    unknown.push("rendered_verdict.annotations=<malformed>");
  }
  for (const [index, annotation] of (Array.isArray(annotations) ? annotations : []).entries()) {
    checkVocabulary(
      asObject(annotation)?.kind,
      KNOWN_ANNOTATION_KINDS,
      `rendered_verdict.annotations[${index}].kind`,
      unknown
    );
  }
}

function checkRenderedActions(actions: unknown, unknown: string[]): void {
  if (actions !== undefined && !Array.isArray(actions)) {
    unknown.push("rendered_verdict.required_actions=<malformed>");
  }
  for (const [index, action] of (Array.isArray(actions) ? actions : []).entries()) {
    checkRequiredActionVocabulary(action, index, unknown);
  }
}

function checkRenderedStreams(verdictStreams: unknown, unknown: string[]): void {
  if (verdictStreams !== undefined && !Array.isArray(verdictStreams)) {
    unknown.push("rendered_verdict.streams=<malformed>");
  }
  for (const [index, stream] of (Array.isArray(verdictStreams) ? verdictStreams : []).entries()) {
    const object = asObject(stream);
    checkVocabulary(object?.coverage, KNOWN_COVERAGE_AXES, `rendered_verdict.streams[${index}].coverage`, unknown);
    checkVocabulary(
      object?.disposition,
      KNOWN_FORWARD_DISPOSITIONS,
      `rendered_verdict.streams[${index}].disposition`,
      unknown
    );
  }
}

function checkRenderedDetail(detail: JsonObject | null, unknown: string[]): void {
  checkVocabulary(detail?.state, KNOWN_HEALTH_STATES, "rendered_verdict.detail.state", unknown);
  checkVocabulary(
    detail?.forward_disposition,
    KNOWN_FORWARD_DISPOSITIONS,
    "rendered_verdict.detail.forward_disposition",
    unknown
  );
  const suppressed = detail?.suppressed;
  for (const [index, signal] of (Array.isArray(suppressed) ? suppressed : []).entries()) {
    checkVocabulary(
      asObject(signal)?.kind,
      KNOWN_SUPPRESSED_SIGNAL_KINDS,
      `rendered_verdict.detail.suppressed[${index}].kind`,
      unknown
    );
  }
}

function checkRenderedTrace(trace: JsonObject | null, unknown: string[]): void {
  checkVocabulary(trace?.tone_cause, KNOWN_PILL_TONES, "rendered_verdict.trace.tone_cause", unknown);
  checkVocabulary(
    trace?.primary_action_kind,
    KNOWN_REQUIRED_ACTION_KINDS,
    "rendered_verdict.trace.primary_action_kind",
    unknown
  );
  for (const [index, toneInput] of (Array.isArray(trace?.tone_inputs) ? trace.tone_inputs : []).entries()) {
    checkVocabulary(
      asObject(toneInput)?.tone,
      KNOWN_PILL_TONES,
      `rendered_verdict.trace.tone_inputs[${index}].tone`,
      unknown
    );
  }
}

function checkRenderedVerdictVocabulary(verdict: JsonObject | null, unknown: string[]): void {
  if (!verdict) {
    return;
  }
  const { annotations, channel, required_actions: actions, streams: verdictStreams } = verdict;
  const pill = nestedObject(verdict, "pill");
  checkVocabulary(pill?.tone, KNOWN_PILL_TONES, "rendered_verdict.pill.tone", unknown);
  checkVocabulary(pill?.label, KNOWN_VERDICT_LABELS, "rendered_verdict.pill.label", unknown);
  checkVocabulary(channel, KNOWN_RENDERED_CHANNELS, "rendered_verdict.channel", unknown);
  checkRenderedAnnotations(annotations, unknown);
  checkRenderedActions(actions, unknown);
  checkRenderedStreams(verdictStreams, unknown);
  checkVocabulary(
    nestedObject(verdict, "progress")?.mode,
    KNOWN_PROGRESS_MODES,
    "rendered_verdict.progress.mode",
    unknown
  );
  checkRenderedDetail(nestedObject(verdict, "detail"), unknown);
  checkRenderedTrace(nestedObject(verdict, "trace"), unknown);
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
  checkVocabulary(axes?.remote_surface, KNOWN_REMOTE_SURFACE_AXES, "connection_health.axes.remote_surface", unknown);
  checkNextActionVocabulary(nestedObject(health, "next_action"), "connection_health.next_action", unknown);
  checkNextActionVocabulary(nestedObject(connection, "next_action"), "next_action", unknown);
  checkConditionVocabulary(health, unknown);
  checkStructuredEvidence(connection, unknown);
  checkRenderedVerdictVocabulary(nestedObject(connection, "rendered_verdict"), unknown);
  for (const [index, run] of [connection.last_run, connection.last_successful_run].entries()) {
    checkVocabulary(asObject(run)?.status, KNOWN_RUN_STATUSES, `run[${index}].status`, unknown);
  }
  for (const [index, entry] of (Array.isArray(connection.collection_report)
    ? connection.collection_report
    : []
  ).entries()) {
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
  for (const [index, record] of (Array.isArray(connection.stream_records) ? connection.stream_records : []).entries()) {
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

function namedEntries(
  connection: JsonObject,
  key: string
): {
  duplicates: string[];
  malformed: boolean;
  map: Map<string, JsonObject>;
} {
  const map = new Map<string, JsonObject>();
  const duplicates: string[] = [];
  let malformed = false;
  const values = Array.isArray(connection[key]) ? connection[key] : [];
  for (const value of values) {
    const object = asObject(value);
    const name = asNonEmptyString(object?.stream);
    if (!(object && name)) {
      malformed = true;
      continue;
    }
    if (map.has(name)) {
      duplicates.push(name);
    }
    map.set(name, object);
  }
  return { duplicates, malformed, map };
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
  if (!Array.isArray(connection.streams)) {
    return "connection stream membership is unavailable";
  }
  const normalizedConnectionStreams = connection.streams.map((value) =>
    typeof value === "string" ? value.trim() : asNonEmptyString(asObject(value)?.name)
  );
  if (normalizedConnectionStreams.some((name) => !name)) {
    return "connection stream membership contains a malformed stream name";
  }
  const connectionStreamNames = normalizedConnectionStreams as string[];
  const duplicateConnectionStream = connectionStreamNames.find(
    (name, index) => connectionStreamNames.indexOf(name) !== index
  );
  if (duplicateConnectionStream) {
    return `connection stream membership repeats ${duplicateConnectionStream}`;
  }
  const connectionNames = new Set(connectionStreamNames);
  if (manifestNames.size !== connectionNames.size || [...manifestNames].some((name) => !connectionNames.has(name))) {
    return "connection stream membership disagrees with the manifest";
  }
  const report = namedEntries(connection, "collection_report");
  if (report.malformed) {
    return "collection_report contains a malformed stream entry";
  }
  if (report.duplicates.length > 0) {
    return `collection_report repeats ${report.duplicates.join(", ")}`;
  }
  const records = namedEntries(connection, "stream_records");
  if (records.malformed) {
    return "stream_records contains a malformed stream entry";
  }
  if (records.duplicates.length > 0) {
    return `stream_records repeats ${records.duplicates.join(", ")}`;
  }
  const inconsistentRecord = [...records.map.values()].find((record) => {
    const count = record.record_count;
    return (
      (record.count_state === "known_zero" && count !== 0) ||
      (record.count_state === "known" && count === 0) ||
      ((record.count_state === "known" || record.count_state === "known_zero") && !isNonNegativeInteger(count)) ||
      (count !== null && count !== undefined && !isNonNegativeInteger(count))
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
  const unexpectedRecord = [...records.map.entries()].find(
    ([name, record]) => !manifestNames.has(name) && record.declaration_state !== "dormant"
  );
  if (unexpectedRecord) {
    return `stream_records contains undeclared stream ${unexpectedRecord[0]}`;
  }
  const manifestByName = new Map(manifest.streams.map((stream) => [stream.name, stream]));
  const mismatchedRequired = [...report.map.values()].find((entry) => {
    const declared = manifestByName.get(String(entry.stream));
    return declared && typeof entry.required === "boolean" && entry.required !== (declared.raw.required !== false);
  });
  if (mismatchedRequired) {
    return `collection_report requiredness disagrees for ${String(mismatchedRequired.stream)}`;
  }
  const mismatchedStrategy = [...report.map.values()].find((entry) => {
    const declared = manifestByName.get(String(entry.stream));
    if (!declared) {
      return false;
    }
    const coverageStrategy = asNonEmptyString(declared.raw.coverage_strategy);
    const freshnessStrategy = asNonEmptyString(declared.raw.freshness_strategy);
    return (
      (coverageStrategy !== null && entry.coverage_strategy !== coverageStrategy) ||
      (freshnessStrategy !== null && entry.freshness_strategy !== freshnessStrategy)
    );
  });
  if (mismatchedStrategy) {
    return `collection_report strategy disagrees for ${String(mismatchedStrategy.stream)}`;
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
    .filter((entry) => entry.required !== false)
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
  const health = nestedObject(connection, "connection_health");
  const axes = nestedObject(health, "axes");
  const pill = nestedObject(nestedObject(connection, "rendered_verdict"), "pill");
  return (
    latestRunFailed(connection) ||
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

function successfulRuntimeEvidence(connection: JsonObject, report: JsonObject): boolean {
  const lastSuccess = asObject(connection.last_successful_run);
  const lastRun = asObject(connection.last_run);
  if (
    !(lastSuccess && lastRun) ||
    typeof lastSuccess.status !== "string" ||
    typeof lastRun.status !== "string" ||
    !SUCCESSFUL_RUN_STATUSES.has(lastSuccess.status)
  ) {
    return false;
  }
  const lastSuccessId = asNonEmptyString(lastSuccess.run_id);
  const lastRunId = asNonEmptyString(lastRun.run_id);
  const latestIsSuccess = SUCCESSFUL_RUN_STATUSES.has(lastRun.status);
  const latestIsNeutralCancellation = isOwnerCancelledRun(lastRun);
  if (!(lastSuccessId && ((latestIsSuccess && lastRunId === lastSuccessId) || latestIsNeutralCancellation))) {
    return false;
  }
  const evidenceAsOf = asNonEmptyString(report.evidence_as_of) ?? asNonEmptyString(report.as_of);
  if (!evidenceAsOf) {
    return false;
  }
  const successfulTimes = [
    asNonEmptyString(lastSuccess.finished_at),
    asNonEmptyString(lastSuccess.last_at),
    ...(latestIsSuccess ? [asNonEmptyString(lastRun.finished_at), asNonEmptyString(lastRun.last_at)] : []),
  ].filter((value): value is string => value !== null);
  return successfulTimes.includes(evidenceAsOf);
}

function successfulLocalDeviceEvidence(connection: JsonObject, report: JsonObject): boolean {
  if (report.freshness_strategy !== "device_heartbeat") {
    return false;
  }
  const progress = nestedObject(connection, "local_device_progress");
  const outbox = nestedObject(progress, "outbox_counts");
  const evidenceAt = Date.parse(asNonEmptyString(report.evidence_as_of) ?? "");
  const lastHeartbeatAt = Date.parse(asNonEmptyString(progress?.last_heartbeat_at) ?? "");
  const lastIngestAt = Date.parse(asNonEmptyString(progress?.last_ingest_at) ?? "");
  const noOutstandingWork = ["backlog_open", "dead_letter", "leased", "pending", "retrying", "stale_leases"].every(
    (key) => outbox?.[key] === 0
  );
  const accountedTotal = ["dead_letter", "leased", "pending", "retrying", "succeeded"].reduce(
    (total, key) => total + (isNonNegativeInteger(outbox?.[key]) ? outbox[key] : Number.NaN),
    0
  );
  return (
    progress?.last_heartbeat_status === "healthy" &&
    progress.records_pending === 0 &&
    isNonNegativeInteger(progress.source_count) &&
    progress.source_count > 0 &&
    isNonNegativeInteger(outbox?.succeeded) &&
    outbox.succeeded > 0 &&
    isNonNegativeInteger(outbox.total) &&
    outbox.total === accountedTotal &&
    noOutstandingWork &&
    Number.isFinite(evidenceAt) &&
    Number.isFinite(lastHeartbeatAt) &&
    Number.isFinite(lastIngestAt) &&
    lastIngestAt <= evidenceAt &&
    evidenceAt <= lastHeartbeatAt
  );
}

function latestRunFailed(connection: JsonObject): boolean {
  const lastRun = asObject(connection.last_run);
  return (
    typeof lastRun?.status === "string" && FAILED_RUN_STATUSES.has(lastRun.status) && !isOwnerCancelledRun(lastRun)
  );
}

function isOwnerCancelledRun(lastRun: JsonObject | null): boolean {
  const reason = asNonEmptyString(lastRun?.terminal_reason) ?? asNonEmptyString(lastRun?.failure_reason);
  return lastRun?.status === "cancelled" && reason !== null && OWNER_CANCEL_TERMINAL_REASONS.has(reason);
}

function committedCheckpoint(value: unknown): boolean {
  const checkpoint = asNonEmptyString(value);
  return checkpoint !== null && !CHECKPOINT_UNKNOWN_VALUES.has(checkpoint.toLowerCase());
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function optionalCountIsValid(value: unknown): boolean {
  return value === undefined || value === null || isNonNegativeInteger(value);
}

function currentProjectionEvidence(connection: JsonObject): boolean {
  const snapshot = nestedObject(connection, "record_snapshot");
  const manifest = nestedObject(connection, "manifest_declaration");
  const terminal = nestedObject(connection, "terminal_facts");
  return (
    snapshot?.state === "current" &&
    manifest?.state === "current" &&
    terminal?.state === "current" &&
    typeof snapshot.as_of === "string" &&
    snapshot.as_of.length > 0 &&
    typeof manifest.as_of === "string" &&
    manifest.as_of.length > 0 &&
    typeof terminal.as_of === "string" &&
    terminal.as_of.length > 0 &&
    isNonNegativeInteger(terminal.event_seq)
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
  const integerCounts = isNonNegativeInteger(considered) && isNonNegativeInteger(covered) && covered <= considered;
  const auxiliaryCountsAreValid =
    optionalCountIsValid(report.collected) && optionalCountIsValid(report.pending_detail_gaps);
  const coherence = evaluateStreamCoherence(
    {
      checkpoint: asNonEmptyString(report.checkpoint),
      collected: typeof report.collected === "number" ? report.collected : null,
      considered: integerCounts ? considered : null,
      covered: integerCounts ? covered : null,
      pending_detail_gaps: typeof report.pending_detail_gaps === "number" ? report.pending_detail_gaps : null,
      skipped: report.skipped === true ? {} : null,
    },
    {
      coverage_strategy:
        typeof report.coverage_strategy === "string" ? (report.coverage_strategy as CoverageProofStrategy) : null,
      accepted_absence: null,
    }
  );
  return (
    report.coverage_condition === "complete" &&
    (report.forward_disposition === undefined || report.forward_disposition === "complete") &&
    typeof report.coverage_strategy === "string" &&
    KNOWN_COVERAGE_STRATEGIES.has(report.coverage_strategy) &&
    typeof report.freshness_strategy === "string" &&
    KNOWN_FRESHNESS_STRATEGIES.has(report.freshness_strategy) &&
    committedCheckpoint(report.checkpoint) &&
    integerCounts &&
    auxiliaryCountsAreValid &&
    coherence.proven
  );
}

function localDeviceCoverageProof(connection: JsonObject, report: JsonObject, stream: ManifestStream): boolean {
  return (
    report.coverage_condition === "complete" &&
    report.forward_disposition === "complete" &&
    typeof report.coverage_strategy === "string" &&
    KNOWN_COVERAGE_STRATEGIES.has(report.coverage_strategy) &&
    report.coverage_strategy === stream.raw.coverage_strategy &&
    report.freshness_strategy === stream.raw.freshness_strategy &&
    successfulLocalDeviceEvidence(connection, report)
  );
}

function retainedRecordProjectionFailure(record: JsonObject | undefined): string | null {
  const count = record?.record_count;
  if (typeof count !== "number" || !Number.isFinite(count) || !Number.isInteger(count) || count < 0) {
    return "records are present without a usable retained-record projection";
  }
  if (record?.count_state === "stale" || record?.count_state === "unobserved" || record?.count_state === "unknown") {
    return "retained-record projection is not authoritative";
  }
  if (record?.declaration_state !== undefined && record.declaration_state !== "declared") {
    return "retained-record declaration is not current";
  }
  return null;
}

function hasAcceptedRuntimeAbsence(stream: ManifestStream, report: JsonObject): boolean {
  if (stream.raw.required !== false || !asObject(report.skipped)) {
    return false;
  }
  const condition = asNonEmptyString(report.coverage_condition)?.toLowerCase() ?? "";
  return ACCEPTED_ABSENCE_POLICIES.has(condition);
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
  const localDeviceProof = localDeviceCoverageProof(connection, report, stream);
  if (!(successfulRuntimeEvidence(connection, report) || localDeviceProof)) {
    return { green: false, reason: "no current successful runtime evidence" };
  }
  if (!currentProjectionEvidence(connection)) {
    return { green: false, reason: "record or manifest projection is not current" };
  }
  if (hasAcceptedRuntimeAbsence(stream, report)) {
    return {
      green: true,
      reason: `successful runtime evidence accepts ${report.coverage_condition} for this optional stream`,
    };
  }
  const considered = report.considered as number;
  const covered = report.covered as number;
  const verifiedEmpty = considered === 0 && covered === 0 && explicitVerifiedEmpty(connection, report);
  if (!(committedCoverageProof(report) || verifiedEmpty || localDeviceProof)) {
    return { green: false, reason: "committed coverage or explicit verified-empty proof is incomplete" };
  }
  if (localDeviceProof) {
    return { green: true, reason: "healthy local-device receipt completed this stream with no queued work" };
  }
  const recordFailure = retainedRecordProjectionFailure(record);
  if (recordFailure) {
    return { green: false, reason: recordFailure };
  }
  const recordCount = record?.record_count as number;
  if (considered === 0 && covered === 0) {
    return {
      green: true,
      reason:
        recordCount === 0
          ? "successful runtime evidence plus strategy-proven empty coverage"
          : "successful runtime evidence plus strategy-proven zero-delta coverage",
    };
  }
  if (considered === 0 || covered === 0) {
    return { green: false, reason: "coverage denominator and covered count disagree" };
  }
  if (recordCount === 0) {
    return { green: false, reason: "positive coverage disagrees with an empty retained-record projection" };
  }
  return { green: true, reason: `successful runtime evidence covers ${stream.name}` };
}

function missingDomEvidence(reason = "owner Sources evidence was not supplied"): OwnerSourcesDomEvidence {
  return {
    authenticated: false,
    connectionIds: [],
    nextPageHrefs: [],
    paginationComplete: false,
    renderedRows: false,
    resolved: false,
    selectedConnectionId: null,
    streamKeys: [],
    suspense: false,
    reason,
  };
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function htmlAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1]?.toLowerCase();
    if (name && ROW_ATTRIBUTE_NAMES.has(name)) {
      attributes.set(name, decodeHtml(match[3] ?? match[4] ?? ""));
    }
  }
  return attributes;
}

interface RenderedRowEvidence {
  connectionIds: Set<string>;
  malformedStreamRow: boolean;
  orphanedStreamRow: boolean;
  renderedRows: boolean;
  selectedConnectionId: string | null;
  streamKeys: { connectionId: string; stream: string }[];
}

function parseRenderedStreamRow(
  attributes: Map<string, string>
): { key: { connectionId: string; stream: string }; malformed: false } | { key: null; malformed: true } | null {
  if (!attributes.has("data-pdpp-stream-row")) {
    return null;
  }
  const rowConnectionId = attributes.get("data-connection-id")?.trim() ?? "";
  const stream = attributes.get("data-stream-name")?.trim() ?? "";
  const href = attributes.get("href") ?? "";
  let hrefConnection = "";
  let hrefStream = "";
  let hrefPathname = "";
  try {
    const url = new URL(decodeHtml(href), "https://pdpp.invalid");
    hrefPathname = url.pathname;
    hrefConnection = url.searchParams.get("connection")?.trim() ?? "";
    hrefStream = url.searchParams.get("stream")?.trim() ?? "";
  } catch {
    // The row is malformed below and will keep the page unresolved.
  }
  if (
    !(rowConnectionId && stream && href) ||
    hrefPathname !== "/explore" ||
    hrefConnection !== rowConnectionId ||
    hrefStream !== stream
  ) {
    return { key: null, malformed: true };
  }
  return { key: { connectionId: rowConnectionId, stream }, malformed: false };
}

function parseRenderedRows(source: string): RenderedRowEvidence {
  const connectionIds = new Set<string>();
  const streamKeys: { connectionId: string; stream: string }[] = [];
  let malformedStreamRow = false;
  let orphanedStreamRow = false;
  let renderedRows = false;
  let selectedConnectionId: string | null = null;
  for (const tagMatch of source.matchAll(HTML_TAG_PATTERN)) {
    const attributes = htmlAttributes(tagMatch[0] ?? "");
    selectedConnectionId ??= attributes.get("data-pdpp-selected-source")?.trim() || null;
    const sourceRow = attributes.get("data-pdpp-source-row");
    if (sourceRow) {
      renderedRows = true;
      connectionIds.add(sourceRow);
    }
    const streamRow = parseRenderedStreamRow(attributes);
    if (!streamRow) {
      continue;
    }
    renderedRows = true;
    if (streamRow.malformed) {
      malformedStreamRow = true;
      continue;
    }
    streamKeys.push(streamRow.key);
  }
  for (const streamKey of streamKeys) {
    if (!connectionIds.has(streamKey.connectionId)) {
      orphanedStreamRow = true;
    }
  }
  return { connectionIds, malformedStreamRow, orphanedStreamRow, renderedRows, streamKeys, selectedConnectionId };
}

function parsePageHrefs(source: string): string[] {
  const nextPageHrefs: string[] = [];
  for (const match of source.matchAll(HREF_PATTERN)) {
    const href = match[2] ?? "";
    const decodedHref = decodeHtml(href);
    try {
      const url = new URL(decodedHref, "https://pdpp.invalid");
      if (url.pathname === "/sources" && PAGE_CURSOR_PATTERN.test(url.search)) {
        nextPageHrefs.push(decodedHref);
      }
    } catch {
      // Invalid pager links are ignored; the page remains resolved only from
      // its rendered rows, while a valid repeated cursor is handled by live traversal.
    }
  }
  return nextPageHrefs;
}

/** Parse the resolved, authenticated owner `/sources` HTML without a browser. */
export function parseOwnerSourcesDom(html: string): OwnerSourcesDomEvidence {
  const source = String(html);
  const renderedSource = source.replace(NON_RENDERED_HTML_PATTERN, "");
  const authFailure = AUTH_FAILURE_PATTERN.test(renderedSource);
  const suspense =
    SUSPENSE_TESTID_PATTERN.test(renderedSource) ||
    SUSPENSE_BUSY_PATTERN.test(renderedSource) ||
    SUSPENSE_CLASS_PATTERN.test(renderedSource);
  const rendered = parseRenderedRows(renderedSource);
  const nextPageHrefs = parsePageHrefs(renderedSource);
  const explicitEmpty = EXPLICIT_EMPTY_PATTERN.test(renderedSource);
  const renderedRows = rendered.renderedRows || explicitEmpty;
  const revision = DOM_REVISION_PATTERN.exec(renderedSource)?.[2]?.trim() || null;
  const resolved =
    !(authFailure || suspense || rendered.malformedStreamRow || rendered.orphanedStreamRow) && renderedRows;
  let reason: string | null = null;
  if (authFailure) {
    reason = "owner authentication was not resolved";
  } else if (suspense) {
    reason = "owner page is still suspended/loading";
  } else if (rendered.malformedStreamRow) {
    reason = "a rendered stream row did not bind to its source and Explore route";
  } else if (rendered.orphanedStreamRow) {
    reason = "a rendered stream row did not belong to a rendered source row";
  } else if (!renderedRows) {
    reason = "owner page contained no rendered source or empty-state row";
  }
  return {
    authenticated: !authFailure,
    connectionIds: [...rendered.connectionIds],
    nextPageHrefs,
    paginationComplete: true,
    renderedRows,
    revision,
    resolved,
    selectedConnectionId: rendered.selectedConnectionId,
    streamKeys: [
      ...new Map(
        rendered.streamKeys.map((key) => [key.connectionId + String.fromCharCode(0) + key.stream, key])
      ).values(),
    ],
    suspense,
    reason,
  };
}

function normalizeDom(dom: StreamHealthAuthorityInput["dom"]): OwnerSourcesDomEvidence {
  if (typeof dom === "string") {
    return parseOwnerSourcesDom(dom);
  }
  if (dom && typeof dom === "object") {
    return dom;
  }
  return missingDomEvidence();
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
      gate: "inconclusive",
      receipt: { exact: false, observedDom: null, observedSummaries: null, sha: null },
    };
  }
  const observedSummaries = input.revision.summaries?.trim() || null;
  const observedDom = input.revision.dom?.trim() || null;
  const expected = input.revision.expected?.trim() || null;
  const sha = input.revision.sha?.trim() || null;
  const exact = Boolean(
    observedSummaries && observedDom && observedSummaries === observedDom && expected && observedSummaries === expected
  );
  const rawRevisionSuffix = observedSummaries?.split("+").at(-1) ?? null;
  const dirty = [observedSummaries, observedDom, expected].some((value) => value?.endsWith(".dirty") === true);
  const shaMatches = !sha || (!dirty && (observedSummaries === sha || rawRevisionSuffix === sha));
  return {
    gate: exact && !dirty && shaMatches ? "exact" : "inconclusive",
    receipt: { exact: exact && !dirty && shaMatches, observedDom, observedSummaries, sha },
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is the single master-detail reconciliation gate; each branch represents an independent evidence axis.
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
  const streamValues = Array.isArray(dom.streamKeys)
    ? [
        ...new Map(
          dom.streamKeys
            .filter((key) => asNonEmptyString(key?.connectionId) && asNonEmptyString(key?.stream))
            .map((key) => [`${key.connectionId}\u0000${key.stream}`, key])
        ).values(),
      ]
    : [];
  const observedStreamKeys = streamValues.map((key) => `${key.connectionId}:${key.stream}`).sort();
  const expectedStreams = new Map<string, Set<string>>();
  for (const connection of connections) {
    const id = connectionId(connection);
    const manifest = resolveManifest(connection, input);
    if (!id || connectionIsSynthetic(connection, manifest) || !manifest) {
      continue;
    }
    expectedStreams.set(id, new Set(manifest.streams.map((stream) => stream.name)));
  }
  const selectedConnectionId = asNonEmptyString(dom.selectedConnectionId);
  const expectedSelectedStreams = selectedConnectionId ? expectedStreams.get(selectedConnectionId) : undefined;
  const missingStreamKeys =
    selectedConnectionId && expectedSelectedStreams
      ? [...expectedSelectedStreams]
          .filter(
            (stream) => !streamValues.some((key) => key.connectionId === selectedConnectionId && key.stream === stream)
          )
          .map((stream) => `${selectedConnectionId}:${stream}`)
      : [];
  const unexpectedSelectedConnection = selectedConnectionId !== null && !expectedStreams.has(selectedConnectionId);
  const extraStreamKeys: string[] = [];
  const invalidStreamKeys: string[] = [];
  const expectedSet = new Set(expected);
  let streamManifestUnavailable = false;
  for (const key of streamValues) {
    const label = `${key.connectionId}:${key.stream}`;
    const allowed = expectedStreams.get(key.connectionId);
    if (!allowed) {
      if (expectedSet.has(key.connectionId)) {
        streamManifestUnavailable = true;
      } else {
        extraStreamKeys.push(label);
      }
    } else if (!allowed.has(key.stream)) {
      invalidStreamKeys.push(label);
    }
  }
  const structuralResolved = dom.resolved && dom.renderedRows && Array.isArray(dom.streamKeys);
  const observedSet = new Set(observed);
  const missingConnectionIds = expected.filter((id) => !observedSet.has(id));
  const extraConnectionIds = observed.filter((id) => !expectedSet.has(id));
  if (expected.length === 0 && structuralResolved && dom.authenticated === true && dom.suspense === false) {
    return {
      extraConnectionIds: observed,
      extraStreamKeys,
      invalidStreamKeys,
      missingConnectionIds: [],
      observedConnectionIds: observed,
      observedStreamKeys,
      resolved: true,
      status: extraConnectionIds.length || extraStreamKeys.length || invalidStreamKeys.length ? "disagree" : "agree",
    };
  }
  if (
    !dom.resolved ||
    dom.authenticated === false ||
    dom.suspense === true ||
    !structuralResolved ||
    (selectedConnectionId === null &&
      missingConnectionIds.length === 0 &&
      extraConnectionIds.length === 0 &&
      extraStreamKeys.length === 0 &&
      invalidStreamKeys.length === 0) ||
    (selectedConnectionId !== null && expectedSelectedStreams === undefined)
  ) {
    return {
      extraConnectionIds: [],
      extraStreamKeys,
      invalidStreamKeys,
      missingConnectionIds: expected,
      observedConnectionIds: observed,
      observedStreamKeys,
      resolved: false,
      status: "inconclusive",
    };
  }
  if (
    missingConnectionIds.length > 0 ||
    extraConnectionIds.length > 0 ||
    extraStreamKeys.length > 0 ||
    invalidStreamKeys.length > 0 ||
    missingStreamKeys.length > 0 ||
    unexpectedSelectedConnection
  ) {
    addFinding(findings, counts, {
      class: "projection_disagreement",
      connection_id: null,
      connector_id: null,
      denominator: false,
      reason: `authenticated owner DOM differs from owner inventory (missing=${missingConnectionIds.length}, missing_selected_streams=${missingStreamKeys.length}, extra=${extraConnectionIds.length}, extra_streams=${extraStreamKeys.length}, invalid_streams=${invalidStreamKeys.length})`,
      stream: "<owner-dom>",
    });
    return {
      extraConnectionIds,
      extraStreamKeys,
      invalidStreamKeys,
      missingConnectionIds,
      observedConnectionIds: observed,
      observedStreamKeys,
      resolved: true,
      status: "disagree",
    };
  }
  if (streamManifestUnavailable) {
    return {
      extraConnectionIds,
      extraStreamKeys,
      invalidStreamKeys,
      missingConnectionIds,
      observedConnectionIds: observed,
      observedStreamKeys,
      resolved: true,
      status: "inconclusive",
    };
  }
  return {
    extraConnectionIds,
    extraStreamKeys,
    invalidStreamKeys,
    missingConnectionIds,
    observedConnectionIds: observed,
    observedStreamKeys,
    resolved: true,
    status: "agree",
  };
}

function gateFindings(
  input: StreamHealthAuthorityInput,
  dom: OwnerSourcesDomEvidence,
  revisionGate: StreamHealthAuthorityResult["gates"]["revision"],
  vocabularyUnknown: boolean,
  findings: StreamHealthFinding[],
  counts: Record<StreamHealthClass, number>
): StreamHealthAuthorityResult["gates"] {
  const auth = asObject(input.auth);
  const authResolved = auth?.resolved === true && auth.authenticated === true;
  const paginationComplete = input.paginationComplete === true && dom.paginationComplete === true;
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
  if (!dom.resolved || dom.authenticated !== true || dom.suspense === true || !dom.renderedRows) {
    addFinding(findings, counts, {
      class: dom.authenticated === true ? "inconclusive_suspense" : "inconclusive_auth",
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
    dom: dom.resolved && dom.authenticated === true && dom.renderedRows && !dom.suspense ? "resolved" : "inconclusive",
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
  const dom = normalizeDom(input.dom);
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

  // Fleet health consumes the same stream classification as the end-to-end
  // authority, but DOM/auth/revision transport gates answer a separate
  // question: whether the rendered owner surface agrees. Compute coverage
  // before those surface findings are added so absence of DOM is not mistaken
  // for absence of source evidence.
  const coverageStatus = resultStatus(findings, {
    auth: "resolved",
    dom: "resolved",
    pagination: "complete",
    revision: "exact",
    vocabulary: vocabularyUnknown ? "inconclusive" : "known",
  });
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
    coverageStatus,
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
