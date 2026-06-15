/**
 * Sources view model — pure projection of the live connector summaries into
 * the serializable shape the Recordroom "loading dock" presentation consumes.
 *
 * This module is the data-source seam for the redesigned Sources view. The
 * server page fetches `RefConnectorSummary[]` through the existing
 * `liveDashboardDataSource.listConnectorSummaries()` and maps it here into
 * `SourceInstanceView`s. We bind directly to `RefConnectorSummary` (not the
 * lossy `ConnectorOverview` projection) because that envelope carries the
 * schedule, connection health, next action, and retained-bytes the passport
 * needs — exactly the documented Sources data contract.
 *
 * Keeping the mapping pure means:
 *   - the client presentation receives only serializable, non-secret data,
 *   - the health→status, schedule, and account derivations are unit-testable
 *     without rendering, and
 *   - the real fetch path stays untouched — this is presentation projection,
 *     not a new read.
 *
 * Voice rule honored throughout: protocol values (ids, timestamps, intervals)
 * stay verbatim; human copy is derived. Nothing here fabricates a value the
 * spine did not supply — absent fields render as honest "unknown"/null, never
 * a false zero or green.
 */

import { formatConnectorNameForDisplay } from "@pdpp/operator-ui/lib/connector-display";
import {
  type ConnectorManifestLike,
  canonicalConnectorKey,
  manualUploadSetupFromManifest,
} from "pdpp-reference-implementation/connection-setup-plan";
import { type FormattedNextAction, formatNextAction } from "../lib/next-action.ts";
import type {
  RefConnectionHealthSnapshot,
  RefConnectorRunSummary,
  RefConnectorSummary,
  RefRecordVersionStatsRow,
  RefRenderedVerdict,
  RefSchedule,
  RefVerdictTone,
} from "../lib/ref-client.ts";
import { summarizeVersionChurn } from "../lib/version-churn-summary.ts";

/**
 * The status flag rendered against each instance in the list and the passport.
 * Current references derive it from server-owned `RenderedVerdict.pill` plus
 * co-required annotations; older references fall back to the legacy
 * connection-health `state` and freshness axis. In both cases the dot, the
 * Endorse badge, and the headline read from one source of truth — and a
 * stale-but-healthy connection discloses its staleness instead of reading bare
 * green.
 *
 *   ● healthy    — green dot       (state: healthy | idle)
 *   ◐ degraded   — amber half-dot  (state: degraded | cooling_off | needs_attention)
 *   ⊘ blocked    — red interdict   (state: blocked)
 *   ○ unknown    — muted ring      (state: unknown, or no health projection)
 *   ⊘ revoked    — struck          (revoked lifecycle, overrides health)
 */
export type SourceStatusKind = "blocked" | "degraded" | "healthy" | "revoked" | "unknown";

/** The achromatic→token tone for a status (maps to a CSS var class). */
export type SourceStatusTone = "destructive" | "muted" | "success" | "warning";

/** The glyph + tone pairing for a status. Color is carried by a token class. */
export interface SourceStatusFlag {
  /** Single-glyph dot for the dense list (color via `tone` token class). */
  dot: string;
  /**
   * Mandatory freshness annotation whenever the freshness axis is not `fresh`.
   * `null` when the connection is fresh (or carries no freshness evidence),
   * so a stale/unknown status can never read as a bare "Healthy" without
   * disclosing that its data is not current. It is folded into `label`, and
   * exposed separately so a surface can render it as its own chip.
   */
  freshnessNote: string | null;
  kind: SourceStatusKind;
  /**
   * Short human label (e.g. "Healthy", "Needs attention"). When a
   * `freshnessNote` applies, it is appended (e.g. "Healthy · stale") so the
   * one string the list and passport render is never silent about staleness.
   */
  label: string;
  tone: SourceStatusTone;
}

/** One row in the passport's stream manifest table. */
export interface SourceStreamManifestRow {
  /** Cursor/checkpoint hint, or null when none is exposed at the index level. */
  cursor: string | null;
  /** Deep-link into Explore for this connection + stream. */
  exploreHref: string;
  name: string;
  /** Server-retained record count for the stream, or null when unknown. */
  recordCount: number | null;
  /**
   * Whether the stream's records are lexically searchable. `null` when the
   * manifest does not declare it — we render "unknown" rather than guess
   * "sealed", which would imply a determination the data did not make.
   */
  searchable: boolean | null;
}

/** A row in the passport KV block — a typed key/value pair. */
export interface SourcePassportField {
  k: string;
  /** Render in the mono protocol voice (ids, timestamps, intervals). */
  mono?: boolean;
  /** Already-formatted, non-secret value. Null renders an em dash. */
  value: string | null;
}

/** The fully-projected, serializable view of one source instance. */
export interface SourceInstanceView {
  /** Human account/identity line for the list (display name vs. type). */
  accountLine: string;
  /** Stable connection selector for routing + revoke (connection_id). */
  connectionId: string | null;
  /** Connector type id (e.g. "gmail"), used for sync + add-source. */
  connectorId: string;
  /** The instance-scoped selector the sync action prefers. */
  connectorInstanceId: string | null;
  /** Deep link to the in-app connection detail page (the always-safe target). */
  detailHref: string;
  /** Owner-facing display name (passport + list title). */
  displayName: string;
  /** Stable React key + route id. */
  id: string;
  /** True when this connection's data arrives by device push (sync is inert). */
  isLocalDevicePush: boolean;
  /** True when the latest run is active, so reprocessing should not start again. */
  isRunning: boolean;
  /** Connector type label (mono kind line in the list). */
  kind: string;
  /** Existing-source import route for manual/upload connectors. */
  manualUploadHref: string | null;
  /** Owner CTA derived from rendered_verdict.required_actions, or null. */
  nextAction: FormattedNextAction | null;
  /** Passport KV rows (kind / account / config / auth / schedule / last run …). */
  passportFields: SourcePassportField[];
  revoked: boolean;
  /** Status flag (dot + Endorse) derived from health state. */
  status: SourceStatusFlag;
  /** Stream manifest rows for the passport table. */
  streams: SourceStreamManifestRow[];
  /** Total retained records across all streams. */
  totalRecords: number;
}

type SourceManifestLike = ConnectorManifestLike & { connector_id: string };

const HEALTHY_STATES = new Set(["healthy", "idle"]);
const DEGRADED_STATES = new Set(["degraded", "cooling_off", "needs_attention"]);

const VERDICT_TONE_STATUS: Record<RefVerdictTone, Pick<SourceStatusFlag, "dot" | "kind" | "tone">> = {
  green: { kind: "healthy", dot: "●", tone: "success" },
  amber: { kind: "degraded", dot: "◐", tone: "warning" },
  red: { kind: "blocked", dot: "⊘", tone: "destructive" },
  grey: { kind: "unknown", dot: "○", tone: "muted" },
};

/**
 * The freshness annotation for a status flag, or `null` when the connection is
 * fresh / carries no freshness evidence. Mandatory whenever the freshness axis
 * is not `fresh`: a healthy connection can still be `stale` (an assisted
 * scheduled connector awaiting a scheduled refresh; see `stale_assisted_refresh`)
 * or `unknown`, and the status flag must disclose that rather than reading a
 * bare "Healthy" that implies up-to-date data.
 */
function deriveFreshnessNote(health: RefConnectionHealthSnapshot | undefined): string | null {
  switch (health?.axes.freshness) {
    case "stale":
      return "stale";
    case "unknown":
      return "freshness unknown";
    default:
      // "fresh", or no freshness evidence at all → nothing to disclose.
      return null;
  }
}

/** Fold a freshness note into a base label, e.g. "Healthy" + "stale" → "Healthy · stale". */
function labelWithFreshness(base: string, note: string | null): string {
  return note ? `${base} · ${note}` : base;
}

/**
 * Map the connection-health `state` and freshness axis (and the durable revoked
 * flag) to the single status flag the list dot, the Endorse badge, and the
 * headline share. Revoked is a lifecycle fact that overrides any health verdict
 * — a revoked connection reads "struck, not erased" regardless of its last
 * health snapshot.
 *
 * Freshness is co-required, not just `state`: a connection that is healthy/idle
 * by state can still be `stale` or `unknown` on the freshness axis, so the flag
 * carries a mandatory `freshnessNote` (folded into `label`) whenever the
 * freshness axis is not `fresh`. This is the Phase-2 honesty fix that stops a
 * stale-but-healthy connection from reading as a bare green "Healthy".
 */
export function deriveSourceStatus(
  health: RefConnectionHealthSnapshot | undefined,
  revoked: boolean
): SourceStatusFlag {
  if (revoked) {
    // A revoked connection is no longer collecting, so its last-known freshness
    // is not a live signal; the struck lifecycle is the whole story.
    return { kind: "revoked", dot: "⊘", tone: "muted", label: "Revoked", freshnessNote: null };
  }
  const state = health?.state;
  const freshnessNote = deriveFreshnessNote(health);
  if (state && HEALTHY_STATES.has(state)) {
    return {
      kind: "healthy",
      dot: "●",
      tone: "success",
      label: labelWithFreshness("Healthy", freshnessNote),
      freshnessNote,
    };
  }
  if (state === "blocked") {
    return {
      kind: "blocked",
      dot: "⊘",
      tone: "destructive",
      label: labelWithFreshness("Blocked", freshnessNote),
      freshnessNote,
    };
  }
  if (state && DEGRADED_STATES.has(state)) {
    return {
      kind: "degraded",
      dot: "◐",
      tone: "warning",
      label: labelWithFreshness(state === "needs_attention" ? "Needs attention" : "Degraded", freshnessNote),
      freshnessNote,
    };
  }
  // state === "unknown", or no projection at all → honest unknown, never green.
  return {
    kind: "unknown",
    dot: "○",
    tone: "muted",
    label: labelWithFreshness("Unknown", freshnessNote),
    freshnessNote,
  };
}

function freshnessNoteFromVerdict(verdict: RefRenderedVerdict): string | null {
  return verdict.annotations.find((annotation) => annotation.kind === "freshness")?.text ?? null;
}

/**
 * Render current references from the server-owned verdict. This is the owner
 * surface migration seam: list-level status reads `pill` and annotations
 * directly, and only older references fall back to `connection_health`.
 */
export function deriveRenderedSourceStatus(
  verdict: RefRenderedVerdict | null | undefined,
  health: RefConnectionHealthSnapshot | undefined,
  revoked: boolean
): SourceStatusFlag {
  if (revoked) {
    return { kind: "revoked", dot: "⊘", tone: "muted", label: "Revoked", freshnessNote: null };
  }
  if (!verdict) {
    return deriveSourceStatus(health, false);
  }
  const status = VERDICT_TONE_STATUS[verdict.pill.tone];
  const freshnessNote = freshnessNoteFromVerdict(verdict);
  return {
    ...status,
    label: labelWithFreshness(verdict.pill.label, freshnessNote),
    freshnessNote,
  };
}

/**
 * Current references carry ordered, typed required actions on the rendered
 * verdict. Only owner-satisfiable actions become a dashboard CTA; maintainer
 * work and wait states are status/detail facts, not dead owner buttons.
 */
function formatRenderedRequiredAction(verdict: RefRenderedVerdict | null | undefined): FormattedNextAction | null {
  if (!verdict) {
    return null;
  }
  const action = verdict.required_actions[0] ?? null;
  if (!action || action.audience !== "owner" || action.satisfied_when.kind === "none") {
    return null;
  }
  return {
    actionTarget: "connection_detail",
    caveat: null,
    label: action.cta,
    notificationHint: null,
    variant: "structured",
  };
}

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;

/** Humanize a schedule interval in seconds (e.g. 86400 → "1d"). */
function formatInterval(seconds: number): string {
  if (!(Number.isFinite(seconds) && seconds > 0)) {
    return "—";
  }
  if (seconds % SECONDS_PER_DAY === 0) {
    return `${seconds / SECONDS_PER_DAY}d`;
  }
  if (seconds % SECONDS_PER_HOUR === 0) {
    return `${seconds / SECONDS_PER_HOUR}h`;
  }
  if (seconds % SECONDS_PER_MINUTE === 0) {
    return `${seconds / SECONDS_PER_MINUTE}m`;
  }
  return `${seconds}s`;
}

/**
 * One-line schedule summary from the effective mode + interval. Honest about
 * "enabled but ineligible" (the scheduler will not run it) so the passport
 * never implies a paused-by-policy schedule is running.
 */
export function formatSchedule(schedule: RefSchedule | null): string {
  if (!schedule) {
    return "manual — no schedule";
  }
  if (schedule.effective_mode === "paused" || !schedule.enabled) {
    return "paused";
  }
  if (schedule.ineligibility_reason) {
    return `every ${formatInterval(schedule.interval_seconds)} · paused by policy`;
  }
  if (schedule.effective_mode === "automatic") {
    return `every ${formatInterval(schedule.interval_seconds)} · automatic`;
  }
  return `every ${formatInterval(schedule.interval_seconds)} · manual`;
}

/**
 * A non-fabricating auth descriptor. The connector summary does not carry a
 * credential surface, so we describe the interaction the next action implies,
 * falling back to a neutral "session / stored credential" line. Never prints a
 * secret or invents a method name.
 */
function deriveAuthLine(
  next: FormattedNextAction | null,
  isLocalDevicePush: boolean,
  manualUploadHref: string | null
): string {
  if (isLocalDevicePush) {
    return "local device push";
  }
  if (manualUploadHref) {
    return "owner file import";
  }
  if (next && next.variant === "structured" && next.label) {
    return "owner action required";
  }
  return "session / stored credential";
}

/** Format a run summary as a short "status · when" line. */
function formatLastRun(run: RefConnectorRunSummary | null): string | null {
  if (!run) {
    return null;
  }
  const status = run.status.replace(/_/g, " ");
  // `last_at` is the most recent event timestamp on the run summary.
  return `${status} · ${run.last_at}`;
}

const EXPLORE_BASE = "/dashboard/explore";

/** Build the Explore deep-link for one connection + stream. */
export function exploreHrefFor(connectionId: string, streamName: string): string {
  const params = new URLSearchParams({ connection: connectionId, stream: streamName });
  return `${EXPLORE_BASE}?${params.toString()}`;
}

function manifestMatchesConnectorId(manifest: SourceManifestLike, connectorId: string): boolean {
  const canonical = canonicalConnectorKey(connectorId);
  return (
    manifest.connector_id === connectorId ||
    manifest.connector_key === connectorId ||
    canonicalConnectorKey(manifest.connector_id) === canonical ||
    (manifest.connector_key ? canonicalConnectorKey(manifest.connector_key) === canonical : false)
  );
}

export function manualUploadHrefForSource(
  summary: Pick<RefConnectorSummary, "connection_id" | "connector_id" | "connector_instance_id">,
  manifests: readonly SourceManifestLike[] | undefined
): string | null {
  const connectionId = summary.connection_id ?? summary.connector_instance_id ?? null;
  if (!(connectionId && manifests)) {
    return null;
  }
  const manifest = manifests.find((candidate) => manifestMatchesConnectorId(candidate, summary.connector_id));
  const setup = manifest ? manualUploadSetupFromManifest(manifest) : null;
  if (!setup?.importDirEnvVar) {
    return null;
  }
  const connectorKey = canonicalConnectorKey(summary.connector_id);
  const params = new URLSearchParams({ connection_id: connectionId });
  return `/dashboard/connect/manual-upload/${encodeURIComponent(connectorKey)}?${params.toString()}`;
}

/** True when the durable lifecycle says this connection is revoked. */
function isRevoked(summary: RefConnectorSummary): boolean {
  return summary.status === "revoked" || Boolean(summary.revoked_at);
}

/**
 * Project one `RefConnectorSummary` into a `SourceInstanceView`. Pure; takes no
 * I/O. The per-stream record counts are not pre-hydrated at the index level
 * (the summary carries only stream names + the connection total), so each row's
 * count is null and the manifest links into Explore for the authoritative read.
 */
export function toSourceInstanceView(
  summary: RefConnectorSummary,
  options: { manifests?: readonly SourceManifestLike[] } = {}
): SourceInstanceView {
  const connectorId = summary.connector_id;
  const connectionId = summary.connection_id ?? null;
  const connectorInstanceId = summary.connector_instance_id ?? null;
  const routeId = connectionId ?? connectorInstanceId ?? connectorId;
  const revoked = isRevoked(summary);
  const isLocalDevicePush = Boolean(summary.local_device_progress);
  const isRunning =
    summary.last_run != null && (summary.last_run.status === "started" || summary.last_run.status === "in_progress");
  const manualUploadHref = manualUploadHrefForSource(summary, options.manifests);

  const displayName = formatConnectorNameForDisplay({
    connectorId,
    displayName: summary.display_name,
    name: summary.connector_display_name,
  });
  const kind = formatConnectorNameForDisplay({
    connectorId,
    displayName: summary.connector_display_name,
    name: summary.connector_display_name,
  });

  const nextAction = summary.rendered_verdict
    ? formatRenderedRequiredAction(summary.rendered_verdict)
    : formatNextAction(summary.connection_health?.next_action ?? summary.next_action ?? null);
  const status = deriveRenderedSourceStatus(summary.rendered_verdict, summary.connection_health, revoked);

  const streams: SourceStreamManifestRow[] = summary.streams.map((name) => ({
    name,
    recordCount: null,
    // The index summary exposes no cursor or searchable flag per stream; render
    // them as unknown rather than guessing. The detail page hydrates these.
    cursor: null,
    searchable: null,
    exploreHref: exploreHrefFor(routeId, name),
  }));

  const passportFields: SourcePassportField[] = [
    { k: "kind", value: kind, mono: true },
    { k: "account", value: displayName },
    { k: "config", value: `${summary.stream_count ?? summary.streams.length} streams`, mono: true },
    { k: "auth", value: deriveAuthLine(nextAction, isLocalDevicePush, manualUploadHref) },
    { k: "schedule", value: formatSchedule(summary.schedule), mono: true },
    { k: "last run", value: formatLastRun(summary.last_run), mono: true },
    { k: "records", value: summary.total_records.toLocaleString(), mono: true },
    { k: "added", value: summary.last_successful_run?.first_at ?? null, mono: true },
  ];

  return {
    id: routeId,
    connectorId,
    connectionId,
    connectorInstanceId,
    detailHref: `/dashboard/records/${encodeURIComponent(routeId)}`,
    displayName,
    kind,
    accountLine: displayName === kind ? kind : `${kind} · ${displayName}`,
    revoked,
    isLocalDevicePush,
    isRunning,
    manualUploadHref,
    status,
    nextAction,
    streams,
    totalRecords: summary.total_records,
    passportFields,
  };
}

/** Map a list of summaries into the Sources view, preserving input order. */
export function toSourcesView(
  summaries: RefConnectorSummary[],
  options: { manifests?: readonly SourceManifestLike[] } = {}
): SourceInstanceView[] {
  return summaries.map((summary) => toSourceInstanceView(summary, options));
}

/**
 * Quiet, serializable version-churn advisory for the Sources surface.
 *
 * The old records page surfaced version churn through `VersionChurnNotice`; the
 * Recordroom Sources redesign replaced that page and dropped the notice. This
 * is the same signal, folded back in honestly: it is metadata only (counts from
 * `/_ref/records/version-stats`, never record payloads) and it reuses the
 * already-tested `summarizeVersionChurn` derivation rather than re-deriving any
 * disposition logic.
 *
 * The Sources surface is informational, not the version-churn remediation
 * console — so this advisory is intentionally lossy: it carries only the
 * headline verdict and the highest-signal line, plus the honest `needsReview`
 * flag, and links the owner to the per-source detail where the full drilldown
 * (dry-run commands, dispositions) lives. The full table is NOT re-rendered here.
 */
export interface SourcesChurnAdvisory {
  /** Honest collapsed verdict from `summarizeVersionChurn` (review-needed vs. classified). */
  headline: string;
  /** "Highest signal: ynab / budgets retains 273.75 versions per current record." */
  highestSignal: string;
  /**
   * True only when at least one churning stream is genuinely unclassified and
   * needs operator review. The view keeps the advisory protocol-toned (quiet,
   * never alarm) regardless; this flag only refines the eyebrow copy.
   */
  needsReview: boolean;
}

/**
 * Project the raw version-stats rows into the quiet Sources advisory, or null
 * when there is nothing to surface.
 *
 * Mirrors the prior page's filter exactly: only non-`normal` risk rows are
 * advisory-worthy (every non-normal row already crossed the route's risk
 * threshold). The disposition-honest headline then comes straight from
 * `summarizeVersionChurn` — this function adds the Sources-specific filter and
 * the null-when-empty contract, and re-derives no disposition itself.
 */
export function buildSourcesChurnAdvisory(rows: readonly RefRecordVersionStatsRow[]): SourcesChurnAdvisory | null {
  const advisoryRows = rows.filter((row) => row.risk_level !== "normal");
  const summary = summarizeVersionChurn(advisoryRows);
  if (!summary) {
    return null;
  }
  return {
    headline: summary.headline,
    highestSignal: summary.highestSignal,
    needsReview: summary.needsReview,
  };
}
