// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Closed, structural browser-surface evidence. This module intentionally
 * accepts no text, URL, selector, DOM, fixture, or account-derived fields.
 * The reference runtime independently revalidates this shape before durable
 * persistence, so a connector cannot widen the evidence contract.
 */

const MAX_STRUCTURAL_COUNT = 1_000_000;
const MAX_SURFACE_CANDIDATES = 32;
const MAX_SURFACE_CONTROLS = 24;
const MAX_CLASS_TOKENS = 8;
const MAX_TOKEN_LENGTH = 48;
const CLASS_TOKEN_SPLIT_RE = /\s+/u;
const SURFACE_EXPORT_TEXT_RE = /\bexport\b/u;
const SURFACE_DOWNLOAD_TEXT_RE = /\bdownload\b/u;
const SURFACE_OPTIONS_TEXT_RE = /\boptions?\b|\bmore\b/u;
const SURFACE_CSV_TEXT_RE = /\bcsv\b/u;
const SURFACE_PDF_TEXT_RE = /\bpdf\b/u;
const SAFE_SURFACE_CLASS_TOKENS = new Set([
  "as_credit__export",
  "as_credit__utility-bar-item",
  "dialog-control",
  "download",
  "download-button",
  "download-link",
  "ent-as-utility-bar__item",
  "export",
  "export-button",
  "option",
  "options",
  "pdf",
  "utility-bar",
]);
const SAFE_SURFACE_TAGS = new Set(["a", "button", "input", "option", "select", "textarea"]);
const SAFE_SURFACE_ROLES = new Set([
  "button",
  "combobox",
  "dialog",
  "link",
  "listbox",
  "menuitem",
  "option",
  "tab",
  "textbox",
]);
const SAFE_SURFACE_TYPES = new Set(["button", "checkbox", "date", "hidden", "radio", "reset", "submit", "text"]);
const SAFE_SURFACE_NAMES = new Map([
  ["cancel", "cancel"],
  ["enddate", "endDate"],
  ["export", "export"],
  ["fromdate", "fromDate"],
  ["more", "more"],
  ["options", "options"],
  ["selectiontype", "selectionType"],
  ["startdate", "startDate"],
  ["submit", "submit"],
]);

export type BrowserSurfaceKind = "chase_current_activity" | "usaa_transaction_export";
export type BrowserSurfacePosture = "recognized" | "verified_empty" | "parser_zero" | "unexpected";
export type BrowserSurfaceManagedState = "isolated" | "legacy_remote" | "managed" | "unknown";
export type BrowserSurfaceRoute = "expected" | "interstitial" | "unknown";
export type BrowserSurfaceWaitOutcome = "not_needed" | "resolved" | "timed_out" | "unknown";

export type BrowserSurfaceCapturePhase =
  | "account_page_settled"
  | "after_export_affordance_probe"
  | "export_dialog"
  | "export_checkpoint";
export type BrowserSurfaceCaptureState = "captured" | "unavailable";
export type BrowserSurfaceCandidateKind = "export" | "download";
export type BrowserSurfaceTextCategory = "csv" | "download" | "empty" | "export" | "options" | "other" | "pdf";

/** Safe, selector-relevant facts for one export/download candidate. */
export interface BrowserSurfaceCandidate {
  readonly aria_disabled: boolean;
  readonly class_tokens: string[];
  readonly disabled: boolean;
  readonly kind: BrowserSurfaceCandidateKind;
  readonly role: string | null;
  readonly tag: string;
  readonly text_category: BrowserSurfaceTextCategory;
  readonly type: string | null;
  readonly visible: boolean;
}

/** Safe control facts retained when an export dialog is open. */
export interface BrowserSurfaceDialogControl {
  readonly aria_disabled: boolean;
  readonly class_tokens: string[];
  readonly disabled: boolean;
  readonly name: string | null;
  readonly role: string | null;
  readonly tag: string;
  readonly text_category: BrowserSurfaceTextCategory;
  readonly type: string | null;
  readonly visible: boolean;
}

/** A bounded capture-time manifest. It contains no text, URL, or DOM payload. */
export interface BrowserSurfaceCandidateManifest {
  readonly candidate_count: number;
  readonly candidates: BrowserSurfaceCandidate[];
  readonly capture_state: BrowserSurfaceCaptureState;
  readonly control_count: number;
  readonly controls: BrowserSurfaceDialogControl[];
  readonly phase: BrowserSurfaceCapturePhase;
}

interface UnknownRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

function boundedSurfaceCount(value: unknown): number {
  return boundedCount(value);
}

function safeToken(value: unknown, allowed: ReadonlySet<string>): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const token = value.trim();
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  const normalized = token.toLowerCase();
  return allowed.has(normalized) ? normalized : null;
}

function safeName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const name = value.trim();
  return SAFE_SURFACE_NAMES.get(name.toLowerCase()) ?? null;
}

function normalizedClassTokens(value: unknown): string[] {
  let values: unknown[] = [];
  if (Array.isArray(value)) {
    values = value;
  } else if (typeof value === "string") {
    values = value.split(CLASS_TOKEN_SPLIT_RE);
  }
  const seen = new Set<string>();
  for (const item of values) {
    const token = safeToken(item, SAFE_SURFACE_CLASS_TOKENS);
    if (token && token.length <= MAX_TOKEN_LENGTH) {
      seen.add(token);
    }
    if (seen.size >= MAX_CLASS_TOKENS) {
      break;
    }
  }
  return [...seen];
}

function isCapturePhase(value: unknown): value is BrowserSurfaceCapturePhase {
  return (
    value === "account_page_settled" ||
    value === "after_export_affordance_probe" ||
    value === "export_dialog" ||
    value === "export_checkpoint"
  );
}

function isCaptureState(value: unknown): value is BrowserSurfaceCaptureState {
  return value === "captured" || value === "unavailable";
}

function isCandidateKind(value: unknown): value is BrowserSurfaceCandidateKind {
  return value === "export" || value === "download";
}

function isTextCategory(value: unknown): value is BrowserSurfaceTextCategory {
  return (
    value === "csv" ||
    value === "download" ||
    value === "empty" ||
    value === "export" ||
    value === "options" ||
    value === "other" ||
    value === "pdf"
  );
}

/** Convert visible text into a fixed category without retaining the text. */
export function browserSurfaceTextCategory(value: unknown): BrowserSurfaceTextCategory {
  if (typeof value !== "string") {
    return "empty";
  }
  const text = value.replace(/\s+/gu, " ").trim().toLowerCase();
  if (!text) {
    return "empty";
  }
  if (SURFACE_EXPORT_TEXT_RE.test(text)) {
    return "export";
  }
  if (SURFACE_DOWNLOAD_TEXT_RE.test(text)) {
    return "download";
  }
  if (SURFACE_OPTIONS_TEXT_RE.test(text)) {
    return "options";
  }
  if (SURFACE_CSV_TEXT_RE.test(text)) {
    return "csv";
  }
  if (SURFACE_PDF_TEXT_RE.test(text)) {
    return "pdf";
  }
  return "other";
}

function safeBoolean(value: unknown): boolean {
  return value === true;
}

function sanitizeCandidate(value: unknown): BrowserSurfaceCandidate | null {
  const raw = asRecord(value);
  const { kind: rawKind } = raw;
  let kind: BrowserSurfaceCandidateKind | null = null;
  if (isCandidateKind(rawKind)) {
    kind = rawKind;
  } else if (raw.export_hint === true) {
    kind = "export";
  } else if (raw.download_hint === true) {
    kind = "download";
  }
  if (!kind) {
    return null;
  }
  const tag = safeToken(raw.tag, SAFE_SURFACE_TAGS) ?? "unknown";
  const role = safeToken(raw.role, SAFE_SURFACE_ROLES);
  const type = safeToken(raw.type, SAFE_SURFACE_TYPES);
  const textCategory = safeTextCategory(raw);
  return {
    aria_disabled: safeBoolean(raw.aria_disabled),
    class_tokens: normalizedClassTokens(raw.class_tokens ?? raw.cls),
    disabled: safeBoolean(raw.disabled),
    kind,
    role,
    tag,
    text_category: textCategory,
    type,
    visible: safeBoolean(raw.visible),
  };
}

function sanitizeDialogControl(value: unknown): BrowserSurfaceDialogControl | null {
  const raw = asRecord(value);
  const tag = safeToken(raw.tag, SAFE_SURFACE_TAGS) ?? "unknown";
  const role = safeToken(raw.role, SAFE_SURFACE_ROLES);
  const type = safeToken(raw.type, SAFE_SURFACE_TYPES);
  const textCategory = safeTextCategory(raw);
  return {
    aria_disabled: safeBoolean(raw.aria_disabled),
    class_tokens: normalizedClassTokens(raw.class_tokens ?? raw.cls),
    disabled: safeBoolean(raw.disabled),
    name: safeName(raw.name),
    role,
    tag,
    text_category: textCategory,
    type,
    visible: safeBoolean(raw.visible),
  };
}

function safeTextCategory(raw: UnknownRecord): BrowserSurfaceTextCategory {
  if (typeof raw.text === "string") {
    return browserSurfaceTextCategory(raw.text);
  }
  return isTextCategory(raw.text_category) ? raw.text_category : "empty";
}

/**
 * Build a bounded, mutation-safe manifest from page-evaluation output.
 * Unknown fields are ignored. Sensitive text and identifier-shaped class
 * tokens never enter the returned structure.
 */
export function buildBrowserSurfaceCandidateManifest(input: {
  readonly captureState?: unknown;
  readonly candidateCount?: unknown;
  readonly candidates?: unknown;
  readonly controlCount?: unknown;
  readonly controls?: unknown;
  readonly phase: unknown;
}): BrowserSurfaceCandidateManifest {
  const phase = isCapturePhase(input.phase) ? input.phase : "export_checkpoint";
  const captureState = isCaptureState(input.captureState) ? input.captureState : "captured";
  const rawCandidates = Array.isArray(input.candidates) ? input.candidates : [];
  const rawControls = Array.isArray(input.controls) ? input.controls : [];
  const candidates = rawCandidates
    .slice(0, MAX_SURFACE_CANDIDATES)
    .map(sanitizeCandidate)
    .filter((candidate): candidate is BrowserSurfaceCandidate => candidate !== null);
  const controls = rawControls
    .slice(0, MAX_SURFACE_CONTROLS)
    .map(sanitizeDialogControl)
    .filter((control): control is BrowserSurfaceDialogControl => control !== null);
  return {
    capture_state: captureState,
    candidate_count: boundedSurfaceCount(input.candidateCount ?? rawCandidates.length),
    candidates,
    control_count: boundedSurfaceCount(input.controlCount ?? rawControls.length),
    controls,
    phase,
  };
}

/** Exact persisted contract; all members are finite, bounded structural facts. */
export interface BrowserSurfaceDiagnostic {
  readonly account_detail_marker_count: number;
  readonly activity_table_marker_count: number;
  readonly dashboard_marker_count: number;
  readonly managed_surface: BrowserSurfaceManagedState;
  readonly navigation_marker_count: number;
  readonly parser_count: number;
  readonly phase: "final_snapshot" | "no_export_affordance";
  readonly posture: BrowserSurfacePosture;
  readonly read_count: number;
  readonly route: BrowserSurfaceRoute;
  readonly surface: BrowserSurfaceKind;
  readonly target_count: number;
  readonly transaction_marker_count: number;
  readonly verified_empty_marker_count: number;
  readonly wait_outcome: BrowserSurfaceWaitOutcome;
}

export interface BrowserSurfaceDiagnosticInput {
  readonly accountDetailMarkerCount?: unknown;
  readonly activityTableMarkerCount?: unknown;
  readonly dashboardMarkerCount?: unknown;
  readonly kind: unknown;
  readonly managedSurface: unknown;
  readonly navigationMarkerCount?: unknown;
  readonly parserCount?: unknown;
  readonly readCount?: unknown;
  readonly route: unknown;
  readonly targetCount?: unknown;
  readonly transactionMarkerCount?: unknown;
  readonly verifiedEmptyMarkerCount?: unknown;
  readonly waitOutcome: unknown;
}

/** Map the runtime's non-sensitive launch kind to durable evidence vocabulary. */
export function browserSurfaceManagedState(value: string | undefined): BrowserSurfaceManagedState {
  switch (value) {
    case "managed_neko":
      return "managed";
    case "legacy_remote_cdp":
      return "legacy_remote";
    case "isolated_local":
      return "isolated";
    default:
      return "unknown";
  }
}

function boundedCount(value: unknown): number {
  if (!(typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
    return 0;
  }
  return Math.min(value, MAX_STRUCTURAL_COUNT);
}

function isKind(value: unknown): value is BrowserSurfaceKind {
  return value === "chase_current_activity" || value === "usaa_transaction_export";
}

function isManagedState(value: unknown): value is BrowserSurfaceManagedState {
  return value === "isolated" || value === "legacy_remote" || value === "managed" || value === "unknown";
}

function isRoute(value: unknown): value is BrowserSurfaceRoute {
  return value === "expected" || value === "interstitial" || value === "unknown";
}

function isWaitOutcome(value: unknown): value is BrowserSurfaceWaitOutcome {
  return value === "not_needed" || value === "resolved" || value === "timed_out" || value === "unknown";
}

/**
 * Return null unless every categorical input is part of the closed contract.
 * Counts are normalized to bounded integers; all unrecognized source values
 * are rejected rather than copied into durable output.
 */
export function buildBrowserSurfaceDiagnostic(input: BrowserSurfaceDiagnosticInput): BrowserSurfaceDiagnostic | null {
  if (
    !(
      isKind(input.kind) &&
      isManagedState(input.managedSurface) &&
      isRoute(input.route) &&
      isWaitOutcome(input.waitOutcome)
    )
  ) {
    return null;
  }

  const dashboardMarkerCount = boundedCount(input.dashboardMarkerCount);
  const activityTableMarkerCount = boundedCount(input.activityTableMarkerCount);
  const accountDetailMarkerCount = boundedCount(input.accountDetailMarkerCount);
  const transactionMarkerCount = boundedCount(input.transactionMarkerCount);
  const navigationMarkerCount = boundedCount(input.navigationMarkerCount);
  const targetCount = boundedCount(input.targetCount);
  const parserCount = boundedCount(input.parserCount);
  const verifiedEmptyMarkerCount = boundedCount(input.verifiedEmptyMarkerCount);
  const recognizedMarkerCount =
    dashboardMarkerCount +
    activityTableMarkerCount +
    accountDetailMarkerCount +
    transactionMarkerCount +
    navigationMarkerCount;

  let posture: BrowserSurfacePosture = "unexpected";
  if (input.kind === "chase_current_activity") {
    if (parserCount > 0 || targetCount > 0) {
      posture = "recognized";
    } else if (verifiedEmptyMarkerCount > 0) {
      posture = "verified_empty";
    } else if (dashboardMarkerCount > 0 || activityTableMarkerCount > 0) {
      posture = "parser_zero";
    }
  } else if (targetCount > 0 || recognizedMarkerCount > 0) {
    posture = "recognized";
  }

  return {
    account_detail_marker_count: accountDetailMarkerCount,
    activity_table_marker_count: activityTableMarkerCount,
    dashboard_marker_count: dashboardMarkerCount,
    managed_surface: input.managedSurface,
    navigation_marker_count: navigationMarkerCount,
    parser_count: parserCount,
    phase: input.kind === "chase_current_activity" ? "final_snapshot" : "no_export_affordance",
    posture,
    read_count: boundedCount(input.readCount),
    route: input.route,
    surface: input.kind,
    target_count: targetCount,
    transaction_marker_count: transactionMarkerCount,
    verified_empty_marker_count: verifiedEmptyMarkerCount,
    wait_outcome: input.waitOutcome,
  };
}
