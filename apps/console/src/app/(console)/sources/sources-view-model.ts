// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
import { isActiveConnectorRunSummaryStatus } from "../lib/connector-run-summary-status.ts";
import type { FormattedNextAction } from "../lib/next-action.ts";
import type {
  RefConnectorRunSummary,
  RefConnectorRuntimeStatus,
  RefConnectorSummary,
  RefCountState,
  RefRecordVersionStatsRow,
  RefSchedule,
} from "../lib/ref-client.ts";
import {
  isRevokedConnector,
  isSetupInProgressConnector,
  projectSourceActionability,
  type SourceOwnerActionCue,
  type SourcePrimaryVerdictAction,
  type SourceStatusFlag,
} from "../lib/source-actionability.ts";
import { summarizeVersionChurn } from "../lib/version-churn-summary.ts";

/**
 * The status flag rendered against each instance in the list and the passport.
 * Derived from the server-owned `RenderedVerdict.pill` (plus co-required
 * annotations) via `deriveRenderedSourceStatus` in `source-actionability.ts`
 * — the single derivation every owner surface consumes. There is no
 * client-side fallback to raw connection-health `state`: a source with no
 * verdict reads honest "unknown", never a guess reconstructed from raw axes
 * (Wave 10a/10b, 2026-07-09 state-model convergence — see
 * `design-notes/studio-critique-20260709.md`).
 *
 *   ● healthy    — green dot       (verdict tone: green)
 *   ◐ degraded   — amber half-dot  (verdict tone: amber)
 *   ⊘ blocked    — red interdict   (verdict tone: red)
 *   ○ unknown    — muted ring      (no verdict, or verdict tone: grey)
 *   ⊘ revoked    — struck          (revoked lifecycle, overrides the verdict)
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
  pendingDetailGapsIsFloor: boolean;
  pendingDetailGapsLabel: string | null;
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
  /**
   * Orthogonal state for `totalRecords` (`reconcile-active-summary-evidence`
   * design.md "Health boundary"): `"stale"` when the value is carried over
   * from a non-current record_snapshot — a non-authoritative hint, never a
   * proven exact count. `undefined` for a reference predating this field.
   */
  totalRecordsState?: "known" | "known_zero" | "unobserved" | "stale" | "unknown";
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

const DUPLICATE_SOURCE_GROUP_MIN_UNNAMED = 3;

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
 * Single centralized predicate for "is this total_records value an
 * authoritative exact count?" (reconcile-active-summary-evidence design.md
 * "Health boundary", Sol fourth-verdict P1.3: "centralize state-aware count
 * formatting... route every owner-console total_records consumer through
 * it"). Every renderer of a `total_records`/`totalRecords` value — the
 * connector detail-page header, the reactivate-confirmation copy, the
 * SOURCE LIST account line, and the passport's "records" row — MUST check
 * this (directly or via `formatTotalRecordsLabel` below) before treating
 * the number as a proven exact count. `undefined` (a reference predating
 * this field) is treated as authoritative, preserving the exact prior
 * always-numeric rendering for every existing caller.
 */
export function isTotalRecordsAuthoritative(totalRecordsState?: RefCountState): boolean {
  return totalRecordsState === undefined || totalRecordsState === "known" || totalRecordsState === "known_zero";
}

/**
 * Centralized state-aware label for a `total_records` count value, shared
 * by every owner-console surface that renders it as prose (Sol fourth-
 * verdict P1.3). Non-authoritative states never render the number as a
 * confident count:
 *   - `"stale"`: the evidence exists but is not current — the carried-over
 *     number (including a carried-over ZERO — the exact case Sol
 *     reproduced on the primary source-list surface) renders as an
 *     explicitly unverified hint, never bare.
 *   - `"unobserved"`/`"unknown"`: no trustworthy value exists at all — the
 *     unit noun itself (not a number) is rendered as unavailable.
 *   - `"known"`/`"known_zero"`/omitted: the exact prior always-numeric
 *     rendering.
 */
export function formatTotalRecordsLabel(
  totalRecords: number,
  totalRecordsState: RefCountState | undefined,
  unit: string
): string {
  if (totalRecordsState === "stale") {
    return `${totalRecords.toLocaleString()} ${unit} (unverified)`;
  }
  if (totalRecordsState === "unobserved" || totalRecordsState === "unknown") {
    return `${unit} unavailable`;
  }
  return `${totalRecords.toLocaleString()} ${unit}`;
}

/**
 * Connector detail-page header count. A failed/never-observed record
 * snapshot's carried-over `totalRecords` value is a non-authoritative hint,
 * never an authoritative count (reconcile-active-summary-evidence design.md
 * "Health boundary", Sol third-verdict P1.3) — the header must say so rather
 * than rendering it as a confident "N records". `totalRecordsState`
 * `undefined` (a reference predating this field) preserves the exact prior
 * always-numeric rendering.
 */
export function formatConnectorHeaderCount({
  pendingOnDevices,
  streamCount,
  totalRecords,
  totalRecordsState,
}: {
  pendingOnDevices: number;
  streamCount: number;
  totalRecords: number;
  totalRecordsState?: RefCountState;
}): string {
  const streamLabel = `${streamCount} stream${streamCount === 1 ? "" : "s"}`;
  const recordsLabel = formatTotalRecordsLabel(totalRecords, totalRecordsState, "records");
  const base = `${recordsLabel} · ${streamLabel}`;
  if (pendingOnDevices > 0) {
    return `${base} · +${pendingOnDevices.toLocaleString()} pending on devices`;
  }
  return base;
}

/**
 * The record-count clause for the sources-list reactivate-confirmation copy.
 * A stale/unobserved count is a non-authoritative carried-over hint (Sol
 * P1.3) — this copy must not state a specific number it cannot currently
 * back, so it falls back to the same generic phrasing a genuine zero never
 * needed anyway. `totalRecordsState` `undefined` (a reference predating this
 * field) preserves the exact prior >0 numeric behavior.
 */
export function reactivateRecordCopy(totalRecords: number, totalRecordsState?: RefCountState): string {
  return isTotalRecordsAuthoritative(totalRecordsState) && totalRecords > 0
    ? `${totalRecords.toLocaleString()} collected record${totalRecords === 1 ? "" : "s"} are`
    : "collected records are";
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
  primaryAction: SourcePrimaryVerdictAction | null,
  isLocalDevicePush: boolean,
  manualUploadHref: string | null
): string {
  if (isLocalDevicePush) {
    return "local device push";
  }
  if (manualUploadHref) {
    return "owner file import";
  }
  if (primaryAction?.ownerRunnable && primaryAction.kind === "reauth") {
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

const EXPLORE_BASE = "/explore";

/** Build the Explore deep-link for one connection + stream. */
export function exploreHrefFor(connectionId: string, streamName: string): string {
  const params = new URLSearchParams({ connection: connectionId, stream: streamName });
  return `${EXPLORE_BASE}?${params.toString()}`;
}

/**
 * The single "Continue/Open" target for one source row. A draft connection
 * has no `/sources/:id` detail page (there is no health/coverage/schedule
 * evidence to show yet) — its one durable, binding-agnostic status surface
 * is `/connect/status/:id` (`connect/status/[connectionId]/page.tsx`), which
 * already resolves `draft` connections for both static-secret and
 * browser-enrollment-shell setup. Every owner-facing "Continue setup" CTA
 * (list row click, next-action CTA, passport-foot action, and — via
 * `syncs-model.ts`'s shared projection — the Syncs pending-setup card) binds
 * to THIS href, so there is exactly one place a fresh connection resolves
 * to. See fix-pending-connection-discovery design.
 */
export function sourceDetailHrefFor(routeId: string, summary: RefConnectorSummary): string {
  if (isSetupInProgressConnector(summary)) {
    return `/connect/status/${encodeURIComponent(routeId)}`;
  }
  return `/sources/${encodeURIComponent(routeId)}`;
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
  return `/connect/manual-upload/${encodeURIComponent(connectorKey)}?${params.toString()}`;
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

/**
 * The primary sources-LIST account line ("N records · N streams"), and the
 * exact surface Sol's fourth verdict found still rendering a failed/stale
 * `total_records` snapshot as an authoritative count — the header/reactivate
 * copy already used `total_records_state`, but this list line (the visible
 * account line for EVERY source) did not. Routed through the same
 * centralized `formatTotalRecordsLabel` primitive as every other renderer.
 */
function formatSourceListFacts(summary: RefConnectorSummary, streamCountOverride: number | null = null): string {
  const recordCount = Number.isFinite(summary.total_records) ? Math.max(0, Math.floor(summary.total_records)) : 0;
  const recordNoun = recordCount === 1 ? "record" : "records";
  const recordsLabel = formatTotalRecordsLabel(recordCount, summary.total_records_state, recordNoun);
  const streamCountRaw = streamCountOverride ?? summary.stream_count ?? summary.streams.length;
  const streamCount = Number.isFinite(streamCountRaw) ? Math.max(0, Math.floor(streamCountRaw)) : 0;
  const streamNoun = streamCount === 1 ? "stream" : "streams";
  return `${recordsLabel} · ${streamCount.toLocaleString()} ${streamNoun}`;
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
  // Modality is persisted server authority. A missing heartbeat must not
  // resurrect remote Sync controls for a local-device connection.
  const isLocalDevicePush = summary.source_kind === "local_device";
  const isRunning = summary.last_run != null && isActiveConnectorRunSummaryStatus(summary.last_run.status);
  const manualUploadHref = manualUploadHrefForSource(summary, options.manifests);
  const collectionFactsByStream = new Map(
    [...indexCollectionReportByStream(summary.collection_report)].map(([stream, entry]) => [
      stream,
      formatStreamCollectionFacts(entry),
    ])
  );
  const streamRecordsByStream = new Map((summary.stream_records ?? []).map((entry) => [entry.stream, entry]));
  const sourceStreamNames = streamNamesForSource(summary, collectionFactsByStream, streamRecordsByStream);

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
    accountLine = `Unnamed source · ${formatSourceListFacts(summary, sourceStreamNames.length)}`;
  } else {
    accountLine = formatSourceListFacts(summary, sourceStreamNames.length);
  }
  const primaryVerdictAction = actionability.primaryVerdictAction;
  const nextAction = primaryVerdictAction?.ownerRunnable ? null : actionability.nextAction;
  const ownerActionCue = actionability.ownerActionCue;
  const status = actionability.renderedStatus;

  const streams: SourceStreamManifestRow[] = sourceStreamNames.map((name) => {
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
            pendingDetailGapsIsFloor: facts.pendingDetailGapsIsFloor,
            pendingDetailGapsLabel: facts.pendingDetailGapsLabel,
            skipLabel: facts.skipLabel,
            tone: facts.tone,
          }
        : null,
      exploreHref: exploreHrefFor(routeId, name),
    };
  });

  const passportFields: SourcePassportField[] = [
    ...(listKind ? [{ k: "type", value: kind, mono: false } satisfies SourcePassportField] : []),
    { k: "config", value: `${sourceStreamNames.length} streams`, mono: true },
    { k: "auth", value: deriveAuthLine(primaryVerdictAction, isLocalDevicePush, manualUploadHref) },
    { k: "schedule", value: formatSchedule(summary.schedule), mono: true },
    { k: "last run", value: formatLastRun(summary.last_run), mono: true },
    {
      k: "records",
      // Sol fourth-verdict P1.3: the passport independently rendered the
      // raw number, bypassing `total_records_state` entirely — the second
      // of the two concrete authoritative-zero-rendering sites the verdict
      // named on this surface (the list account line above is the first).
      value: isTotalRecordsAuthoritative(summary.total_records_state)
        ? summary.total_records.toLocaleString()
        : formatTotalRecordsLabel(summary.total_records, summary.total_records_state, "records"),
      mono: true,
    },
    { k: "added", value: summary.last_successful_run?.first_at ?? null, mono: true },
  ];

  return {
    id: routeId,
    connectorId,
    connectionId,
    connectorInstanceId,
    detailHref: sourceDetailHrefFor(routeId, summary),
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
    totalRecordsState: summary.total_records_state,
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
      firstUnnamedHref: unnamedItems[0]?.detailHref ?? items[0]?.detailHref ?? "/sources",
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
