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

import { formatConnectorNameForDisplay, isFallbackConnectionLabel } from "@pdpp/operator-ui/lib/connector-display";
import {
  type ConnectorManifestLike,
  canonicalConnectorKey,
  manualUploadSetupFromManifest,
} from "pdpp-reference-implementation/connection-setup-plan";
import { formatStreamCollectionFacts, indexCollectionReportByStream } from "../lib/collection-report.ts";
import type { FormattedNextAction } from "../lib/next-action.ts";
import type {
  RefConnectionHealthSnapshot,
  RefConnectorRunSummary,
  RefConnectorRuntimeStatus,
  RefConnectorSummary,
  RefRecordVersionStatsRow,
  RefSchedule,
} from "../lib/ref-client.ts";
import {
  isRevokedConnector,
  projectSourceActionability,
  type SourceOwnerActionCue,
  type SourcePrimaryVerdictAction,
  type SourceStatusFlag,
} from "../lib/source-actionability.ts";
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
/** One row in the passport's stream manifest table. */
export interface SourceStreamManifestRow {
  /**
   * Per-stream collection facts from the reference's Collection Report. Null
   * means this reference/connector has not supplied stream-level facts yet; the
   * UI must say that honestly instead of rendering blank columns.
   */
  collection: SourceStreamCollectionFacts | null;
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

export interface SourceStreamCollectionFacts {
  countsLabel: string | null;
  countsTitle: string;
  coverageLabel: string;
  coverageTitle: string;
  dispositionLabel: string | null;
  dispositionTitle: string | null;
  pendingDetailGaps: number;
  skipLabel: string | null;
  tone: "danger" | "neutral" | "success" | "warning";
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
  /** Quiet connector type tag for the list row; omitted when it repeats the name. */
  listKind: string | null;
  /** Existing-source import route for manual/upload connectors. */
  manualUploadHref: string | null;
  /** True when the visible label is a generated fallback rather than owner-authored. */
  needsOwnerLabel: boolean;
  /** Owner CTA derived from rendered_verdict.required_actions, or null. */
  nextAction: FormattedNextAction | null;
  /** Compact list-row cue for non-urgent owner-runnable advisory actions. */
  ownerActionCue: SourceOwnerActionCue | null;
  /** Passport KV rows; the title owns identity, so rows only add non-duplicative facts. */
  passportFields: SourcePassportField[];
  /**
   * First server-rendered verdict action, whether or not it is owner-runnable.
   * `nextAction` intentionally filters out maintainer/wait actions; the
   * passport foot still needs this fact so it does not fall back to generic
   * Sync/Reauthorize controls for a source the owner cannot repair.
   */
  primaryVerdictAction: SourcePrimaryVerdictAction | null;
  revoked: boolean;
  /** Status flag (dot + Endorse) derived from rendered verdict, with legacy fallback. */
  status: SourceStatusFlag;
  /** Stream manifest rows for the passport table. */
  streams: SourceStreamManifestRow[];
  /** Total retained records across all streams. */
  totalRecords: number;
}

export interface DuplicateSourceReview {
  connectorId: string;
  firstUnnamedHref: string;
  kind: string;
  total: number;
  unnamed: number;
}

export interface DuplicateSourceGroup {
  connectorId: string;
  items: readonly SourceInstanceView[];
  kind: string;
  total: number;
}

export interface SourcesRuntimeAdvisory {
  headline: string;
  note: string;
}

type SourceManifestLike = ConnectorManifestLike & { connector_id: string };

const HEALTHY_STATES = new Set(["healthy", "idle"]);
const DEGRADED_STATES = new Set(["degraded", "cooling_off", "needs_attention"]);
const DUPLICATE_SOURCE_GROUP_MIN_UNNAMED = 3;

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

function streamNamesForSource(
  summary: RefConnectorSummary,
  collectionFactsByStream: ReadonlyMap<string, unknown>,
  streamRecordsByStream: ReadonlyMap<string, unknown>
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string | null | undefined) => {
    const name = candidate?.trim() ?? "";
    if (!name || seen.has(name)) {
      return;
    }
    seen.add(name);
    names.push(name);
  };

  for (const name of summary.streams) {
    add(name);
  }
  for (const name of collectionFactsByStream.keys()) {
    add(name);
  }
  for (const name of streamRecordsByStream.keys()) {
    add(name);
  }
  return names;
}

function formatSourceListFacts(summary: RefConnectorSummary): string {
  const recordCount = Number.isFinite(summary.total_records) ? Math.max(0, Math.floor(summary.total_records)) : 0;
  const recordNoun = recordCount === 1 ? "record" : "records";
  const streamCountRaw = summary.stream_count ?? summary.streams.length;
  const streamCount = Number.isFinite(streamCountRaw) ? Math.max(0, Math.floor(streamCountRaw)) : 0;
  const streamNoun = streamCount === 1 ? "stream" : "streams";
  return `${recordCount.toLocaleString()} ${recordNoun} · ${streamCount.toLocaleString()} ${streamNoun}`;
}

function normalizeLabelForContainment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function listKindForDisplayName(displayName: string, kind: string): string | null {
  const display = normalizeLabelForContainment(displayName);
  const kindLabel = normalizeLabelForContainment(kind);
  if (!kindLabel || display.includes(kindLabel)) {
    return null;
  }
  return kind;
}

/**
 * Project one `RefConnectorSummary` into a `SourceInstanceView`. Pure; takes no
 * I/O. Per-stream retained record counts come from the owner-only
 * `stream_records` projection; collection facts stay separate because they
 * describe the latest run, not the durable records currently retained.
 */
export function toSourceInstanceView(
  summary: RefConnectorSummary,
  options: { fallbackDisambiguator?: string | null; manifests?: readonly SourceManifestLike[] } = {}
): SourceInstanceView {
  const connectorId = summary.connector_id;
  const connectionId = summary.connection_id ?? null;
  const connectorInstanceId = summary.connector_instance_id ?? null;
  const actionability = projectSourceActionability(summary);
  const routeId = connectionId ?? connectorInstanceId ?? actionability.routeId;
  const revoked = isRevokedConnector(summary);
  const isLocalDevicePush = Boolean(summary.local_device_progress);
  const isRunning =
    summary.last_run != null && (summary.last_run.status === "started" || summary.last_run.status === "in_progress");
  const manualUploadHref = manualUploadHrefForSource(summary, options.manifests);

  const baseDisplayName = formatConnectorNameForDisplay({
    connectorId,
    displayName: summary.display_name,
    name: summary.connector_display_name,
  });
  const hasFallbackLabel = isFallbackConnectionLabel({
    connectorId,
    displayName: summary.display_name,
    name: summary.connector_display_name,
  });
  const kind = formatConnectorNameForDisplay({
    connectorId,
    displayName: summary.connector_display_name,
    name: summary.connector_display_name,
  });

  const displayName = options.fallbackDisambiguator
    ? `${baseDisplayName} · ${options.fallbackDisambiguator}`
    : baseDisplayName;
  const listKind = listKindForDisplayName(displayName, kind);
  let accountLine: string;
  if (hasFallbackLabel) {
    accountLine = `Unnamed source · ${formatSourceListFacts(summary)}`;
  } else {
    accountLine = formatSourceListFacts(summary);
  }
  const nextAction = actionability.nextAction;
  const primaryVerdictAction = actionability.primaryVerdictAction;
  const ownerActionCue = actionability.ownerActionCue;
  const status = actionability.renderedStatus;

  const collectionFactsByStream = new Map(
    [...indexCollectionReportByStream(summary.collection_report)].map(([stream, entry]) => [
      stream,
      formatStreamCollectionFacts(entry),
    ])
  );
  const streamRecordsByStream = new Map((summary.stream_records ?? []).map((entry) => [entry.stream, entry]));
  const streams: SourceStreamManifestRow[] = streamNamesForSource(
    summary,
    collectionFactsByStream,
    streamRecordsByStream
  ).map((name) => {
    const facts = collectionFactsByStream.get(name) ?? null;
    const retained = streamRecordsByStream.get(name) ?? null;
    return {
      name,
      recordCount: retained ? retained.record_count : null,
      // The index summary exposes no cursor or searchable flag per stream;
      // render them as unknown rather than guessing. Collection-report facts
      // are server-owned and safe to show here without another read.
      cursor: null,
      searchable: null,
      collection: facts
        ? {
            countsLabel: facts.countsLabel,
            countsTitle: facts.countsTitle,
            coverageLabel: `${facts.coverage.dimension} · ${facts.coverage.value}`,
            coverageTitle: facts.coverage.title,
            dispositionLabel: facts.disposition ? `Next run: ${facts.disposition.label}` : null,
            dispositionTitle: facts.disposition?.title ?? null,
            pendingDetailGaps: facts.pendingDetailGaps,
            skipLabel: facts.skipLabel,
            tone: facts.tone,
          }
        : null,
      exploreHref: exploreHrefFor(routeId, name),
    };
  });

  const passportFields: SourcePassportField[] = [
    ...(listKind ? [{ k: "type", value: kind, mono: false } satisfies SourcePassportField] : []),
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
    listKind,
    accountLine,
    revoked,
    isLocalDevicePush,
    isRunning,
    manualUploadHref,
    needsOwnerLabel: hasFallbackLabel,
    status,
    nextAction,
    ownerActionCue,
    primaryVerdictAction,
    streams,
    totalRecords: summary.total_records,
    passportFields,
  };
}

export function buildDuplicateSourceReview(instances: readonly SourceInstanceView[]): DuplicateSourceReview[] {
  const byConnector = new Map<string, SourceInstanceView[]>();
  for (const instance of instances) {
    if (instance.revoked) {
      continue;
    }
    const bucket = byConnector.get(instance.connectorId);
    if (bucket) {
      bucket.push(instance);
    } else {
      byConnector.set(instance.connectorId, [instance]);
    }
  }

  const reviews: DuplicateSourceReview[] = [];
  for (const [connectorId, items] of byConnector) {
    const unnamedItems = items.filter((item) => item.needsOwnerLabel);
    if (items.length <= 1 || unnamedItems.length === 0) {
      continue;
    }
    reviews.push({
      connectorId,
      firstUnnamedHref: unnamedItems[0]?.detailHref ?? items[0]?.detailHref ?? "/dashboard/records",
      kind: items[0]?.kind ?? connectorId,
      total: items.length,
      unnamed: unnamedItems.length,
    });
  }
  return reviews.sort((a, b) => b.unnamed - a.unnamed || a.kind.localeCompare(b.kind));
}

export function collapseDuplicateFallbackSources(instances: readonly SourceInstanceView[]): {
  duplicateGroups: readonly DuplicateSourceGroup[];
  visibleActiveInstances: readonly SourceInstanceView[];
} {
  const activeInstances = instances.filter((instance) => !instance.revoked);
  const byConnector = new Map<string, SourceInstanceView[]>();
  for (const instance of activeInstances) {
    if (!instance.needsOwnerLabel) {
      continue;
    }
    const bucket = byConnector.get(instance.connectorId);
    if (bucket) {
      bucket.push(instance);
    } else {
      byConnector.set(instance.connectorId, [instance]);
    }
  }

  const duplicateGroups: DuplicateSourceGroup[] = [];
  const groupedIds = new Set<string>();
  for (const [connectorId, items] of byConnector) {
    if (items.length < DUPLICATE_SOURCE_GROUP_MIN_UNNAMED) {
      continue;
    }
    for (const item of items) {
      groupedIds.add(item.id);
    }
    duplicateGroups.push({
      connectorId,
      items,
      kind: items[0]?.kind ?? connectorId,
      total: items.length,
    });
  }

  return {
    duplicateGroups: duplicateGroups.sort((a, b) => b.total - a.total || a.kind.localeCompare(b.kind)),
    visibleActiveInstances: activeInstances.filter((instance) => !groupedIds.has(instance.id)),
  };
}

/** Map a list of summaries into the Sources view, preserving input order. */
export function toSourcesView(
  summaries: RefConnectorSummary[],
  options: { manifests?: readonly SourceManifestLike[] } = {}
): SourceInstanceView[] {
  const fallbackCountByConnector = new Map<string, number>();
  for (const summary of summaries) {
    if (
      isFallbackConnectionLabel({
        connectorId: summary.connector_id,
        displayName: summary.display_name,
        name: summary.connector_display_name,
      })
    ) {
      fallbackCountByConnector.set(summary.connector_id, (fallbackCountByConnector.get(summary.connector_id) ?? 0) + 1);
    }
  }
  const fallbackOrdinalByConnector = new Map<string, number>();
  return summaries.map((summary) => {
    const isAmbiguousFallback =
      (fallbackCountByConnector.get(summary.connector_id) ?? 0) > 1 &&
      isFallbackConnectionLabel({
        connectorId: summary.connector_id,
        displayName: summary.display_name,
        name: summary.connector_display_name,
      });
    if (!isAmbiguousFallback) {
      return toSourceInstanceView(summary, options);
    }
    const ordinal = (fallbackOrdinalByConnector.get(summary.connector_id) ?? 0) + 1;
    fallbackOrdinalByConnector.set(summary.connector_id, ordinal);
    return toSourceInstanceView(summary, { ...options, fallbackDisambiguator: `account ${ordinal}` });
  });
}

/**
 * Project the one global runtime status into the Sources page advisory. Runtime
 * faults are not per-source attention events: the rendered verdict caps every
 * connection channel at calm, and this single banner carries the global cause.
 */
export function buildSourcesRuntimeAdvisory(
  runtime: RefConnectorRuntimeStatus | null | undefined
): SourcesRuntimeAdvisory | null {
  if (!runtime || runtime.ok) {
    return null;
  }
  return {
    headline: runtime.label,
    note: runtime.message ?? "Saved records remain available. Collection resumes when the reference runtime is back.",
  };
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
