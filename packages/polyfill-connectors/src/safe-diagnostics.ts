// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector-neutral boundary for diagnostic values that are allowed to cross
 * a safe capture or safe runtime-emission boundary. Producers may hand this
 * module arbitrary objects, but the output is assembled only from finite
 * vocabularies, bounded counters, and the existing structural/artifact
 * snapshot builders.
 */

import {
  type BodyResponseDiagnostics,
  type SafeArtifactCaptureRecord,
  sanitizeArtifactCapturePayload,
  sanitizeArtifactResponseMetadata,
} from "./browser-artifact-response.ts";
import {
  type BrowserSurfaceCandidateManifest,
  buildBrowserSurfaceCandidateManifest,
  buildBrowserSurfaceDiagnostic,
} from "./browser-surface-diagnostic.ts";
import type { EmittedMessage } from "./connector-runtime-protocol.ts";
import { RECOVERY_ACTIONS } from "./recovery-actions.ts";

const MAX_SAFE_DIAGNOSTIC_COUNT = 1_000_000;
const MAX_SAFE_DIAGNOSTIC_CANDIDATES = 20;
const MAX_SAFE_PAGE_CANDIDATES = 8;
const MAX_SAFE_MESSAGE_LENGTH = 512;
const SAFE_DIAGNOSTIC_TAGS = new Set(["a", "button", "input", "option", "select", "textarea"]);
const SAFE_DOWNLOAD_SOURCES = new Set(["createReadStream", "dataUrl", "saveAs"]);
const SAFE_GENERIC_STREAMS = new Set(["unknown"]);
const SAFE_GENERIC_REASONS = new Set(["diagnostic_sanitized"]);
const SAFE_GENERIC_OUTCOMES = new Set(["unknown"]);
const SAFE_GENERIC_TERMINAL_FAILURES = new Set<string>();
const SAFE_GENERIC_CODES = new Set(["unknown"]);
const SAFE_EXPORT_DIALOG_CATEGORIES = new Set(["no_data", "server_transient", "unknown", "validation"]);
const NETWORK_ERROR_PATTERN =
  /\bnetwork\b|\bfetch(?:\s+(?:failed|error))?\b|\bsocket\b|\bECONN[A-Z0-9_]*\b|net::ERR_[A-Z0-9_]+|connection reset/i;

export const SAFE_DIAGNOSTIC_OPERATION_DEADLINE_MS = 750;

export interface SafeDiagnosticsPolicy {
  readonly codeAllowlist: ReadonlySet<string>;
  readonly defaultProgressMessage: string;
  /** This formatter receives only values already reduced by this module. */
  readonly formatSkipMessage: (reason: string, diagnostics: Record<string, unknown> | undefined) => string;
  readonly outcomeAllowlist: ReadonlySet<string>;
  readonly phaseAllowlist: ReadonlySet<string>;
  readonly progressCategories: readonly { message: string; prefix: string }[];
  readonly reasonAllowlist: ReadonlySet<string>;
  readonly streamAllowlist: ReadonlySet<string>;
  readonly terminalFailureAllowlist: ReadonlySet<string>;
}

export interface SafeDiagnosticInfo {
  readonly diag: Record<string, unknown> | null;
  readonly phase: string;
  readonly [key: string]: unknown;
}

const DEFAULT_SAFE_PROGRESS_MESSAGE = "Progress";

export const DEFAULT_SAFE_DIAGNOSTICS_POLICY: SafeDiagnosticsPolicy = {
  codeAllowlist: SAFE_GENERIC_CODES,
  defaultProgressMessage: DEFAULT_SAFE_PROGRESS_MESSAGE,
  formatSkipMessage: (reason) => `Safe diagnostic skipped: ${reason}`,
  outcomeAllowlist: SAFE_GENERIC_OUTCOMES,
  phaseAllowlist: new Set(["unknown"]),
  progressCategories: [],
  reasonAllowlist: SAFE_GENERIC_REASONS,
  streamAllowlist: SAFE_GENERIC_STREAMS,
  terminalFailureAllowlist: SAFE_GENERIC_TERMINAL_FAILURES,
};

export type SafeCaptureBoundaryEvent =
  | { kind: "artifact_metadata"; payload: unknown }
  | { kind: "surface_manifest"; payload: unknown };

export type SafeCaptureBoundaryRecord =
  | { kind: "artifact_metadata"; payload: SafeArtifactCaptureRecord }
  | { kind: "surface_manifest"; payload: BrowserSurfaceCandidateManifest };

interface UnknownRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): UnknownRecord {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : {};
  } catch {
    return {};
  }
}

export function boundedSafeDiagnosticCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, MAX_SAFE_DIAGNOSTIC_COUNT)
    : 0;
}

function safeEnum(value: unknown, allowed: ReadonlySet<string>, fallback: string): string {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function safePhase(value: unknown, policy: SafeDiagnosticsPolicy): string {
  return safeEnum(value, policy.phaseAllowlist, "unknown");
}

function safeTag(value: unknown): string {
  if (typeof value !== "string") {
    return "unknown";
  }
  const tag = value.trim().toLowerCase();
  return SAFE_DIAGNOSTIC_TAGS.has(tag) ? tag : "unknown";
}

/** Reduce arbitrary error text to a finite diagnostic class. */
export function safeErrorCategory(
  error: unknown
): "timeout" | "download" | "dialog" | "capture" | "network" | "unknown" {
  try {
    const raw = error instanceof Error ? error.message : String(error);
    if (typeof raw !== "string") {
      return "unknown";
    }
    const lower = raw.toLowerCase();
    if (lower.includes("timeout") || lower.includes("timed out")) {
      return "timeout";
    }
    if (lower.includes("download") || lower.includes("stream") || lower.includes("saveas")) {
      return "download";
    }
    if (lower.includes("dialog")) {
      return "dialog";
    }
    if (lower.includes("capture")) {
      return "capture";
    }
    const withoutUrls = raw.replace(/\bhttps?:\/\/\S+/gi, " ");
    if (NETWORK_ERROR_PATTERN.test(withoutUrls)) {
      return "network";
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

function safeMessage(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SAFE_MESSAGE_LENGTH ? value : fallback;
}

function safePageCandidate(value: unknown): Record<string, unknown> {
  const raw = asRecord(value);
  return {
    cls: "",
    id: null,
    tag: safeTag(raw.tag),
    text: "",
  };
}

function sanitizePageDiagnostics(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = asRecord(value);
  const candidates = Array.isArray(raw.export_candidates) ? raw.export_candidates : [];
  const navCandidates = Array.isArray(raw.nav_candidates) ? raw.nav_candidates : [];
  return {
    dialog_html_preview: null,
    dialogs_open: boundedSafeDiagnosticCount(raw.dialogs_open),
    export_candidates: candidates.slice(0, MAX_SAFE_PAGE_CANDIDATES).map(safePageCandidate),
    has_utility_bar: raw.has_utility_bar === true,
    nav_candidates: navCandidates.slice(0, MAX_SAFE_PAGE_CANDIDATES).map(safePageCandidate),
    title: "",
    url: "",
  };
}

function sanitizeArtifactDiagnostics(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const artifact = value as BodyResponseDiagnostics;
  const candidates = Array.isArray(artifact.candidates)
    ? artifact.candidates.slice(0, MAX_SAFE_DIAGNOSTIC_CANDIDATES)
    : [];
  return {
    candidates: candidates.map((candidateValue) => {
      const candidate = asRecord(candidateValue);
      const metadata = sanitizeArtifactResponseMetadata({
        bytes: candidate.bodyBytes,
        contentDisposition: candidate.contentDisposition,
        contentType: candidate.contentType,
        csvHeader: candidate.csvHeader,
        method: candidate.method,
        pdfMagic: candidate.pdfMagic,
        status: candidate.status,
        url: candidate.url,
      });
      return {
        ...(metadata.byte_count === null ? {} : { bodyBytes: metadata.byte_count }),
        contentDisposition: metadata.content_disposition ?? "",
        contentType: metadata.content_type ?? "",
        csvHeader: metadata.csv_header,
        filenameShape: metadata.filename_shape,
        method: metadata.method ?? "",
        pathShape: metadata.path_shape,
        pdfMagic: metadata.pdf_magic,
        reason:
          candidate.reason === "body_error" || candidate.reason === "matched" ? candidate.reason : "not_expected_body",
        source: candidate.source === "cdp" ? "cdp" : "playwright",
        status: metadata.status ?? 0,
        url: "",
      };
    }),
    cdpError: null,
    cdpReady: artifact.cdpReady === true,
    // Bounded stage counters — plain non-negative integers, no PII (unlike
    // URLs/filenames/error text elsewhere in this record), so they cross the
    // safe boundary the same way the existing total* counters do. These are
    // what let a future gap distinguish "shouldInspect rejected everything"
    // from "an accepted response never reached a terminal body outcome"
    // (see the field-level comments on BodyResponseDiagnostics) — the
    // ambiguity `candidates: []` alone cannot resolve.
    stageCdpBodyFetchFailed: boundedSafeDiagnosticCount(artifact.stageCdpBodyFetchFailed),
    stageCdpBodyFetchSucceeded: boundedSafeDiagnosticCount(artifact.stageCdpBodyFetchSucceeded),
    stageCdpHeaderAccepted: boundedSafeDiagnosticCount(artifact.stageCdpHeaderAccepted),
    stageCdpHeaderRejected: boundedSafeDiagnosticCount(artifact.stageCdpHeaderRejected),
    stageCdpLoadingFinished: boundedSafeDiagnosticCount(artifact.stageCdpLoadingFinished),
    stagePlaywrightBodyFetchFailed: boundedSafeDiagnosticCount(artifact.stagePlaywrightBodyFetchFailed),
    stagePlaywrightBodyFetchSucceeded: boundedSafeDiagnosticCount(artifact.stagePlaywrightBodyFetchSucceeded),
    stagePlaywrightHeaderAccepted: boundedSafeDiagnosticCount(artifact.stagePlaywrightHeaderAccepted),
    stagePlaywrightHeaderRejected: boundedSafeDiagnosticCount(artifact.stagePlaywrightHeaderRejected),
    totalCdpRequestsStarted: boundedSafeDiagnosticCount(artifact.totalCdpRequestsStarted),
    totalCdpResponsesSeen: boundedSafeDiagnosticCount(artifact.totalCdpResponsesSeen),
    totalResponsesSeen: boundedSafeDiagnosticCount(artifact.totalResponsesSeen),
  };
}

function sanitizeDownloadDiagnostics(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = asRecord(value);
  const source = typeof raw.source === "string" && SAFE_DOWNLOAD_SOURCES.has(raw.source) ? raw.source : null;
  const metadata = sanitizeArtifactResponseMetadata({
    bytes: raw.bytes,
    contentDisposition: raw.contentDisposition,
    contentType: raw.contentType,
    csvHeader: raw.csvHeader,
    filename: raw.suggestedFilename,
    method: raw.method,
    pdfMagic: raw.pdfMagic,
    status: raw.status,
    url: raw.url,
  });
  return {
    bytes: metadata.byte_count === null ? null : boundedSafeDiagnosticCount(metadata.byte_count),
    contentDisposition: metadata.content_disposition,
    contentType: metadata.content_type,
    csvHeader: metadata.csv_header,
    filenameShape: metadata.filename_shape,
    method: metadata.method,
    pathShape: metadata.path_shape,
    pdfMagic: metadata.pdf_magic,
    source,
    status: metadata.status,
    suggestedFilename: null,
    url: null,
  };
}

function safeResponseTransport(value: unknown): "cdp" | "playwright" | null {
  if (value === "cdp" || value === "playwright") {
    return value;
  }
  return null;
}

/**
 * A distinct fact from `download` (a Playwright `Download` artifact's own
 * persistence outcome, `source` one of dataUrl/saveAs/createReadStream):
 * this describes the body-response transport (`cdp`/`playwright`, the same
 * axis as `artifact.candidates[].source`) that ultimately rescued a body
 * after the download-side attempt failed or produced zero bytes. Reusing
 * `sanitizeDownloadDiagnostics`'s `source` field for this would silently
 * null it (its allowlist is the download-artifact vocabulary, not the
 * transport vocabulary) and its raw failure string must never cross this
 * boundary verbatim — both are why this has its own sanitizer and key.
 */
function sanitizeResponseRescueDiagnostics(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = asRecord(value);
  return {
    bytes: typeof raw.bytes === "number" ? boundedSafeDiagnosticCount(raw.bytes) : null,
    downloadFailureCategory: Object.hasOwn(raw, "downloadFailure") ? safeErrorCategory(raw.downloadFailure) : null,
    transport: safeResponseTransport(raw.transport),
  };
}

function sanitizeBrowserSurface(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = asRecord(value);
  const diagnostic = buildBrowserSurfaceDiagnostic({
    accountDetailMarkerCount: raw.account_detail_marker_count,
    activityTableMarkerCount: raw.activity_table_marker_count,
    dashboardMarkerCount: raw.dashboard_marker_count,
    kind: raw.kind ?? raw.surface,
    managedSurface: raw.managed_surface ?? "unknown",
    navigationMarkerCount: raw.navigation_marker_count,
    parserCount: raw.parser_count,
    readCount: raw.read_count,
    route: raw.route ?? "unknown",
    targetCount: raw.target_count,
    transactionMarkerCount: raw.transaction_marker_count,
    verifiedEmptyMarkerCount: raw.verified_empty_marker_count,
    waitOutcome: raw.wait_outcome ?? "unknown",
  });
  return diagnostic ? { ...diagnostic } : null;
}

function sanitizeSurfaceManifest(value: unknown): BrowserSurfaceCandidateManifest {
  const raw = asRecord(value);
  return buildBrowserSurfaceCandidateManifest({
    captureState: raw.capture_state ?? raw.captureState,
    candidateCount: raw.candidate_count ?? raw.candidateCount,
    candidates: raw.candidates,
    controlCount: raw.control_count ?? raw.controlCount,
    controls: raw.controls,
    phase: raw.phase,
  });
}

function sanitizeExportCandidate(value: unknown): Record<string, unknown> {
  const raw = asRecord(value);
  const [candidate] = buildBrowserSurfaceCandidateManifest({
    candidates: [
      {
        aria_disabled: raw.aria_disabled,
        class_tokens: raw.cls ?? raw.class_tokens,
        disabled: raw.disabled,
        kind: "export",
        role: raw.role,
        tag: raw.tag,
        text: raw.text,
        type: raw.type,
        visible: raw.visible,
      },
    ],
    phase: "after_export_affordance_probe",
  }).candidates;
  return {
    aria_disabled: raw.aria_disabled === true,
    cls: candidate?.class_tokens.join(" ") ?? "",
    disabled: raw.disabled === true,
    id: null,
    role: candidate?.role ?? null,
    tag: candidate?.tag ?? "unknown",
    text: "",
    type: candidate?.type ?? null,
    visible: raw.visible === true,
  };
}

function sanitizeNoExportObservation(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = asRecord(value);
  const candidates = Array.isArray(raw.export_affordance_candidates) ? raw.export_affordance_candidates : [];
  const { account_page_identity: identity, route } = raw;
  return {
    account_detail_marker_count: boundedSafeDiagnosticCount(raw.account_detail_marker_count),
    ...(identity === "exact" || identity === "mismatch" || identity === "unverified"
      ? { account_page_identity: identity }
      : {}),
    affordance_disabled: raw.affordance_disabled === true,
    export_affordance_candidates: candidates.slice(0, MAX_SAFE_PAGE_CANDIDATES).map(sanitizeExportCandidate),
    navigation_marker_count: boundedSafeDiagnosticCount(raw.navigation_marker_count),
    route: route === "expected" || route === "interstitial" || route === "unknown" ? route : "unknown",
    ...(raw.surface_manifest ? { surface_manifest: sanitizeSurfaceManifest(raw.surface_manifest) } : {}),
    target_count: boundedSafeDiagnosticCount(raw.target_count),
    transaction_marker_count: boundedSafeDiagnosticCount(raw.transaction_marker_count),
  };
}

function addSafeDiagnosticClassifications(
  safe: Record<string, unknown>,
  raw: UnknownRecord,
  policy: SafeDiagnosticsPolicy
): void {
  const phase = safePhase(raw.phase, policy);
  if (phase !== "unknown") {
    safe.phase = phase;
  }
  const outcome = safeEnum(raw.outcome, policy.outcomeAllowlist, "unknown");
  if (Object.hasOwn(raw, "outcome") && policy.outcomeAllowlist.has(outcome)) {
    safe.outcome = outcome;
  }
  const terminalFailure = safeEnum(raw.terminal_failure, policy.terminalFailureAllowlist, "unknown");
  if (Object.hasOwn(raw, "terminal_failure") && policy.terminalFailureAllowlist.has(terminalFailure)) {
    safe.terminal_failure = terminalFailure;
  }
  const identity = raw.account_page_identity;
  if (identity === "exact" || identity === "mismatch" || identity === "unverified") {
    safe.account_page_identity = identity;
  }
  if (Object.hasOwn(raw, "dialog_category") && SAFE_EXPORT_DIALOG_CATEGORIES.has(raw.dialog_category as string)) {
    safe.dialog_category = raw.dialog_category;
  }
}

function addSafeDiagnosticPage(safe: Record<string, unknown>, raw: UnknownRecord): void {
  if (Object.hasOwn(raw, "diag")) {
    safe.page =
      raw.diag !== null && typeof raw.diag === "object" && !Array.isArray(raw.diag) ? "captured" : "unavailable";
  }
  if (Object.hasOwn(raw, "page") && (raw.page === "captured" || raw.page === "unavailable")) {
    safe.page = raw.page;
  }
}

function addSafeDiagnosticEvidence(safe: Record<string, unknown>, raw: UnknownRecord): void {
  if (Object.hasOwn(raw, "artifact")) {
    safe.artifact = sanitizeArtifactDiagnostics(raw.artifact);
  }
  if (Object.hasOwn(raw, "download")) {
    safe.download = sanitizeDownloadDiagnostics(raw.download);
  }
  if (Object.hasOwn(raw, "response_rescue")) {
    safe.response_rescue = sanitizeResponseRescueDiagnostics(raw.response_rescue);
  }
  const browserSurface = sanitizeBrowserSurface(raw.browser_surface);
  if (browserSurface) {
    safe.browser_surface = browserSurface;
  }
  if (Object.hasOwn(raw, "no_export_observation")) {
    const observation = sanitizeNoExportObservation(raw.no_export_observation);
    if (observation) {
      safe.no_export_observation = observation;
    }
  }
  if (Object.hasOwn(raw, "surface_manifest")) {
    safe.surface_manifest = sanitizeSurfaceManifest(raw.surface_manifest);
  }
  if (Array.isArray(raw.export_affordance_candidates)) {
    safe.export_affordance_candidates = raw.export_affordance_candidates
      .slice(0, MAX_SAFE_PAGE_CANDIDATES)
      .map(sanitizeExportCandidate);
  }
  if (Array.isArray(raw.popup_urls)) {
    // Same policy as sanitizeArtifactDiagnostics' candidate.url: even a
    // same-origin-stripped URL string can carry an account- or
    // document-scoped path segment, so only the bounded count crosses the
    // safe boundary, never the strings themselves.
    safe.popup_count = boundedSafeDiagnosticCount(raw.popup_urls.length);
  }
}

function addSafeDiagnosticErrorAndCounts(safe: Record<string, unknown>, raw: UnknownRecord): void {
  if (Object.hasOwn(raw, "error")) {
    safe.error = safeErrorCategory(raw.error);
  }
  for (const key of ["account_ordinal", "account_total", "data_rows", "row_id"]) {
    if (Object.hasOwn(raw, key)) {
      safe[key] = boundedSafeDiagnosticCount(raw[key]);
    }
  }
}

/** Canonical structural sanitizer used by callbacks, skip diagnostics, and safe capture. */
export function sanitizeSafeDiagnosticPayload(
  value: unknown,
  policy: SafeDiagnosticsPolicy = DEFAULT_SAFE_DIAGNOSTICS_POLICY
): Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { diagnostic: "sanitized" };
    }
    const raw = asRecord(value);
    const safe: Record<string, unknown> = {};
    addSafeDiagnosticClassifications(safe, raw, policy);
    addSafeDiagnosticPage(safe, raw);
    addSafeDiagnosticEvidence(safe, raw);
    addSafeDiagnosticErrorAndCounts(safe, raw);
    return Object.keys(safe).length > 0 ? safe : { diagnostic: "sanitized" };
  } catch {
    return { diagnostic: "sanitized" };
  }
}

/** Use the same post-boundary shape for connector callback diagnostic values. */
export function sanitizeSafeDiagnosticInfo(
  value: unknown,
  policy: SafeDiagnosticsPolicy = DEFAULT_SAFE_DIAGNOSTICS_POLICY
): SafeDiagnosticInfo {
  try {
    const { page: _page, ...safe } = sanitizeSafeDiagnosticPayload(value, policy);
    safe.diag = sanitizePageDiagnostics(asRecord(value).diag);
    if (!Object.hasOwn(safe, "diag")) {
      safe.diag = null;
    }
    if (!Object.hasOwn(safe, "phase")) {
      safe.phase = "unknown";
    }
    return safe as SafeDiagnosticInfo;
  } catch {
    return { diag: null, phase: "unknown" };
  }
}

/** The only safe-capture payload dispatcher. */
export function sanitizeSafeCaptureEvent(value: unknown): SafeCaptureBoundaryRecord | null {
  try {
    const raw = asRecord(value);
    if (raw.kind === "surface_manifest") {
      return { kind: "surface_manifest", payload: sanitizeSurfaceManifest(raw.payload) };
    }
    if (raw.kind === "artifact_metadata") {
      return { kind: "artifact_metadata", payload: sanitizeArtifactCapturePayload(raw.payload) };
    }
  } catch {
    return null;
  }
  return null;
}

/** Fail closed around one diagnostic Playwright operation. */
export async function withDiagnosticDeadline<T>(
  operation: () => Promise<T>,
  deadlineMs = SAFE_DIAGNOSTIC_OPERATION_DEADLINE_MS
): Promise<T | null> {
  const boundedDeadline =
    Number.isFinite(deadlineMs) && deadlineMs > 0
      ? Math.min(Math.floor(deadlineMs), SAFE_DIAGNOSTIC_OPERATION_DEADLINE_MS)
      : 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.resolve()
    .then(operation)
    .catch((): null => null);
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), boundedDeadline);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function sanitizeSafeProgress(
  message: Extract<EmittedMessage, { type: "PROGRESS" }>,
  policy: SafeDiagnosticsPolicy
): Extract<EmittedMessage, { type: "PROGRESS" }> {
  const rawMessage = typeof message.message === "string" ? message.message : "";
  const progressCategory = policy.progressCategories.find((category) => rawMessage.startsWith(category.prefix));
  const safe: Extract<EmittedMessage, { type: "PROGRESS" }> = {
    message: safeMessage(progressCategory?.message, policy.defaultProgressMessage),
    type: "PROGRESS",
  };
  if (message.count !== undefined) {
    safe.count = boundedSafeDiagnosticCount(message.count);
  }
  if (message.stream !== undefined) {
    safe.stream = safeEnum(message.stream, policy.streamAllowlist, "unknown");
  }
  if (message.total !== undefined) {
    safe.total = boundedSafeDiagnosticCount(message.total);
  }
  return safe;
}

function sanitizeSafeSkip(
  message: Extract<EmittedMessage, { type: "SKIP_RESULT" }>,
  policy: SafeDiagnosticsPolicy
): Extract<EmittedMessage, { type: "SKIP_RESULT" }> {
  const reason = safeEnum(message.reason, policy.reasonAllowlist, "diagnostic_sanitized");
  const diagnostics =
    message.diagnostics === undefined ? undefined : sanitizeSafeDiagnosticPayload(message.diagnostics, policy);
  const formatted = policy.formatSkipMessage(reason, diagnostics);
  const safe: Extract<EmittedMessage, { type: "SKIP_RESULT" }> = {
    message: safeMessage(formatted, `Safe diagnostic skipped: ${reason}`),
    reason,
    stream: safeEnum(message.stream, policy.streamAllowlist, "unknown"),
    type: "SKIP_RESULT",
  };
  if (diagnostics !== undefined) {
    safe.diagnostics = diagnostics;
  }
  const recoveryHint = safeRecoveryHint(message.recovery_hint);
  if (recoveryHint) {
    safe.recovery_hint = recoveryHint;
  }
  return safe;
}

/**
 * Reduce a producer-supplied `recovery_hint` (string action, or `{ action,
 * retryable }`) to the bounded connector-neutral vocabulary, or `undefined`
 * when the action is absent/unrecognized. `retryable` defaults from the
 * action itself (`retry_by_runtime` implies retryable) exactly like the
 * runtime's own `normalizeRecoveryHint`, so a connector that supplies only a
 * bare action string still gets an honest `retryable` value rather than a
 * silently-dropped hint.
 */
function safeRecoveryHint(
  hint: string | { action?: string; retryable?: boolean } | undefined
): { action: string; retryable: boolean } | undefined {
  const action = typeof hint === "string" ? hint : hint?.action;
  if (!(action && RECOVERY_ACTIONS.has(action))) {
    return;
  }
  const retryable = typeof hint === "object" && typeof hint.retryable === "boolean" ? hint.retryable : undefined;
  return { action, retryable: retryable ?? action === "retry_by_runtime" };
}

function sanitizeSafeDone(
  message: Extract<EmittedMessage, { type: "DONE" }>,
  policy: SafeDiagnosticsPolicy
): Extract<EmittedMessage, { type: "DONE" }> {
  const status = message.status === "succeeded" || message.status === "failed" ? message.status : "failed";
  const safe: Extract<EmittedMessage, { type: "DONE" }> = {
    records_emitted: boundedSafeDiagnosticCount(message.records_emitted),
    status,
    type: "DONE",
  };
  if (status === "failed" && message.error) {
    const code = safeEnum(message.error.code, policy.codeAllowlist, "unknown");
    safe.error = {
      code,
      message: `Connector failure (${safeErrorCategory(message.error.message)})`,
      retryable: message.error.retryable === true,
    };
  }
  return safe;
}

function isSafeEmissionObject(value: unknown): boolean {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function safeEmissionProperty(value: unknown, key: string): unknown {
  let property: unknown;
  try {
    if (isSafeEmissionObject(value)) {
      property = Reflect.get(value as object, key);
    }
  } catch {
    // A hostile type getter is an unknown message and selects the fixed fallback.
  }
  return property;
}

function safeProgressFallback(): Extract<EmittedMessage, { type: "PROGRESS" }> {
  return { message: DEFAULT_SAFE_PROGRESS_MESSAGE, type: "PROGRESS" };
}

function safeSkipFallback(): Extract<EmittedMessage, { type: "SKIP_RESULT" }> {
  return {
    diagnostics: { diagnostic: "sanitized" },
    message: "Safe diagnostic skipped: diagnostic_sanitized",
    reason: "diagnostic_sanitized",
    stream: "unknown",
    type: "SKIP_RESULT",
  };
}

function safeDoneFallback(): Extract<EmittedMessage, { type: "DONE" }> {
  return {
    error: { code: "unknown", message: "Connector failure (unknown)", retryable: false },
    records_emitted: 0,
    status: "failed",
    type: "DONE",
  };
}

function safeEmissionFallback(type: unknown): EmittedMessage {
  switch (type) {
    case "PROGRESS":
      return safeProgressFallback();
    case "SKIP_RESULT":
      return safeSkipFallback();
    case "DONE":
      return safeDoneFallback();
    default:
      return safeDoneFallback();
  }
}

const SAFE_PASSTHROUGH_MESSAGE_TYPES = new Set([
  "ASSISTANCE",
  "ASSISTANCE_STATUS",
  "BROWSER_SURFACE_REQUEST",
  "DETAIL_COVERAGE",
  "DETAIL_GAP",
  "DETAIL_GAP_ATTEMPTED",
  "DETAIL_GAP_RECOVERED",
  "DETAIL_GAPS_PAGE_REQUEST",
  "INTERACTION",
  "RECORD",
  "STATE",
]);

export function sanitizeSafeEmission(
  message: EmittedMessage,
  policy: SafeDiagnosticsPolicy = DEFAULT_SAFE_DIAGNOSTICS_POLICY
): EmittedMessage {
  const type = safeEmissionProperty(message, "type");
  if (!isSafeEmissionObject(message)) {
    return safeDoneFallback();
  }
  try {
    switch (type) {
      case "PROGRESS":
        return sanitizeSafeProgress(message as Extract<EmittedMessage, { type: "PROGRESS" }>, policy);
      case "SKIP_RESULT":
        return sanitizeSafeSkip(message as Extract<EmittedMessage, { type: "SKIP_RESULT" }>, policy);
      case "DONE":
        return sanitizeSafeDone(message as Extract<EmittedMessage, { type: "DONE" }>, policy);
      default:
        return typeof type === "string" && SAFE_PASSTHROUGH_MESSAGE_TYPES.has(type) ? message : safeDoneFallback();
    }
  } catch {
    return safeEmissionFallback(type);
  }
}
