/**
 * Explorer data assembly for /dashboard/explore.
 *
 * Extracted from page.tsx so the inline feed loaders (loadEmptyQueryFeed,
 * loadTimeRangeFeed, loadSearchFeed) are not duplicated if a second surface
 * ever needs them, and so the invariant test can verify the page delegates
 * here by import rather than containing the loaders itself.
 *
 * Calls rs-client functions directly (no sandbox adapter needed in the
 * operator console — the console has no mock-owner surface).
 *
 * No protocol semantics live here — this module only drives the read methods
 * already declared in rs-client.ts.
 */
import {
  buildBlobAffordance,
  buildPeekFields,
  type ExplorerConnectionFacet,
  type ExplorerFeedEntry,
  type ExplorerFieldCapability,
  type ExplorerLens,
  type ExplorerPeekData,
  type ExplorerWarning,
  exactWindowSummaryText,
  parseExplorerPeekParam,
  type RecordsExplorerData,
} from "@/app/dashboard/components/views/records-explorer-view.tsx";
import { formatConnectorNameForDisplay } from "@/app/dashboard/lib/connector-display.ts";
import { classifyRecordKind, type DeclaredFieldTypes } from "@/app/dashboard/lib/record-kind.ts";
import { buildRecordPreview } from "@/app/dashboard/lib/record-preview.ts";
import { listConnectorSummaries, type RefConnectorSummary } from "@/app/dashboard/lib/ref-client.ts";
import {
  getRecord,
  getStreamMetadata,
  isHybridRetrievalAdvertised,
  listConnectorManifests,
  queryRecords,
  type RecordsWindowMeta,
  type SearchResultHit,
  type StreamMetadata,
  type StreamRecord,
  searchRecordsHybrid,
  searchRecordsLexical,
} from "@/app/dashboard/lib/rs-client.ts";
import {
  lookupSearchTimestampMetadata,
  pickSearchDisplayTimestamp,
  type SearchTimestampMetadata,
  searchTimestampMetadataKey,
} from "@/app/dashboard/lib/search-record-timestamps.ts";
import { summarize } from "@/app/dashboard/lib/timeline-summaries.ts";
import { buildPeekReadUrl } from "./peek-read-url.ts";
import { attributeSearchHit, shouldIncludeSearchHit } from "./search-hit-attribution.ts";

// Empty-query fan-out caps. Keeps the recency feed cheap on instances
// with many connections; the user is expected to submit a query to
// narrow further. Search-driven mode is unaffected.
const MAX_FEED_CONNECTIONS = 12;
const MAX_FEED_STREAMS_PER_CONNECTION = 4;
const MAX_FEED_RECORDS_PER_STREAM = 8;
const FEED_TOTAL_CAP = 50;
const TIME_RANGE_RECORDS_PER_STREAM = 50;
const TIME_RANGE_TOTAL_CAP = 500;
const SEARCH_PAGE_LIMIT = 25;

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (typeof v !== "string" || v.length === 0 || seen.has(v)) {
      continue;
    }
    seen.add(v);
    out.push(v);
  }
  return out;
}

function asStringArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.length > 0);
  }
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  return [];
}

function toConnectionFacet(summary: RefConnectorSummary): ExplorerConnectionFacet {
  return {
    connectionId: summary.connection_id,
    connectorId: summary.connector_id,
    displayName: connectorSummaryDisplayName(summary),
    streams: [...(summary.streams ?? [])].sort(),
  };
}

function connectorSummaryDisplayName(summary: RefConnectorSummary): string {
  return formatConnectorNameForDisplay({
    connectorId: summary.connector_id,
    displayName: summary.display_name,
    name: summary.connector_display_name,
  });
}

function summaryByConnectionId(summaries: RefConnectorSummary[]): Map<string, RefConnectorSummary> {
  const map = new Map<string, RefConnectorSummary>();
  for (const s of summaries) {
    map.set(s.connection_id, s);
  }
  return map;
}

function isValidIsoDate(value: string): boolean {
  if (!value) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function parseRecordTimestamp(raw: unknown): number | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw === "number") {
    const ms = raw > 1e12 ? raw : raw * 1000;
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof raw !== "string") {
    return null;
  }
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

function isWithinWindow(ms: number, sinceMs: number | null, untilMs: number | null): boolean {
  if (sinceMs !== null && ms < sinceMs) {
    return false;
  }
  return !(untilMs !== null && ms >= untilMs);
}

function recordData(record: StreamRecord): Record<string, unknown> {
  return record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : {};
}

interface FeedLoadResult {
  entries: ExplorerFeedEntry[];
  exactWindowComplete: boolean;
  exactWindows: RecordsWindowMeta[];
  fromSearch: boolean;
  hybridUsed: boolean;
  truncated: boolean;
  warnings: ExplorerWarning[];
}

interface StreamUiMetadata {
  declaredFieldTypes?: DeclaredFieldTypes;
  fieldCapabilities: ExplorerFieldCapability[];
  fieldNames?: readonly string[];
}

function fieldCapabilitiesFromMetadata(metadata: StreamMetadata | null): ExplorerFieldCapability[] {
  const raw = metadata?.field_capabilities;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [];
  }
  return Object.entries(raw).map(([name, cap]) => {
    const type = typeof cap?.type === "string" && cap.type.length > 0 ? cap.type : undefined;
    const granted = cap?.granted !== false && cap?.usable !== false;
    return {
      name,
      granted,
      ...(type ? { type } : {}),
    };
  });
}

function declaredTypesFromCapabilities(
  capabilities: readonly ExplorerFieldCapability[]
): DeclaredFieldTypes | undefined {
  const entries = capabilities.flatMap((cap) => (cap.type ? [[cap.name, cap.type] as const] : []));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function metadataFieldNames(capabilities: readonly ExplorerFieldCapability[]): readonly string[] | undefined {
  return capabilities.length > 0 ? capabilities.map((cap) => cap.name) : undefined;
}

async function loadStreamUiMetadata(
  summary: RefConnectorSummary,
  streamName: string,
  fallbackDeclaredTypes: DeclaredFieldTypes | undefined,
  fallbackFieldNames: readonly string[] | undefined
): Promise<{ metadata: StreamUiMetadata; warning: ExplorerWarning | null }> {
  try {
    const metadata = await getStreamMetadata(summary.connector_id, streamName, {
      connectorInstanceId: summary.connector_instance_id ?? summary.connection_id,
    });
    const fieldCapabilities = fieldCapabilitiesFromMetadata(metadata);
    return {
      metadata: {
        declaredFieldTypes: declaredTypesFromCapabilities(fieldCapabilities) ?? fallbackDeclaredTypes,
        fieldCapabilities,
        fieldNames: metadataFieldNames(fieldCapabilities) ?? fallbackFieldNames,
      },
      warning: null,
    };
  } catch (err) {
    return {
      metadata: {
        declaredFieldTypes: fallbackDeclaredTypes,
        fieldCapabilities: [],
        fieldNames: fallbackFieldNames,
      },
      warning: {
        code: "search_meta_warning",
        message: `${connectorSummaryDisplayName(summary)} · ${streamName}: stream metadata unavailable; grant projection and blob affordances may be incomplete. ${describeError(err)}`,
      },
    };
  }
}

function exactWindowFromPage(page: { meta?: { window?: RecordsWindowMeta } }): RecordsWindowMeta | null {
  const w = page.meta?.window;
  return typeof w?.total === "number" ? w : null;
}

function mergedExactWindow(
  windows: readonly RecordsWindowMeta[]
): { earliestAt: string | null; latestAt: string | null; total: number } | null {
  if (windows.length === 0) {
    return null;
  }
  const earliest =
    windows
      .map((w) => w.earliest_at)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .sort()[0] ?? null;
  const latest =
    windows
      .map((w) => w.latest_at)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .sort()
      .at(-1) ?? null;
  return {
    earliestAt: earliest,
    latestAt: latest,
    total: windows.reduce((sum, w) => sum + w.total, 0),
  };
}

function activitySummaryForFeed(feed: FeedLoadResult): RecordsExplorerData["activitySummary"] {
  if (feed.exactWindowComplete) {
    const merged = mergedExactWindow(feed.exactWindows);
    if (merged) {
      return {
        source: "exact_window",
        text: exactWindowSummaryText(merged),
      };
    }
  }
  return {
    source: "bounded_sample",
    text: `from the most recent ${feed.entries.length.toLocaleString()} records`,
  };
}

function toTimeRangeEntry({
  consentTimeField,
  declaredFieldTypes,
  fieldCapabilities,
  record,
  sinceMs,
  streamName,
  summary,
  untilMs,
}: {
  consentTimeField: string;
  declaredFieldTypes: DeclaredFieldTypes | undefined;
  fieldCapabilities: readonly ExplorerFieldCapability[];
  record: StreamRecord;
  sinceMs: number | null;
  streamName: string;
  summary: RefConnectorSummary;
  untilMs: number | null;
}): ExplorerFeedEntry | null {
  const data = recordData(record);
  const ms = parseRecordTimestamp(data[consentTimeField]);
  if (ms === null || !isWithinWindow(ms, sinceMs, untilMs)) {
    return null;
  }
  const kind = classifyRecordKind(streamName, data, declaredFieldTypes).kind;
  return {
    blobAffordance: buildBlobAffordance(data, fieldCapabilities) ?? undefined,
    connectorId: summary.connector_id,
    connectionId: summary.connection_id,
    connectionDisplayName: connectorSummaryDisplayName(summary),
    stream: streamName,
    recordId: record.id,
    emittedAt: record.emitted_at,
    displayAt: new Date(ms).toISOString(),
    summary: summarize(summary.connector_id, streamName, data),
    kind,
    preview: buildRecordPreview(kind, data, declaredFieldTypes) ?? undefined,
  };
}

function timeRangeStreamTargets(
  summary: RefConnectorSummary,
  timestampMetadata: ReadonlyMap<string, SearchTimestampMetadata>,
  filterStreams: ReadonlySet<string>
): Array<{ consentTimeField: string; streamName: string }> {
  const targets: Array<{ consentTimeField: string; streamName: string }> = [];
  for (const streamName of summary.streams ?? []) {
    if (filterStreams.size > 0 && !filterStreams.has(streamName)) {
      continue;
    }
    const metadata = lookupSearchTimestampMetadata(timestampMetadata, summary.connector_id, streamName);
    const consentTimeField = metadata?.consent_time_field;
    if (typeof consentTimeField === "string" && consentTimeField.length > 0) {
      targets.push({ consentTimeField, streamName });
    }
  }
  return targets;
}

async function loadEmptyQueryFeed(
  filteredSummaries: RefConnectorSummary[],
  timestampMetadata: ReadonlyMap<string, SearchTimestampMetadata>,
  declaredFieldTypes: ReadonlyMap<string, DeclaredFieldTypes>,
  manifestFieldNames: ReadonlyMap<string, readonly string[]>,
  filterStreams: ReadonlySet<string>
): Promise<FeedLoadResult> {
  // Bounded fan-out: pick the top-N most-recent connections, then for each
  // walk a small set of streams in declaration order.
  const connections = filteredSummaries.slice(0, MAX_FEED_CONNECTIONS);

  type StreamFetchResult =
    | {
        ok: true;
        entries: ExplorerFeedEntry[];
        exactWindow: RecordsWindowMeta | null;
        warning: ExplorerWarning | null;
      }
    | { ok: false; failure: ExplorerWarning };

  const fetches: Promise<StreamFetchResult>[] = [];
  for (const summary of connections) {
    const streams = (summary.streams ?? [])
      .filter((s) => filterStreams.size === 0 || filterStreams.has(s))
      .slice(0, MAX_FEED_STREAMS_PER_CONNECTION);
    for (const streamName of streams) {
      fetches.push(
        (async (): Promise<StreamFetchResult> => {
          const metaKey = searchTimestampMetadataKey(summary.connector_id, streamName);
          const { metadata, warning } = await loadStreamUiMetadata(
            summary,
            streamName,
            declaredFieldTypes.get(metaKey),
            manifestFieldNames.get(metaKey)
          );
          const page = await queryRecords(summary.connector_id, streamName, {
            connectorInstanceId: summary.connector_instance_id ?? summary.connection_id,
            limit: MAX_FEED_RECORDS_PER_STREAM,
            order: "desc",
            window: "exact",
          });
          return {
            ok: true,
            entries: page.data.map((record) => {
              const data = recordData(record);
              const display = pickSearchDisplayTimestamp({
                data,
                emittedAt: record.emitted_at,
                metadata: lookupSearchTimestampMetadata(timestampMetadata, summary.connector_id, streamName),
              });
              const kind = classifyRecordKind(streamName, data, metadata.declaredFieldTypes).kind;
              const entry: ExplorerFeedEntry = {
                blobAffordance: buildBlobAffordance(data, metadata.fieldCapabilities) ?? undefined,
                connectorId: summary.connector_id,
                connectionId: summary.connection_id,
                connectionDisplayName: connectorSummaryDisplayName(summary),
                stream: streamName,
                recordId: record.id,
                emittedAt: record.emitted_at,
                displayAt: display.value,
                summary: summarize(summary.connector_id, streamName, data),
                kind,
                preview: buildRecordPreview(kind, data, metadata.declaredFieldTypes) ?? undefined,
              };
              return entry;
            }),
            exactWindow: exactWindowFromPage(page),
            warning,
          };
        })().catch(
          (err): StreamFetchResult => ({
            ok: false,
            failure: {
              code: "partial_fan_in",
              message: `${connectorSummaryDisplayName(summary)} · ${streamName}: ${describeError(err)}`,
            },
          })
        )
      );
    }
  }

  const results = await Promise.all(fetches);
  const flat: ExplorerFeedEntry[] = [];
  const exactWindows: RecordsWindowMeta[] = [];
  const warnings: ExplorerWarning[] = [];
  let okCount = 0;
  for (const r of results) {
    if (r.ok) {
      okCount += 1;
      flat.push(...r.entries);
      if (r.exactWindow) {
        exactWindows.push(r.exactWindow);
      }
      if (r.warning) {
        warnings.push(r.warning);
      }
    } else {
      warnings.push(r.failure);
    }
  }
  flat.sort((a, b) => (Date.parse(b.displayAt) || 0) - (Date.parse(a.displayAt) || 0));
  const truncated = flat.length > FEED_TOTAL_CAP;
  return {
    entries: flat.slice(0, FEED_TOTAL_CAP),
    exactWindowComplete: okCount > 0 && exactWindows.length === okCount,
    exactWindows,
    fromSearch: false,
    hybridUsed: false,
    truncated,
    warnings,
  };
}

async function loadTimeRangeFeed(
  since: string,
  until: string,
  filteredSummaries: RefConnectorSummary[],
  timestampMetadata: ReadonlyMap<string, SearchTimestampMetadata>,
  declaredFieldTypes: ReadonlyMap<string, DeclaredFieldTypes>,
  manifestFieldNames: ReadonlyMap<string, readonly string[]>,
  filterStreams: ReadonlySet<string>
): Promise<FeedLoadResult> {
  // Time-anchored cross-stream feed. Connection-first so row attribution stays exact.
  const sinceMs = since ? Date.parse(since) : null;
  const untilMs = until ? Date.parse(until) : null;

  type StreamFetchResult =
    | {
        ok: true;
        entries: ExplorerFeedEntry[];
        exactWindow: RecordsWindowMeta | null;
        warning: ExplorerWarning | null;
      }
    | { ok: false; failure: ExplorerWarning };
  const fetches: Promise<StreamFetchResult>[] = [];

  for (const summary of filteredSummaries) {
    for (const { consentTimeField, streamName } of timeRangeStreamTargets(summary, timestampMetadata, filterStreams)) {
      fetches.push(
        (async (): Promise<StreamFetchResult> => {
          const metaKey = searchTimestampMetadataKey(summary.connector_id, streamName);
          const { metadata, warning } = await loadStreamUiMetadata(
            summary,
            streamName,
            declaredFieldTypes.get(metaKey),
            manifestFieldNames.get(metaKey)
          );
          const page = await queryRecords(summary.connector_id, streamName, {
            connectorInstanceId: summary.connector_instance_id ?? summary.connection_id,
            limit: TIME_RANGE_RECORDS_PER_STREAM,
            order: "desc",
            window: "exact",
          });
          return {
            ok: true,
            entries: page.data
              .map((record) =>
                toTimeRangeEntry({
                  consentTimeField,
                  declaredFieldTypes: metadata.declaredFieldTypes,
                  fieldCapabilities: metadata.fieldCapabilities,
                  record,
                  sinceMs,
                  streamName,
                  summary,
                  untilMs,
                })
              )
              .filter((entry): entry is ExplorerFeedEntry => entry !== null),
            exactWindow: exactWindowFromPage(page),
            warning,
          };
        })().catch(
          (err): StreamFetchResult => ({
            ok: false,
            failure: {
              code: "partial_fan_in",
              message: `${connectorSummaryDisplayName(summary)} · ${streamName}: ${describeError(err)}`,
            },
          })
        )
      );
    }
  }

  const results = await Promise.all(fetches);
  const entries: ExplorerFeedEntry[] = [];
  const exactWindows: RecordsWindowMeta[] = [];
  const warnings: ExplorerWarning[] = [];
  let okCount = 0;
  for (const result of results) {
    if (result.ok) {
      okCount += 1;
      entries.push(...result.entries);
      if (result.exactWindow) {
        exactWindows.push(result.exactWindow);
      }
      if (result.warning) {
        warnings.push(result.warning);
      }
    } else {
      warnings.push(result.failure);
    }
  }
  entries.sort((a, b) => (Date.parse(b.displayAt) || 0) - (Date.parse(a.displayAt) || 0));
  const truncated = entries.length > TIME_RANGE_TOTAL_CAP;
  return {
    entries: entries.slice(0, TIME_RANGE_TOTAL_CAP),
    exactWindowComplete: okCount > 0 && exactWindows.length === okCount,
    exactWindows,
    fromSearch: false,
    hybridUsed: false,
    truncated,
    warnings,
  };
}

async function loadSearchFeed(
  query: string,
  filteredSummaries: RefConnectorSummary[],
  filterStreams: ReadonlySet<string>,
  timestampMetadata: ReadonlyMap<string, SearchTimestampMetadata>,
  manifestFieldNames: ReadonlyMap<string, readonly string[]>,
  declaredFieldTypes: ReadonlyMap<string, DeclaredFieldTypes>,
  selectedConnectionIds: ReadonlySet<string>
): Promise<FeedLoadResult> {
  const allowedConnectors = new Set(filteredSummaries.map((s) => s.connector_id));
  const allowedConnectionIds = new Set<string>();
  for (const s of filteredSummaries) {
    allowedConnectionIds.add(s.connection_id);
    if (s.connector_instance_id) {
      allowedConnectionIds.add(s.connector_instance_id);
    }
  }
  const enforceConnectionFilter = selectedConnectionIds.size > 0;
  const hybridAdvertised = await isHybridRetrievalAdvertised();

  const warnings: ExplorerWarning[] = [];
  let hits: SearchResultHit[] = [];
  let hybridUsed = false;
  if (hybridAdvertised) {
    try {
      const page = await searchRecordsHybrid(query, { limit: SEARCH_PAGE_LIMIT });
      hits = page.data;
      hybridUsed = true;
    } catch (err) {
      warnings.push({
        code: "hybrid_unavailable",
        message: `Hybrid retrieval was advertised but failed; fell back to lexical. ${describeError(err)}`,
      });
    }
  }
  if (!hybridUsed) {
    const page = await searchRecordsLexical(query, { limit: SEARCH_PAGE_LIMIT });
    hits = page.data;
  }

  const filtered = hits.filter((h) => {
    if (filterStreams.size > 0 && !filterStreams.has(h.stream)) {
      return false;
    }
    return shouldIncludeSearchHit(h, { allowedConnectors, allowedConnectionIds, enforceConnectionFilter });
  });

  const entries: ExplorerFeedEntry[] = filtered.map((hit) => {
    const display = pickSearchDisplayTimestamp({
      data: null,
      emittedAt: hit.emitted_at,
      metadata: lookupSearchTimestampMetadata(timestampMetadata, hit.connector_id, hit.stream),
    });
    const attribution = attributeSearchHit(hit, filteredSummaries);
    // Search hits carry no record body. Declared field types (when the
    // manifest declares them) are the preferred kind signal; otherwise manifest
    // field names are the heuristic fallback for opaque stream names. Either
    // way only a kind *tag* is derived here — no precise card is built, because
    // buildRecordPreview is gated on an actual record body below.
    const metaKey = searchTimestampMetadataKey(hit.connector_id, hit.stream);
    return {
      connectorId: hit.connector_id,
      connectionId: attribution.connectionId,
      connectionDisplayName: attribution.connectionDisplayName,
      stream: hit.stream,
      recordId: hit.record_key,
      emittedAt: hit.emitted_at,
      displayAt: display.value,
      summary: hit.snippet?.text ?? `${hit.stream}/${hit.record_key}`,
      kind: classifyRecordKind(hit.stream, null, declaredFieldTypes.get(metaKey), manifestFieldNames.get(metaKey)).kind,
      retrievalMode: hit.retrieval_mode ?? (hybridUsed ? "hybrid" : "lexical"),
    };
  });

  return {
    entries,
    exactWindowComplete: false,
    exactWindows: [],
    fromSearch: true,
    hybridUsed,
    truncated: false,
    warnings,
  };
}

function resolvePeekConnection(
  parsed: { connectorId: string; connectionId: string | null },
  byConnectionId: ReadonlyMap<string, RefConnectorSummary>
): RefConnectorSummary | null {
  if (parsed.connectionId) {
    const direct = byConnectionId.get(parsed.connectionId);
    if (direct) {
      return direct;
    }
    for (const summary of byConnectionId.values()) {
      if (summary.connector_instance_id === parsed.connectionId) {
        return summary;
      }
    }
    return null;
  }
  const matches: RefConnectorSummary[] = [];
  for (const summary of byConnectionId.values()) {
    if (summary.connector_id === parsed.connectorId) {
      matches.push(summary);
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

async function buildPeek(
  raw: string | undefined,
  byConnectionId: ReadonlyMap<string, RefConnectorSummary>,
  rsBaseUrl: string
): Promise<ExplorerPeekData | null> {
  const parsed = parseExplorerPeekParam(raw);
  if (!parsed) {
    return null;
  }
  const connection = resolvePeekConnection(parsed, byConnectionId);
  const connectorInstanceId = connection?.connector_instance_id ?? connection?.connection_id ?? null;

  const readUrl = buildPeekReadUrl({
    rsBaseUrl,
    connectorId: parsed.connectorId,
    stream: parsed.stream,
    recordId: parsed.recordId,
    connectorInstanceId,
  });

  try {
    const record = await getRecord(parsed.connectorId, parsed.stream, parsed.recordId, {
      connectorInstanceId,
    });
    const data = recordData(record);
    let fieldCapabilities: ExplorerFieldCapability[] = [];
    try {
      const metadata = await getStreamMetadata(parsed.connectorId, parsed.stream, { connectorInstanceId });
      fieldCapabilities = fieldCapabilitiesFromMetadata(metadata);
    } catch {
      fieldCapabilities = [];
    }
    return {
      fields: buildPeekFields(data, fieldCapabilities),
      connectorId: parsed.connectorId,
      connectionId: connection?.connection_id ?? null,
      connectionDisplayName: connection ? connectorSummaryDisplayName(connection) : null,
      stream: parsed.stream,
      recordId: parsed.recordId,
      emittedAt: record.emitted_at,
      readUrl,
      bodyJson: JSON.stringify(data, null, 2),
      error: null,
    };
  } catch (err) {
    return {
      fields: [],
      connectorId: parsed.connectorId,
      connectionId: connection?.connection_id ?? null,
      connectionDisplayName: connection ? connectorSummaryDisplayName(connection) : null,
      stream: parsed.stream,
      recordId: parsed.recordId,
      emittedAt: "",
      readUrl,
      bodyJson: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface FeedDispatch {
  feed: FeedLoadResult;
  lens: ExplorerLens;
}

async function dispatchFeed(args: {
  query: string;
  since: string;
  until: string;
  filteredSummaries: RefConnectorSummary[];
  filterStreamSet: ReadonlySet<string>;
  timestampMetadata: ReadonlyMap<string, SearchTimestampMetadata>;
  manifestFieldNames: ReadonlyMap<string, readonly string[]>;
  declaredFieldTypes: ReadonlyMap<string, DeclaredFieldTypes>;
  filterConnectionSet: ReadonlySet<string>;
}): Promise<FeedDispatch> {
  const {
    query,
    since,
    until,
    filteredSummaries,
    filterStreamSet,
    timestampMetadata,
    manifestFieldNames,
    declaredFieldTypes,
    filterConnectionSet,
  } = args;
  const hasTimeWindow = since !== "" || until !== "";
  if (query) {
    const feed = await loadSearchFeed(
      query,
      filteredSummaries,
      filterStreamSet,
      timestampMetadata,
      manifestFieldNames,
      declaredFieldTypes,
      filterConnectionSet
    );
    return { feed, lens: hasTimeWindow ? "search_with_ignored_time_window" : "search" };
  }
  if (hasTimeWindow) {
    const feed = await loadTimeRangeFeed(
      since,
      until,
      filteredSummaries,
      timestampMetadata,
      declaredFieldTypes,
      manifestFieldNames,
      filterStreamSet
    );
    return { feed, lens: "time_range" };
  }
  const feed = await loadEmptyQueryFeed(
    filteredSummaries,
    timestampMetadata,
    declaredFieldTypes,
    manifestFieldNames,
    filterStreamSet
  );
  return { feed, lens: "recent" };
}

interface ManifestMetadata {
  /**
   * Declared presentation field types (field name → declared `type`), keyed by
   * connector::stream. Mirrors the read-contract's `field_capabilities[].type`:
   * sourced from `schema.properties[field].x_pdpp_type` or sandbox-shaped
   * `fields[]` / `schema.fields[]` declarations. Only populated for streams
   * whose manifest declares at least one type. Consumed read-only as the
   * preferred card-dispatch signal; never alters filter/grant/retrieval.
   */
  declaredFieldTypes: Map<string, DeclaredFieldTypes>;
  /** Field names from manifest schema.properties, keyed by connector::stream. */
  manifestFieldNames: Map<string, readonly string[]>;
  timestampMetadata: Map<string, SearchTimestampMetadata>;
}

interface ManifestStream {
  consent_time_field?: unknown;
  cursor_field?: unknown;
  fields?: unknown;
  name: string;
  schema?: { properties?: Record<string, unknown>; fields?: unknown };
}

/** A non-empty trimmed string, or null. */
function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Collect declared types from sandbox-shaped `{ name, type }` declarations
 * (`fields[]` / `schema.fields[]`). First declaration of a field name wins;
 * the JSON Schema extension (collected separately) overrides afterwards.
 */
function collectFieldDeclarations(declarations: unknown, out: Record<string, string>): void {
  if (!Array.isArray(declarations)) {
    return;
  }
  for (const decl of declarations) {
    if (!(decl && typeof decl === "object")) {
      continue;
    }
    const name = trimmedString((decl as { name?: unknown }).name);
    const type = trimmedString((decl as { type?: unknown }).type);
    if (name && type && !(name in out)) {
      out[name] = type;
    }
  }
}

/** Collect declared types from `schema.properties[field].x_pdpp_type`. */
function collectSchemaExtensionTypes(props: Record<string, unknown> | undefined, out: Record<string, string>): void {
  if (!(props && typeof props === "object")) {
    return;
  }
  for (const [field, schema] of Object.entries(props)) {
    if (!(schema && typeof schema === "object")) {
      continue;
    }
    const type = trimmedString((schema as { x_pdpp_type?: unknown }).x_pdpp_type);
    if (type) {
      out[field] = type;
    }
  }
}

/**
 * Extract a stream's declared presentation field types from its manifest, the
 * same way the reference server's `buildFieldCapabilities` does:
 *   1. a sandbox-shaped declaration in `fields[]` or `schema.fields[]`
 *      (`{ name, type }`), then
 *   2. `schema.properties[field].x_pdpp_type` (JSON Schema extension), which
 *      takes precedence per field.
 * Returns null when the stream declares no presentation type, so the assembler
 * keeps the current (heuristic) shape for un-annotated manifests.
 */
function extractDeclaredFieldTypes(stream: ManifestStream): DeclaredFieldTypes | null {
  const out: Record<string, string> = {};
  collectFieldDeclarations(stream.fields, out);
  collectFieldDeclarations(stream.schema?.fields, out);
  collectSchemaExtensionTypes(stream.schema?.properties, out);
  return Object.keys(out).length > 0 ? out : null;
}

async function buildManifestMetadata(): Promise<ManifestMetadata> {
  const timestampMetadata = new Map<string, SearchTimestampMetadata>();
  const manifestFieldNames = new Map<string, readonly string[]>();
  const declaredFieldTypes = new Map<string, DeclaredFieldTypes>();
  for (const manifest of await listConnectorManifests()) {
    for (const stream of (manifest.streams ?? []) as ManifestStream[]) {
      const key = searchTimestampMetadataKey(manifest.connector_id, stream.name);
      timestampMetadata.set(key, {
        consent_time_field: typeof stream.consent_time_field === "string" ? stream.consent_time_field : null,
        cursor_field: typeof stream.cursor_field === "string" ? stream.cursor_field : null,
      });
      const props = stream.schema?.properties;
      if (props && typeof props === "object") {
        manifestFieldNames.set(key, Object.keys(props));
      }
      const declared = extractDeclaredFieldTypes(stream);
      if (declared) {
        declaredFieldTypes.set(key, declared);
      }
    }
  }
  return { timestampMetadata, manifestFieldNames, declaredFieldTypes };
}

export interface ExplorerSearchParams {
  connection?: string | string[];
  peek?: string;
  q?: string;
  since?: string;
  stream?: string | string[];
  until?: string;
}

/**
 * Assemble RecordsExplorerData from search params.
 *
 * The live explore page calls this with the RS internal URL; peek and feed
 * logic is not duplicated in page.tsx.
 */
export async function assembleExplorerData(
  params: ExplorerSearchParams,
  rsBaseUrl: string
): Promise<RecordsExplorerData> {
  const query = (params.q ?? "").trim();
  const selectedConnectionIds = uniqueStrings(asStringArray(params.connection));
  const selectedStreams = uniqueStrings(asStringArray(params.stream));
  const rawSince = (params.since ?? "").trim();
  const rawUntil = (params.until ?? "").trim();
  const since = isValidIsoDate(rawSince) ? rawSince : "";
  const until = isValidIsoDate(rawUntil) ? rawUntil : "";

  const response = await listConnectorSummaries();
  const summaries = response.data;

  const connections = summaries.map(toConnectionFacet).sort((a, b) => a.displayName.localeCompare(b.displayName));

  const filterConnectionSet = new Set(selectedConnectionIds);
  const filteredSummaries =
    filterConnectionSet.size > 0 ? summaries.filter((s) => filterConnectionSet.has(s.connection_id)) : summaries;

  const filterStreamSet = new Set(selectedStreams);
  const { timestampMetadata, manifestFieldNames, declaredFieldTypes } = await buildManifestMetadata();

  const { feed: feedResult, lens } = await dispatchFeed({
    query,
    since,
    until,
    filteredSummaries,
    filterStreamSet,
    timestampMetadata,
    manifestFieldNames,
    declaredFieldTypes,
    filterConnectionSet,
  });

  const peek = await buildPeek(params.peek, summaryByConnectionId(summaries), rsBaseUrl);

  const warnings: ExplorerWarning[] = [...feedResult.warnings];
  if (peek?.error) {
    warnings.push({
      code: "peek_unreachable",
      message: `Peek read failed for ${peek.connectorId}/${peek.stream}/${peek.recordId}: ${peek.error}`,
    });
  }

  return {
    activitySummary: feedResult.fromSearch ? null : activitySummaryForFeed(feedResult),
    query,
    connections,
    selectedConnectionIds,
    selectedStreams,
    since,
    until,
    lens,
    fromSearch: feedResult.fromSearch,
    hybridUsed: feedResult.hybridUsed,
    feed: feedResult.entries,
    truncated: feedResult.truncated,
    peek,
    warnings,
  };
}
