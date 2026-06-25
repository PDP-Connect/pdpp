/**
 * Shared Explorer data assembly, parameterized by a DashboardDataSource adapter.
 *
 * Both /dashboard/explore (live, liveDashboardDataSource) and /sandbox/explore
 * (mock-owner, sandboxDashboardDataSource) call assembleExplorerData. The live
 * page additionally handles auth and ReferenceServerUnreachableError boundaries;
 * the sandbox page supplies SANDBOX_RS_EXAMPLE_BASE as the rsBaseUrl config.
 *
 * No protocol semantics live here — this module only drives the read methods
 * already declared on DashboardDataSource.
 */
import {
  buildBlobAffordance,
  buildPeekFields,
  type ExploreBucketRequest,
  type ExplorerConnectionFacet,
  type ExplorerFeedEntry,
  type ExplorerFieldCapability,
  type ExplorerLens,
  type ExplorerPeekData,
  type ExplorerStreamDoor,
  type ExplorerStreamSeeAllLink,
  type ExplorerWarning,
  exactWindowSummaryText,
  parseExplorerPeekParam,
  type RecordsExplorerData,
} from "../components/views/records-explorer-view.tsx";
import { formatConnectorNameForDisplay } from "../lib/connector-display.ts";
import type { DashboardDataSource } from "../lib/data-source.ts";
import {
  type DeclaredFieldRoles,
  EMPTY_DECLARED_FIELD_ROLES,
  type FieldRole,
  parseFieldRole,
} from "../lib/declared-field-roles.ts";
import { classifyRecordKind, type DeclaredFieldTypes } from "../lib/record-kind.ts";
import { buildRecordPreview } from "../lib/record-preview.ts";
import type { ExploreTimelinePage, RefConnectorSummary } from "../lib/ref-client.ts";
import type { RecordsWindowMeta, SearchRecallMeta, SearchResultPage, StreamMetadata } from "../lib/rs-client.ts";
import {
  lookupSearchTimestampMetadata,
  pickSearchDisplayTimestamp,
  type SearchTimestampMetadata,
  searchTimestampMetadataKey,
} from "../lib/search-record-timestamps.ts";
import { chartIsVisible } from "./over-time-chart.ts";
import { buildPeekReadUrl } from "./peek-read-url.ts";
import { attributeSearchHit, shouldIncludeSearchHit } from "./search-hit-attribution.ts";
import type { SetDescriptor } from "./set-descriptor.ts";

// Recent-lens bound. The empty-query feed is a single merged-timeline endpoint
// call (listExploreTimeline) capped at FEED_TOTAL_CAP for a cheap first paint;
// the old per-stream fan-out caps were removed with that fan-out.
const FEED_TOTAL_CAP = 32;
// The Upcoming (future) set is BOUNDED — its count is exact precisely because it is
// cheap to count, so it is cheap to fetch. "Load more upcoming" therefore loads a
// LARGE page (the operation's max) so ONE click reveals the whole set in the common
// case (e.g. 188 YNAB future month_categories), instead of dripping 32 at a time.
// Only a truly huge future set (> this) needs a second click.
const UPCOMING_PAGE_LIMIT = 500;
const TIME_RANGE_RECORDS_PER_STREAM = 50;
const TIME_RANGE_TOTAL_CAP = 500;
const SEARCH_PAGE_LIMIT = 25;
/** Shared empty set: the no-op default for the optional exclusion filter. */
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

// ─── Composite fan-out cursor (P3 merged-timeline integration point) ──────────
//
// The merged-timeline endpoint's `next_cursor` is OPAQUE: the assembler and canvas
// pass it back verbatim and never parse it. (The reference returns a short
// server-side handle backing a composite per-partition payload; the assembler does
// not depend on that form.) The canvas URL contract (`cursor` param) and the "N new"
// pill semantics are unchanged regardless of the cursor's internal encoding.

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

// Lexical search hits carry `<mark>…</mark>` highlight markup in snippet.text.
// The feed renders the snippet as plain React text (no dangerouslySetInnerHTML —
// guarded), so raw markup would surface as literal "<mark>…</mark>" in the row.
// Strip the highlight tags and decode the handful of entities the markup wrapper
// can introduce, leaving clean human text. (A semantic highlight model can be
// reintroduced later; this just stops the raw-tag leak.)
export function plainSnippetText(text: string): string {
  return text
    .replace(/<\/?mark>/gi, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** One run of a search snippet: `marked` runs are the matched terms (rendered bold). */
export interface SnippetSegment {
  marked: boolean;
  text: string;
}

// Decode the handful of entities the highlight wrapper can introduce. Same set as
// plainSnippetText; kept inline so this stays a self-contained pure helper.
function decodeSnippetEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Parse a lexical-search snippet (`…<mark>term</mark>…`) into ordered segments, so the
 * matched terms can be rendered BOLD as real React elements — NEVER via
 * dangerouslySetInnerHTML (XSS-safe). The marks are the server's honest match highlight;
 * decoding happens per segment. Non-marked text and marked text interleave in order.
 * Returns a single non-marked segment when there is no <mark> markup.
 */
export function snippetSegments(text: string): readonly SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  const re = /<mark>([\s\S]*?)<\/mark>/gi;
  let lastIndex = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    if (m.index > lastIndex) {
      segments.push({ marked: false, text: decodeSnippetEntities(text.slice(lastIndex, m.index)) });
    }
    segments.push({ marked: true, text: decodeSnippetEntities(m[1] ?? "") });
    lastIndex = m.index + m[0].length;
    m = re.exec(text);
  }
  if (lastIndex < text.length) {
    segments.push({ marked: false, text: decodeSnippetEntities(text.slice(lastIndex)) });
  }
  return segments.filter((s) => s.text.length > 0);
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

/**
 * Parse the recent-lens accumulating cursor TRAIL from the `cursors` param. Each
 * value is comma-joined (mirroring the per-stream pager), so split and drop empties.
 * Empty result = first page.
 */
function parseCursorTrail(value: string | string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of asStringArray(value)) {
    for (const cursor of raw.split(",")) {
      if (cursor.length > 0) {
        out.push(cursor);
      }
    }
  }
  return out;
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

/**
 * Owner-facing source label for a peek-read failure. Falls back to a generic
 * "this source" when the connection's display name is unknown, so the warning
 * copy never reaches the owner empty or with an internal id.
 */
function peekSourceLabel(connectionDisplayName: string | null): string {
  return connectionDisplayName ?? "this source";
}

// ─── Fan-in failure classification ────────────────────────────────
//
// A per-stream read can fail for two very different reasons:
//
//   • EXPECTED-PERMANENT — the connection is revoked/inactive, the grant
//     doesn't cover the stream, or the stream was dropped from the manifest
//     (404). A revoked connection simply has no live records to read; this is
//     a normal steady state, not an error the owner must act on. These are
//     summarized into ONE humane "partial view" warning — never spilled as
//     raw RS envelopes into the reading room.
//
//   • UNEXPECTED — a real server fault (5xx) or anything we can't recognize.
//     These keep a terse diagnostic so a genuine outage stays visible, but
//     still never dump the raw JSON envelope.
//
// Classification is duck-typed off the error MESSAGE so this package stays
// decoupled from the console's ResourceServerHttpError class. The live RS
// error message embeds the JSON envelope (`{"error":{"code":...}}`) plus an
// HTTP status (`failed (4xx)`), which is the honest signal we match on.

export interface FanInFailure {
  connectionName: string;
  /** True for revoked/inactive/not-granted/manifest-dropped reads. */
  expected: boolean;
  /** Short, owner-safe reason ("revoked", "no longer granted", …). */
  reason: string;
  stream: string;
}

const ENVELOPE_CODE_RE = /"code"\s*:\s*"([^"]+)"/;
const HTTP_STATUS_RE = /failed \((\d{3})\)/;

/** Parse an `error.code` out of an embedded RS JSON envelope, if present. */
function envelopeErrorCode(message: string): string | null {
  const match = message.match(ENVELOPE_CODE_RE);
  return match?.[1] ?? null;
}

/** Parse the HTTP status out of a `… failed (404): …` message, if present. */
function httpStatusFromMessage(message: string): number | null {
  const match = message.match(HTTP_STATUS_RE);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

const EXPECTED_PERMANENT_CODES = new Set([
  "connector_instance_inactive",
  "connection_revoked",
  "grant_not_found",
  "stream_not_granted",
  "not_granted",
  "stream_not_found",
]);

/**
 * Classify a per-stream read failure as expected-permanent (revoked / inactive
 * / not-granted / manifest-dropped) vs unexpected, and derive an owner-safe
 * reason. Never returns the raw envelope.
 */
export function classifyFanInFailure(err: unknown): { expected: boolean; reason: string } {
  const message = describeError(err);
  const code = envelopeErrorCode(message);
  const status = httpStatusFromMessage(message);
  const lower = message.toLowerCase();

  if (code === "connector_instance_inactive" || lower.includes("not active") || lower.includes("is 'revoked'")) {
    return { expected: true, reason: "revoked or inactive" };
  }
  if (code === "stream_not_found" || (status === 404 && !code)) {
    return { expected: true, reason: "no longer available" };
  }
  if (
    (code && EXPECTED_PERMANENT_CODES.has(code)) ||
    status === 403 ||
    lower.includes("not granted") ||
    lower.includes("forbidden")
  ) {
    return { expected: true, reason: "not granted" };
  }
  // Unexpected: keep a terse, envelope-free diagnostic.
  let codePart = "read failed";
  if (code) {
    codePart = code;
  } else if (status) {
    codePart = `HTTP ${status}`;
  }
  return { expected: false, reason: codePart };
}

/**
 * Fold per-stream fan-in failures into at most two warnings — one humane
 * "partial view" summary for expected-permanent failures (revoked/inactive/
 * not-granted) and one terse diagnostic for unexpected faults — instead of one
 * raw-envelope row per failed stream. Stable, deduped `partial_fan_in` codes
 * keep the renderer free of duplicate React keys.
 */
export function summarizeFanInFailures(failures: readonly FanInFailure[]): ExplorerWarning[] {
  if (failures.length === 0) {
    return [];
  }
  const warnings: ExplorerWarning[] = [];
  const expected = failures.filter((f) => f.expected);
  const unexpected = failures.filter((f) => !f.expected);

  if (expected.length > 0) {
    const connections = uniqueStrings(expected.map((f) => f.connectionName));
    const streamWord = expected.length === 1 ? "stream" : "streams";
    const connWord = connections.length === 1 ? "source" : "sources";
    warnings.push({
      code: "partial_fan_in",
      message: `Partial view — ${expected.length} ${streamWord} from ${connections.length} revoked or inactive ${connWord} can't be read (${connections.join(", ")}). Manage them in Sources.`,
    });
  }

  if (unexpected.length > 0) {
    const connections = uniqueStrings(unexpected.map((f) => f.connectionName));
    const streamWord = unexpected.length === 1 ? "stream" : "streams";
    warnings.push({
      code: "partial_fan_in_error",
      message: `Partial view — ${unexpected.length} ${streamWord} from ${connections.join(", ")} didn't answer (${uniqueStrings(unexpected.map((f) => f.reason)).join(", ")}).`,
    });
  }

  return warnings;
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

function recordData(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

interface FeedLoadResult {
  /**
   * SET-DESCRIPTOR: typed discriminated union declaring the completeness and ordering of
   * this result set. The canvas switches on descriptor.kind to decide what it may claim.
   * A relevance_bounded descriptor structurally prevents a "newest first" or "complete"
   * claim; a complete_chronological descriptor enables both. No ad-hoc flags override this.
   */
  descriptor: SetDescriptor;
  entries: ExplorerFeedEntry[];
  exactWindowComplete: boolean;
  exactWindows: RecordsWindowMeta[];
  fromSearch: boolean;
  hybridUsed: boolean;
  /**
   * Count of records not yet in the feed whose emitted_at > snapshotAnchor.
   * Null on the first page load (no prior anchor to compare).
   */
  newSinceAnchor: number | null;
  /**
   * Composite cursor for the next page of the fan-out feed (recent/time-range lenses).
   * Null for search feeds (use searchNextCursor) or when all partitions are exhausted.
   * INTEGRATION POINT: replace with /v1/explore/records next_cursor when that ships.
   */
  nextCursor: string | null;
  /** True when there are more search results reachable via cursor (lexical mode only). */
  searchHasMore: boolean;
  /** Opaque cursor for the next page of lexical search results; null when not applicable. */
  searchNextCursor: string | null;
  /**
   * ISO timestamp of the snapshot anchor for point-in-time stability.
   * Forwarded unchanged across pages so scroll position stays stable.
   */
  snapshotAnchor: string | null;
  /** Per-source escape door, populated when all hits come from one connection+stream. */
  streamDoor: ExplorerStreamDoor | null;
  /**
   * Escape ramps for streams that are bounded/truncated. For each stream with has_more=true
   * or whose entries are cut by the merge cap, carries the identity + exact total (when known)
   * so the UI can render "Amazon - Orders - 1,183 records - See all" linking to the per-stream
   * page. Empty for search-driven feeds.
   */
  streamSeeAllLinks: ExplorerStreamSeeAllLink[];
  truncated: boolean;
  /**
   * Future-dated records (server's separate Upcoming projection), FORWARD-
   * chronological. Only the recent merged-timeline lens populates this; search/
   * time-range lenses leave it empty (no future/past boundary there). The server
   * OWNS the split — the client renders these as the collapsed "Upcoming" section
   * and never re-derives the boundary.
   */
  upcoming?: ExplorerFeedEntry[];
  /** True when more future records exist beyond the loaded `upcoming` head. */
  upcomingHasMore?: boolean;
  /**
   * Opaque cursor for the NEXT page of Upcoming (future) records (count==
   * reachability: walk the future set to exhaustion, not just a capped head).
   * Null when the future set is fully loaded. From page 1's `upcoming_next_cursor`.
   */
  upcomingNextCursor?: string | null;
  /** True server-side count of ALL future records, for the "N upcoming" pill. */
  upcomingTotal?: number;
  warnings: ExplorerWarning[];
}

interface StreamUiMetadata {
  declaredFieldTypes?: DeclaredFieldTypes;
  fieldCapabilities: ExplorerFieldCapability[];
  fieldNames?: readonly string[];
}

export function fieldCapabilitiesFromMetadata(metadata: StreamMetadata | null): ExplorerFieldCapability[] {
  const raw = metadata?.field_capabilities;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [];
  }
  return Object.entries(raw).map(([name, cap]) => {
    const type = typeof cap?.type === "string" && cap.type.length > 0 ? cap.type : undefined;
    // Declared presentation ROLE (field_capabilities[].role), additive + optional.
    const rawRole = (cap as { role?: unknown } | null | undefined)?.role;
    const role = typeof rawRole === "string" && rawRole.length > 0 ? rawRole : undefined;
    const granted = cap?.granted !== false && cap?.usable !== false;
    return {
      name,
      granted,
      ...(type ? { type } : {}),
      ...(role ? { role } : {}),
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

/**
 * Declared presentation-ROLE map for a stream (the seam for design.md §5.2/§5.3).
 *
 * This is the parallel of `declaredTypesFromCapabilities`, but for ROLE (which
 * field is the title vs body vs actor vs amount) rather than TYPE. The
 * `x_pdpp_role` vocabulary is LIVE (Codex-approved 2026-06-21): this is the
 * SINGLE place that reads declared roles off the stream's capabilities
 * (`field_capabilities[].role`, sourced from the manifest) into a
 * `DeclaredFieldRoles` map; `buildRecordPreview` consumes it, so typed cards
 * render from declarations with ZERO further client change. A stream that
 * declares no roles resolves to the empty map, so its records take the honest
 * generic card.
 */
export function declaredRolesFromCapabilities(capabilities: readonly ExplorerFieldCapability[]): DeclaredFieldRoles {
  // Read the declared ROLE off each field's capability (field_capabilities[].role,
  // sourced from the manifest's `x_pdpp_role`). Unknown roles are dropped by
  // parseFieldRole so they degrade to the honest generic fallback (Codex #2), never
  // a field-name guess. Empty when no field declares a role → undeclared records
  // take the generic key/value card. This is the SINGLE manifest→role seam.
  const entries: [string, FieldRole][] = [];
  for (const cap of capabilities) {
    const role = parseFieldRole(cap.role);
    if (role) {
      entries.push([cap.name, role]);
    }
  }
  return entries.length > 0 ? (Object.fromEntries(entries) as DeclaredFieldRoles) : EMPTY_DECLARED_FIELD_ROLES;
}

// The default recent feed is an owner-console overview. It can use manifest
// declarations for presentation hints without blocking first paint on
// grant-aware per-stream metadata; deep paths (time-window and peek) still load
// actual stream metadata before rendering withheld fields.
function manifestFieldCapabilities(
  declaredFieldTypes: DeclaredFieldTypes | undefined,
  fieldNames: readonly string[] | undefined
): ExplorerFieldCapability[] {
  if (!(declaredFieldTypes || fieldNames)) {
    return [];
  }
  const names = new Set<string>(fieldNames ?? Object.keys(declaredFieldTypes ?? {}));
  for (const name of Object.keys(declaredFieldTypes ?? {})) {
    names.add(name);
  }
  return [...names].map((name) => {
    const type = declaredFieldTypes?.[name];
    return {
      name,
      granted: true,
      ...(type ? { type } : {}),
    };
  });
}

function streamUiMetadataFromManifest(
  declaredFieldTypes: DeclaredFieldTypes | undefined,
  fieldNames: readonly string[] | undefined
): StreamUiMetadata {
  return {
    declaredFieldTypes,
    fieldCapabilities: manifestFieldCapabilities(declaredFieldTypes, fieldNames),
    fieldNames,
  };
}

async function loadStreamUiMetadata(
  dataSource: DashboardDataSource,
  summary: RefConnectorSummary,
  streamName: string,
  fallbackDeclaredTypes: DeclaredFieldTypes | undefined,
  fallbackFieldNames: readonly string[] | undefined
): Promise<{ metadata: StreamUiMetadata; warning: ExplorerWarning | null }> {
  try {
    const metadata = await dataSource.getStreamMetadata(summary.connector_id, streamName, {
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
    // Owner-facing copy carries no engine/implementation vocabulary and no raw
    // error detail. The source/stream name is genuinely useful and stays; the
    // raw error and impl-nouns ("grant projection", "blob affordances") are
    // debug evidence — logged server-side, never rendered to the owner.
    console.warn(
      `[explore] search metadata unavailable for ${connectorSummaryDisplayName(summary)} · ${streamName}: ${describeError(err)}`
    );
    return {
      metadata: {
        declaredFieldTypes: fallbackDeclaredTypes,
        fieldCapabilities: [],
        fieldNames: fallbackFieldNames,
      },
      warning: {
        code: "search_meta_warning",
        message: `${connectorSummaryDisplayName(summary)} · ${streamName}: some details for this source may be incomplete right now.`,
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
      // `total` is the load-bearing exact denominator: the canvas reads it as
      // `exactTotal` to render "Showing N of M records in this stream". Only an
      // exact whole-window aggregate may carry it.
      return {
        source: "exact_window",
        text: exactWindowSummaryText(merged),
        total: merged.total,
      };
    }
  }
  if (feed.fromSearch) {
    // A lexical candidate window is a bounded sample, not a corpus count. When
    // the search page is page-limited (searchHasMore), say so plainly and point
    // to the per-stream escape; never imply a complete result set.
    if (feed.truncated || feed.searchHasMore) {
      return {
        source: "bounded_sample",
        text: `first ${feed.entries.length.toLocaleString()} search results; narrow the query or open a result's stream for full records`,
      };
    }
    return {
      source: "bounded_sample",
      text: `${feed.entries.length.toLocaleString()} search results returned`,
    };
  }
  if (feed.truncated) {
    return {
      source: "bounded_sample",
      text: "recent sample; select a row to open that stream's full records",
    };
  }
  return {
    source: "bounded_sample",
    text: `from the most recent ${feed.entries.length.toLocaleString()} records`,
  };
}

/**
 * Map one ExploreTimelineRecord from the real /_ref/explore/records endpoint
 * into an ExplorerFeedEntry using manifest metadata for kind/preview hints.
 */
function timelineRecordToEntry(
  rec: ExploreTimelinePage["data"][number],
  filteredSummaries: readonly RefConnectorSummary[],
  declaredFieldTypes: ReadonlyMap<string, DeclaredFieldTypes>,
  declaredFieldRoles: ReadonlyMap<string, DeclaredFieldRoles>,
  manifestFieldNames: ReadonlyMap<string, readonly string[]>,
  timestampMetadata: ReadonlyMap<string, SearchTimestampMetadata>
): ExplorerFeedEntry {
  const metaKey = searchTimestampMetadataKey(rec.connector_id, rec.stream);
  const data =
    rec.data && typeof rec.data === "object" && !Array.isArray(rec.data) ? (rec.data as Record<string, unknown>) : {};
  const dtypes = declaredFieldTypes.get(metaKey);
  const fnames = manifestFieldNames.get(metaKey);
  const fieldCapabilities = manifestFieldCapabilities(dtypes, fnames);
  // Declared presentation ROLES for this stream — read STRAIGHT from the manifest
  // role cache (keyed by connector::stream), exactly like declaredFieldTypes above.
  // (Previously this re-derived roles from manifestFieldCapabilities, which carries
  // TYPES only — so every feed row dropped its declared roles and fell to the
  // generic "Id:" card. The role no longer round-trips through capabilities.)
  // Undeclared streams resolve to EMPTY_DECLARED_FIELD_ROLES → the honest generic card.
  const droles = declaredFieldRoles.get(metaKey) ?? EMPTY_DECLARED_FIELD_ROLES;
  const kind = classifyRecordKind(rec.stream, data, dtypes, undefined, droles).kind;
  // Prefer the server's authoritative SEMANTIC time — the exact value the timeline
  // is ORDERED by — so display == sort by construction. Re-deriving from manifest
  // metadata is the seam that silently showed emitted_at when the per-connector
  // metadata lookup missed (the canonical-connector-key bug). Fall back to the local
  // derivation only when an older server omits semantic_time.
  const displayValue =
    typeof rec.semantic_time === "string" && rec.semantic_time.length > 0
      ? rec.semantic_time
      : pickSearchDisplayTimestamp({
          data,
          emittedAt: rec.emitted_at,
          metadata: lookupSearchTimestampMetadata(timestampMetadata, rec.connector_id, rec.stream),
        }).value;
  // Resolve connection identity from the known summaries (best-effort).
  // F3 fix: prefer matching by connector_instance_id (connection INSTANCE) so a
  // record whose connector_id (type) is "amazon" resolves to the specific Amazon
  // connection — not just any connection of the same type. Fall back to
  // connector_id match only when connector_instance_id is absent/unrecognized
  // (e.g. older RS builds that do not emit the field).
  const summary =
    filteredSummaries.find(
      (s) => s.connection_id === rec.connector_instance_id || s.connector_instance_id === rec.connector_instance_id
    ) ??
    // Fallback: match by connector type (correct only when there is exactly
    // one connection of that type visible to this owner).
    filteredSummaries.find((s) => s.connector_id === rec.connector_id) ??
    null;
  // connectionId must be the INSTANCE id for per-connection API reads and URLs.
  const connectionId = summary?.connection_id ?? rec.connector_instance_id;
  const connectionDisplayName = summary
    ? connectorSummaryDisplayName(summary)
    : formatConnectorNameForDisplay({ connectorId: rec.connector_id });
  return {
    blobAffordance: buildBlobAffordance(data, fieldCapabilities) ?? undefined,
    connectorId: rec.connector_id,
    connectionId,
    connectionDisplayName,
    stream: rec.stream,
    recordId: rec.record_key,
    emittedAt: rec.emitted_at,
    displayAt: displayValue,
    // No `summary`: a body-backed timeline row renders from declared-role `preview`
    // slots (rowPrimary/rowSecondary), never the old field-name-guessing summarize().
    kind,
    preview: buildRecordPreview(kind, data, dtypes, droles) ?? undefined,
  };
}

/**
 * Map one merged-timeline page's records to ExplorerFeedEntry list, applying the
 * defence-in-depth connection/stream scope filter. The endpoint already scopes by
 * connection/stream, so this filter only catches a misconfigured/older endpoint
 * that ignored the request scope.
 */
function mergedTimelinePageEntries(
  page: ExploreTimelinePage,
  filteredSummaries: RefConnectorSummary[],
  declaredFieldTypes: ReadonlyMap<string, DeclaredFieldTypes>,
  declaredFieldRoles: ReadonlyMap<string, DeclaredFieldRoles>,
  manifestFieldNames: ReadonlyMap<string, readonly string[]>,
  filterStreams: ReadonlySet<string>,
  filterConnections: ReadonlySet<string>,
  allowedInstanceIds: ReadonlySet<string>,
  timestampMetadata: ReadonlyMap<string, SearchTimestampMetadata>,
  // EXCLUSION (facet "is not" / `-con:`/`-stream:`). The PRIMARY mechanism is now
  // SERVER-SIDE (the endpoint excludes excluded partitions at enumeration, so counts
  // stay exact). This client-side drop is DEFENCE-IN-DEPTH — the same belt-and-braces
  // pattern as the `allowedInstanceIds` include filter — and is a no-op in practice
  // because excluded rows never arrive. Empty sets exclude nothing.
  exclude: { instanceIds: ReadonlySet<string>; streams: ReadonlySet<string> } = {
    instanceIds: EMPTY_SET,
    streams: EMPTY_SET,
  }
): ExplorerFeedEntry[] {
  return page.data
    .filter((rec) => {
      // Apply connection filter when the user has narrowed to specific connections.
      // Match on connector_instance_id (connection INSTANCE) — never on connector_id
      // (connector TYPE) alone, as multiple connections of the same type would leak.
      if (filterConnections.size > 0 && !allowedInstanceIds.has(rec.connector_instance_id)) {
        return false;
      }
      // Apply stream filter when the user has narrowed to specific streams.
      if (filterStreams.size > 0 && !filterStreams.has(rec.stream)) {
        return false;
      }
      // EXCLUDE: drop records from an excluded connection instance or stream
      // ("everything except X"). Same INSTANCE identity the inclusion filter uses.
      if (exclude.instanceIds.size > 0 && exclude.instanceIds.has(rec.connector_instance_id)) {
        return false;
      }
      if (exclude.streams.size > 0 && exclude.streams.has(rec.stream)) {
        return false;
      }
      return true;
    })
    .map((rec) =>
      timelineRecordToEntry(
        rec,
        filteredSummaries,
        declaredFieldTypes,
        declaredFieldRoles,
        manifestFieldNames,
        timestampMetadata
      )
    );
}

/**
 * The connector_instance_ids that records may belong to, given the selected
 * connections. Empty when no connection filter is active (everything allowed).
 */
function buildAllowedInstanceIds(
  filterConnections: ReadonlySet<string>,
  filteredSummaries: readonly RefConnectorSummary[]
): Set<string> {
  const allowed = new Set<string>();
  if (filterConnections.size === 0) {
    return allowed;
  }
  for (const s of filteredSummaries) {
    allowed.add(s.connection_id);
    if (s.connector_instance_id) {
      allowed.add(s.connector_instance_id);
    }
  }
  return allowed;
}

/**
 * The connector_instance_ids to EXCLUDE, resolved from the excluded connection
 * ids over ALL summaries (an excluded connection is absent from `filteredSummaries`
 * whenever an include filter is also active, so exclusion resolves against the full
 * summary list). Empty when nothing is excluded (drop nothing).
 */
function buildExcludedInstanceIds(
  excludeConnections: ReadonlySet<string>,
  allSummaries: readonly RefConnectorSummary[]
): Set<string> {
  const excluded = new Set<string>();
  if (excludeConnections.size === 0) {
    return excluded;
  }
  for (const s of allSummaries) {
    if (!excludeConnections.has(s.connection_id)) {
      continue;
    }
    excluded.add(s.connection_id);
    if (s.connector_instance_id) {
      excluded.add(s.connector_instance_id);
    }
  }
  return excluded;
}

/**
 * Append one page's mapped entries to the cumulative feed, deduping by identity.
 * Mutates `accumulated` and `seenKeys`.
 *
 * Snapshot membership is now enforced SERVER-SIDE (by snapshotSeq): page 1 is
 * fetched with `rewindToFirstPage` so it is pinned to the SAME original snapshot
 * as pages 2..N. There is no client-side emitted_at proxy here — an after-snapshot
 * backfill is excluded by the endpoint (`id > snapshotSeq`), never by timestamp.
 */
function appendMergedEntries(
  entries: readonly ExplorerFeedEntry[],
  accumulated: ExplorerFeedEntry[],
  seenKeys: Set<string>
): void {
  for (const entry of entries) {
    const key = mergedEntryKey(entry);
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    accumulated.push(entry);
  }
}

/** Stable identity key for a merged-timeline entry: (connection instance, stream, record). */
function mergedEntryKey(entry: ExplorerFeedEntry): string {
  return `${entry.connectionId} | ${entry.stream} | ${entry.recordId}`;
}

/**
 * Load the non-search, no-time-range feed using the REAL /_ref/explore/records
 * merged-timeline endpoint (Phase 3) as a TRUE "Load more" that ACCUMULATES.
 *
 * Accumulation model (Option A — server-side cursor trail):
 *   The URL carries the trail of `next_cursor` values produced so far
 *   (`cursors=c1,c2,...`). To render the cumulative feed we fetch page 1
 *   (cursor=null) followed by each trail cursor IN ORDER and CONCATENATE the
 *   mapped entries: page1 ++ page2 ++ … . Because each page is strictly older
 *   than the previous one (the endpoint pages emitted_at DESC and pages are
 *   conformance-proven non-overlapping), the concatenation is already in
 *   non-increasing emitted_at order; we never re-sort across pages. The returned
 *   `nextCursor` is the LAST fetched page's `next_cursor` (null when exhausted),
 *   so "Load more" appends it to the trail and advances to still-older records.
 *
 * Snapshot consistency (the crux — the CORRECTED fix after Codex HOLD):
 *   Every cursor in the trail encodes the ORIGINAL snapshot anchor (`snapshotSeq`,
 *   the ingest sequence) captured at first-page time, so pages 2..N are all pinned
 *   to that one snapshot and never shift. Page 1 must share that SAME snapshot.
 *
 *   The page-1 → page-2 cursor (`trail[0]`, the first trail element) already encodes
 *   the original `snapshotSeq`. We re-render page 1 by calling the endpoint with
 *   `cursor: trail[0]` AND `rewindToFirstPage: true` — the server keeps that cursor's
 *   snapshot but discards its partition positions and re-enumerates from the start,
 *   returning page 1 of the ORIGINAL snapshot (membership `id <= snapshotSeq`).
 *
 *   This is correct where the prior `emitted_at <= anchor` proxy was WRONG: an
 *   after-snapshot BACKFILL (ingested after the snapshot, but with an old emitted_at
 *   that lands inside page 1's window) would PASS a timestamp filter and DISPLACE an
 *   original page-1 row — hiding a record that was visible before "Load more". The
 *   snapshotSeq pin excludes such a backfill (its `id > snapshotSeq`) so no original
 *   page-1 row is ever displaced.
 *
 *   On the very FIRST load (empty trail) there is no prior snapshot to pin to: fetch
 *   page 1 with `cursor: null` and no rewind, capturing a fresh snapshot — exactly as
 *   before. After-snapshot records are surfaced via `new_since_snapshot` (the "N new"
 *   pill), never injected into the pinned view.
 *
 * A defensive dedupe by (connection instance, stream, record) guards the single
 * possible page1/page2 boundary overlap; the endpoint guarantees non-overlap so it
 * is belt-and-suspenders.
 */
interface UpcomingPresentationCtx {
  allowedInstanceIds: ReadonlySet<string>;
  /** Declared presentation ROLES per connector::stream (parallel to declaredFieldTypes). */
  declaredFieldRoles: ReadonlyMap<string, DeclaredFieldRoles>;
  declaredFieldTypes: ReadonlyMap<string, DeclaredFieldTypes>;
  /** EXCLUDED instance ids / streams (facet "is not"); future records are excluded too. */
  exclude: { instanceIds: ReadonlySet<string>; streams: ReadonlySet<string> };
  filterConnections: ReadonlySet<string>;
  filteredSummaries: RefConnectorSummary[];
  filterStreams: ReadonlySet<string>;
  manifestFieldNames: ReadonlyMap<string, readonly string[]>;
  timestampMetadata: ReadonlyMap<string, SearchTimestampMetadata>;
}

/**
 * Capture the Upcoming (future) head + reachability handle from page 1. The cursor
 * and has_more come from page 1 regardless of whether the head is non-empty; the
 * head entries + true total only when the head has rows.
 */
function capturePage1Upcoming(
  page: ExploreTimelinePage,
  ctx: UpcomingPresentationCtx
): { entries: ExplorerFeedEntry[]; total: number; nextCursor: string | null; hasMore: boolean } {
  const nextCursor = typeof page.upcoming_next_cursor === "string" ? page.upcoming_next_cursor : null;
  const hasMore = page.upcoming_has_more === true;
  if (!(Array.isArray(page.upcoming) && page.upcoming.length > 0)) {
    return { entries: [], total: 0, nextCursor, hasMore };
  }
  const entries = mergedTimelinePageEntries(
    { ...page, data: page.upcoming },
    ctx.filteredSummaries,
    ctx.declaredFieldTypes,
    ctx.declaredFieldRoles,
    ctx.manifestFieldNames,
    ctx.filterStreams,
    ctx.filterConnections,
    ctx.allowedInstanceIds,
    ctx.timestampMetadata,
    ctx.exclude
  );
  // The server's upcoming_total is EXACT and already excludes the excluded partitions
  // (exclusion is applied server-side at partition enumeration), so it is used as-is —
  // count==reachability holds at any scale, with no client-side shrinking.
  const total = typeof page.upcoming_total === "number" ? page.upcoming_total : page.upcoming.length;
  return { entries, total, nextCursor, hasMore };
}

/**
 * Walk the upcoming (future) cursor trail and CONCATENATE each page onto the
 * page-1 head (`upcomingEntries`, mutated in place, deduped by partition-qualified
 * identity). Each upcoming cursor is self-contained (pinned snapshot + per-partition
 * positions), so the pages fetch in parallel. Returns the LAST page's reachability
 * handle so the caller can offer a further "Load more upcoming".
 */
async function loadUpcomingTrailPages(
  upcomingTrail: readonly string[],
  upcomingEntries: ExplorerFeedEntry[],
  ctx: UpcomingPresentationCtx & { dataSource: DashboardDataSource }
): Promise<{ nextCursor: string | null; hasMore: boolean }> {
  const pages = await Promise.all(
    upcomingTrail.map((upcomingCursor) =>
      ctx.dataSource.listExploreTimeline({ limit: UPCOMING_PAGE_LIMIT, upcomingCursor })
    )
  );
  // record_key is unique only WITHIN a connection+stream partition, never globally.
  // JSON.stringify the tuple so connector-authored stream/record-key strings that
  // contain spaces (or other delimiters) can never collide into one another.
  const identity = (e: ExplorerFeedEntry) => JSON.stringify([e.connectionId ?? e.connectorId, e.stream, e.recordId]);
  const seen = new Set(upcomingEntries.map(identity));
  for (const page of pages) {
    if (!(Array.isArray(page.upcoming) && page.upcoming.length > 0)) {
      continue;
    }
    const entries = mergedTimelinePageEntries(
      { ...page, data: page.upcoming },
      ctx.filteredSummaries,
      ctx.declaredFieldTypes,
      ctx.declaredFieldRoles,
      ctx.manifestFieldNames,
      ctx.filterStreams,
      ctx.filterConnections,
      ctx.allowedInstanceIds,
      ctx.timestampMetadata,
      ctx.exclude
    );
    for (const entry of entries) {
      const id = identity(entry);
      if (!seen.has(id)) {
        seen.add(id);
        upcomingEntries.push(entry);
      }
    }
  }
  const last = pages.at(-1);
  return {
    nextCursor: typeof last?.upcoming_next_cursor === "string" ? last.upcoming_next_cursor : null,
    hasMore: last?.upcoming_has_more === true,
  };
}

async function loadMergedTimelineFeed(
  cursorTrail: readonly string[],
  upcomingTrail: readonly string[],
  snapshotAnchorParam: string | null,
  filteredSummaries: RefConnectorSummary[],
  declaredFieldTypes: ReadonlyMap<string, DeclaredFieldTypes>,
  declaredFieldRoles: ReadonlyMap<string, DeclaredFieldRoles>,
  manifestFieldNames: ReadonlyMap<string, readonly string[]>,
  filterStreams: ReadonlySet<string>,
  filterConnections: ReadonlySet<string>,
  timestampMetadata: ReadonlyMap<string, SearchTimestampMetadata>,
  // EXCLUSION (facet "is not" / `-con:`/`-stream:`): instance ids + streams to drop
  // from BOTH the past feed and the Upcoming projection, applied client-side over the
  // loaded window. Empty sets drop nothing.
  exclude: { instanceIds: ReadonlySet<string>; streams: ReadonlySet<string> },
  // Feed direction: "desc" (newest-first browse) or "asc" (the order=oldest
  // re-page — pages the keyset ascending from the earliest record). Passed to
  // EVERY page request (page 1 + each trail cursor) so an oldest-first walk stays
  // ascending; the server also pins it inside the cursor for defence-in-depth.
  direction: "asc" | "desc",
  dataSource: DashboardDataSource
): Promise<FeedLoadResult> {
  // Records may be rejected if they belong to unselected connections (defence in
  // depth — the endpoint already scopes by connection/stream). Empty = allow all.
  const allowedInstanceIds = buildAllowedInstanceIds(filterConnections, filteredSummaries);

  // The fetch plan, in display order:
  //   - Empty trail (first load): [{ cursor: null }] — fresh page 1 + snapshot.
  //   - Non-empty trail: page 1 = REWIND(trail[0]) (re-render page 1 pinned to the
  //     original snapshot), then trail[0] (page 2), trail[1] (page 3), … . Every
  //     page shares the original snapshotSeq, so the accumulated view is stable.
  // The merged-timeline endpoint is the single source of truth for the recent lens;
  // every DashboardDataSource implements it, so an error here is a real failure that
  // must surface honestly rather than silently degrade to a capped feed.
  const trailHead = cursorTrail[0] ?? null;
  const fetchPlan: Array<{ cursor: string | null; rewindToFirstPage: boolean }> =
    cursorTrail.length === 0
      ? [{ cursor: null, rewindToFirstPage: false }]
      : [
          // Page 1: rewind the page-1 → page-2 cursor to the original snapshot.
          { cursor: trailHead, rewindToFirstPage: true },
          // Pages 2..N: each trail cursor verbatim (already snapshot-pinned).
          ...cursorTrail.map((cursor) => ({ cursor, rewindToFirstPage: false })),
        ];

  const accumulated: ExplorerFeedEntry[] = [];
  const seenKeys = new Set<string>();
  // The original-snapshot DISPLAY anchor (snapshot_at): the URL anchor when present
  // (carried unchanged across pages for the "N new" pill / copy-link stability),
  // else the first fetched page's snapshot_at (first load). This is display-only;
  // membership is enforced server-side by snapshotSeq inside the cursor.
  let snapshotAnchor: string | null = snapshotAnchorParam;
  let newSinceSnapshot = 0;
  let lastHasMore = false;
  let lastNextCursor: string | null = null;

  // Fetch every page in the plan CONCURRENTLY. Each cursor is self-contained and
  // snapshot-pinned (rewind(trail[0]) for page 1, each trail cursor for pages 2..N),
  // so the requests have no inter-dependency — only the merge/dedup below is order-
  // sensitive. Serial fetching here made a deep Load-more cost N sequential 150-way
  // merges (it got slower the further you paged); Promise.all makes wall-clock the
  // single slowest page instead of their sum. Results preserve fetchPlan order, so
  // the in-order append/dedup that follows is byte-identical to the serial version.
  // EXCLUDE scope is applied SERVER-SIDE (re-passed on every page like the include
  // scope) so the feed, the Upcoming projection, the counts, and the cursor all omit
  // excluded partitions — counts stay exact, never client-side shrunk.
  const excludeConnectionIds = [...exclude.instanceIds];
  const excludeStreams = [...exclude.streams];
  const pages: ExploreTimelinePage[] = await Promise.all(
    fetchPlan.map((step, stepIndex) =>
      dataSource.listExploreTimeline({
        connectionIds: [...filterConnections],
        cursor: step.cursor,
        limit: FEED_TOTAL_CAP,
        // Only page 1 carries the Upcoming head; give it the larger upcoming limit so
        // the bounded future set is revealed on first expand (the others discard it).
        ...(stepIndex === 0 ? { upcomingLimit: UPCOMING_PAGE_LIMIT } : {}),
        ...(step.rewindToFirstPage ? { rewindToFirstPage: true } : {}),
        streams: [...filterStreams],
        excludeConnectionIds,
        excludeStreams,
        // Direction defines the feed (newest-first vs the order=oldest re-page).
        // Re-passed on every page so an oldest-first walk stays ascending; "desc"
        // is omitted so the default newest-first request URL stays clean.
        ...(direction === "asc" ? { direction } : {}),
      })
    )
  );

  // The Upcoming (future) projection comes from the FIRST page (page 1 carries it,
  // scoped + snapshot-bound to the same view). The server OWNS the past/future split
  // — the client renders what it declares, never re-derives the boundary.
  let upcomingEntries: ExplorerFeedEntry[] = [];
  let upcomingTotal = 0;
  let upcomingNextCursor: string | null = null;
  let upcomingHasMore = false;

  for (const [pageIndex, page] of pages.entries()) {
    // The original snapshot anchor: when no URL anchor was carried (first load),
    // adopt the first page's snapshot_at and keep it for every later page. The "N
    // new" count and next cursor track the LAST page (every page shares the original
    // snapshot via snapshotSeq, so its snapshot_at is identical across pages).
    if (snapshotAnchor === null) {
      snapshotAnchor = page.snapshot_at;
    }
    newSinceSnapshot = page.new_since_snapshot;
    lastHasMore = page.has_more;
    lastNextCursor = page.has_more ? (page.next_cursor ?? null) : null;

    if (pageIndex === 0) {
      const head = capturePage1Upcoming(page, {
        filteredSummaries,
        declaredFieldTypes,
        declaredFieldRoles,
        manifestFieldNames,
        filterStreams,
        filterConnections,
        allowedInstanceIds,
        timestampMetadata,
        exclude,
      });
      upcomingEntries = head.entries;
      upcomingTotal = head.total;
      upcomingNextCursor = head.nextCursor;
      upcomingHasMore = head.hasMore;
    }

    appendMergedEntries(
      mergedTimelinePageEntries(
        page,
        filteredSummaries,
        declaredFieldTypes,
        declaredFieldRoles,
        manifestFieldNames,
        filterStreams,
        filterConnections,
        allowedInstanceIds,
        timestampMetadata,
        exclude
      ),
      accumulated,
      seenKeys
    );
  }

  // Upcoming (future) pagination: walk the `ucursors` trail and concatenate the
  // pages onto the page-1 head so previously-revealed future records stay visible
  // (count==reachability). Updates the reachability handle to the LAST page fetched.
  if (upcomingTrail.length > 0) {
    const walked = await loadUpcomingTrailPages(upcomingTrail, upcomingEntries, {
      filteredSummaries,
      declaredFieldTypes,
      declaredFieldRoles,
      manifestFieldNames,
      filterStreams,
      filterConnections,
      allowedInstanceIds,
      timestampMetadata,
      exclude,
      dataSource,
    });
    upcomingNextCursor = walked.nextCursor;
    upcomingHasMore = walked.hasMore;
  }

  const mergedNextCursor = lastHasMore ? lastNextCursor : null;
  return {
    entries: accumulated,
    exactWindowComplete: false,
    exactWindows: [],
    fromSearch: false,
    hybridUsed: false,
    // The real composite cursor from the LAST fetched page — non-null when has_more.
    nextCursor: mergedNextCursor,
    newSinceAnchor: newSinceSnapshot > 0 ? newSinceSnapshot : null,
    searchHasMore: false,
    searchNextCursor: null,
    // complete_chronological: exhaustive merged timeline with real cursor pagination.
    descriptor: {
      kind: "complete_chronological",
      ordering: "time",
      completeness: "exhaustive",
      has_more: lastHasMore,
      cursor: mergedNextCursor,
    },
    snapshotAnchor,
    streamDoor: null,
    streamSeeAllLinks: [],
    truncated: false,
    upcoming: upcomingEntries,
    upcomingTotal,
    upcomingNextCursor,
    upcomingHasMore,
    warnings: [],
  };
}

function toTimeRangeEntry({
  consentTimeField,
  data,
  declaredFieldTypes,
  fieldCapabilities,
  emittedAt,
  recordId,
  sinceMs,
  streamName,
  summary,
  untilMs,
}: {
  consentTimeField: string;
  data: Record<string, unknown>;
  declaredFieldTypes: DeclaredFieldTypes | undefined;
  fieldCapabilities: readonly ExplorerFieldCapability[];
  emittedAt: string;
  recordId: string;
  sinceMs: number | null;
  streamName: string;
  summary: RefConnectorSummary;
  untilMs: number | null;
}): ExplorerFeedEntry | null {
  const ms = parseRecordTimestamp(data[consentTimeField]);
  if (ms === null || !isWithinWindow(ms, sinceMs, untilMs)) {
    return null;
  }
  // Declared roles seam (empty default; see declaredRolesFromCapabilities).
  const declaredFieldRoles = declaredRolesFromCapabilities(fieldCapabilities);
  const kind = classifyRecordKind(streamName, data, declaredFieldTypes, undefined, declaredFieldRoles).kind;
  return {
    blobAffordance: buildBlobAffordance(data, fieldCapabilities) ?? undefined,
    connectorId: summary.connector_id,
    connectionId: summary.connection_id,
    connectionDisplayName: connectorSummaryDisplayName(summary),
    stream: streamName,
    recordId,
    emittedAt,
    displayAt: new Date(ms).toISOString(),
    // No `summary`: this body-backed row renders from declared-role `preview` slots.
    kind,
    preview: buildRecordPreview(kind, data, declaredFieldTypes, declaredFieldRoles) ?? undefined,
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

async function loadTimeRangeFeed(
  since: string,
  until: string,
  filteredSummaries: RefConnectorSummary[],
  timestampMetadata: ReadonlyMap<string, SearchTimestampMetadata>,
  declaredFieldTypes: ReadonlyMap<string, DeclaredFieldTypes>,
  manifestFieldNames: ReadonlyMap<string, readonly string[]>,
  filterStreams: ReadonlySet<string>,
  // EXCLUDE scope ("is not" / `-con:`/`-stream:`): skip excluded connections + streams
  // at the fetch source so the time-range feed honors "everything except X".
  exclude: { instanceIds: ReadonlySet<string>; streams: ReadonlySet<string> },
  dataSource: DashboardDataSource
): Promise<FeedLoadResult> {
  // Time-anchored cross-stream feed. Connection-first so row attribution stays exact.
  const sinceMs = since ? Date.parse(since) : null;
  const untilMs = until ? Date.parse(until) : null;

  type StreamFetchResult =
    | {
        ok: true;
        connectionId: string;
        connectorId: string;
        displayName: string;
        stream: string;
        entries: ExplorerFeedEntry[];
        exactWindow: RecordsWindowMeta | null;
        hasMore: boolean;
        warning: ExplorerWarning | null;
      }
    | { ok: false; failure: FanInFailure };
  const fetches: Promise<StreamFetchResult>[] = [];

  for (const summary of filteredSummaries) {
    // EXCLUDE: skip an excluded connection entirely (by either identity).
    if (
      exclude.instanceIds.size > 0 &&
      (exclude.instanceIds.has(summary.connector_instance_id ?? summary.connection_id) ||
        exclude.instanceIds.has(summary.connection_id))
    ) {
      continue;
    }
    for (const { consentTimeField, streamName } of timeRangeStreamTargets(summary, timestampMetadata, filterStreams)) {
      // EXCLUDE: skip an excluded stream.
      if (exclude.streams.size > 0 && exclude.streams.has(streamName)) {
        continue;
      }
      fetches.push(
        (async (): Promise<StreamFetchResult> => {
          const metaKey = searchTimestampMetadataKey(summary.connector_id, streamName);
          const [{ metadata, warning }, page] = await Promise.all([
            loadStreamUiMetadata(
              dataSource,
              summary,
              streamName,
              declaredFieldTypes.get(metaKey),
              manifestFieldNames.get(metaKey)
            ),
            dataSource.queryRecords(summary.connector_id, streamName, {
              connectorInstanceId: summary.connector_instance_id ?? summary.connection_id,
              limit: TIME_RANGE_RECORDS_PER_STREAM,
              order: "desc",
              window: "exact",
            }),
          ]);
          return {
            ok: true,
            connectionId: summary.connection_id,
            connectorId: summary.connector_id,
            displayName: connectorSummaryDisplayName(summary),
            stream: streamName,
            entries: page.data
              .map((record) =>
                toTimeRangeEntry({
                  consentTimeField,
                  data: recordData(record.data),
                  declaredFieldTypes: metadata.declaredFieldTypes,
                  fieldCapabilities: metadata.fieldCapabilities,
                  emittedAt: record.emitted_at,
                  recordId: record.id,
                  sinceMs,
                  streamName,
                  summary,
                  untilMs,
                })
              )
              .filter((entry): entry is ExplorerFeedEntry => entry !== null),
            exactWindow: exactWindowFromPage(page),
            hasMore: page.has_more,
            warning,
          };
        })().catch((err): StreamFetchResult => {
          const { expected, reason } = classifyFanInFailure(err);
          return {
            ok: false,
            failure: {
              connectionName: connectorSummaryDisplayName(summary),
              expected,
              reason,
              stream: streamName,
            },
          };
        })
      );
    }
  }

  const results = await Promise.all(fetches);
  const entries: ExplorerFeedEntry[] = [];
  const exactWindows: RecordsWindowMeta[] = [];
  const warnings: ExplorerWarning[] = [];
  const failures: FanInFailure[] = [];

  interface StreamInfo {
    connectionId: string;
    connectorId: string;
    displayName: string;
    hasMore: boolean;
    stream: string;
    total: number | null;
  }
  const streamInfos: StreamInfo[] = [];

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
      streamInfos.push({
        connectionId: result.connectionId,
        connectorId: result.connectorId,
        displayName: result.displayName,
        stream: result.stream,
        total: result.exactWindow?.total ?? null,
        hasMore: result.hasMore,
      });
    } else {
      failures.push(result.failure);
    }
  }
  warnings.push(...summarizeFanInFailures(failures));
  entries.sort((a, b) => (Date.parse(b.displayAt) || 0) - (Date.parse(a.displayAt) || 0));
  const truncated = entries.length > TIME_RANGE_TOTAL_CAP;

  const streamSeeAllLinks: ExplorerStreamSeeAllLink[] = streamInfos
    .filter((si) => si.hasMore || truncated)
    .map((si) => ({
      connectionId: si.connectionId,
      connectorId: si.connectorId,
      displayName: si.displayName,
      stream: si.stream,
      total: si.total,
    }));

  // time_range is a bounded per-stream fan-out with per-stream escape ramps.
  // Each stream group is relevance/recency bounded with "See all" ramps; the
  // descriptor reflects that: the per-source escape doors point to complete
  // chronological pages for each stream individually.
  const timeRangeTotal = exactWindows.reduce((sum, w) => sum + w.total, 0);
  const timeRangeTruncated = truncated || streamInfos.some((si) => si.hasMore);
  return {
    entries: entries.slice(0, TIME_RANGE_TOTAL_CAP),
    exactWindowComplete: okCount > 0 && exactWindows.length === okCount,
    fromSearch: false,
    hybridUsed: false,
    nextCursor: null,
    newSinceAnchor: null,
    searchHasMore: false,
    searchNextCursor: null,
    // Time-range: relevance_bounded when truncated (bounded sample with escape ramps);
    // filtered_exact when all streams are within cap and we have exact totals.
    descriptor: timeRangeTruncated
      ? {
          kind: "relevance_bounded",
          ordering: "relevance",
          completeness: "bounded_sample",
          ...(timeRangeTotal > 0 ? { total: timeRangeTotal } : {}),
          has_more: false as const,
          cursor: null,
        }
      : {
          kind: "filtered_exact",
          ordering: "owner_chosen",
          completeness: "exact",
          total: timeRangeTotal,
          has_more: false,
          cursor: null,
        },
    snapshotAnchor: null,
    streamDoor: null,
    streamSeeAllLinks,
    exactWindows,
    truncated,
    warnings,
  };
}

/**
 * Detect whether all entries share the same connection and stream (single-entity case).
 * Returns the shared connector/connection/stream identity, or null for multi-source results.
 */
function detectSingleStreamDoor(
  filtered: Array<{ connector_id: string; stream: string }>,
  filteredSummaries: RefConnectorSummary[]
): ExplorerStreamDoor | null {
  if (filtered.length === 0) {
    return null;
  }
  const first = filtered[0];
  if (!first) {
    return null;
  }
  const sharedConnector = first.connector_id;
  const sharedStream = first.stream;
  const allSame = filtered.every((h) => h.connector_id === sharedConnector && h.stream === sharedStream);
  if (!allSame) {
    return null;
  }
  // Resolve the connection identity for this connector+stream.
  const matchingSummaries = filteredSummaries.filter((s) => s.connector_id === sharedConnector);
  if (matchingSummaries.length !== 1 || !matchingSummaries[0]) {
    return null;
  }
  const summary = matchingSummaries[0];
  return {
    connectorId: sharedConnector,
    connectionId: summary.connection_id,
    stream: sharedStream,
    displayName: `${connectorSummaryDisplayName(summary)} - ${sharedStream}`,
  };
}

/**
 * Most-recent mode for a single connection+stream using LEXICAL search in recency
 * order (F2 fix). This replaces the former queryRecords-without-query path which
 * listed ALL records regardless of the query, making the "Browse all matching records,
 * newest first" label false.
 *
 * Lexical search:
 *   1. Applies the query as a real filter (only MATCHING records are returned).
 *   2. Accepts a cursor for keyset pagination through ALL matching records.
 *   3. Is scoped to the single stream so only results from that stream appear.
 *
 * The caller (loadSearchFeed) passes the user's cursor so subsequent pages advance
 * through matching records newest-first until exhausted.
 */
async function loadMostRecentSingleStream(
  query: string,
  summary: RefConnectorSummary,
  streamName: string,
  cursor: string | null,
  timestampMetadata: ReadonlyMap<string, SearchTimestampMetadata>,
  manifestFieldNames: ReadonlyMap<string, readonly string[]>,
  declaredFieldTypes: ReadonlyMap<string, DeclaredFieldTypes>,
  declaredFieldRoles: ReadonlyMap<string, DeclaredFieldRoles>,
  dataSource: DashboardDataSource
): Promise<{ entries: ExplorerFeedEntry[]; searchNextCursor: string | null; searchHasMore: boolean }> {
  const page = await dataSource.searchRecordsLexical(query, {
    streams: [streamName],
    limit: SEARCH_PAGE_LIMIT,
    // order=recent: genuine emitted_at DESC ordering within the lexical candidate
    // window. This is what makes keyword_pageable with ordering=time honest (F2 fix).
    order: "recent",
    ...(cursor ? { cursor } : {}),
  });
  // Post-filter to the exact stream (the server streams param narrows scope but
  // may return results from aliased stream names on older RS builds).
  const hits = page.data.filter((h) => h.stream === streamName);
  const metaKey = searchTimestampMetadataKey(summary.connector_id, streamName);
  const metadata = streamUiMetadataFromManifest(declaredFieldTypes.get(metaKey), manifestFieldNames.get(metaKey));
  const entries: ExplorerFeedEntry[] = hits.map((hit) => {
    const display = pickSearchDisplayTimestamp({
      data: null,
      emittedAt: hit.emitted_at,
      metadata: lookupSearchTimestampMetadata(timestampMetadata, summary.connector_id, streamName),
    });
    const kind = classifyRecordKind(
      streamName,
      null,
      metadata.declaredFieldTypes,
      metadata.fieldNames,
      declaredFieldRoles.get(metaKey)
    ).kind;
    return {
      blobAffordance: undefined,
      connectorId: summary.connector_id,
      connectionId: summary.connection_id,
      connectionDisplayName: connectorSummaryDisplayName(summary),
      stream: streamName,
      recordId: hit.record_key,
      emittedAt: hit.emitted_at,
      displayAt: display.value,
      // The matched-text excerpt for this search hit — a clearly-labelled secondary in
      // the row, NEVER a faked title. Absent when the server returns no snippet (the row
      // then shows the neutral record id, which is honest for a bodyless retrieval hit).
      snippet: hit.snippet?.text ? plainSnippetText(hit.snippet.text) : undefined,
      snippetSegments: hit.snippet?.text ? snippetSegments(hit.snippet.text) : undefined,
      kind,
      retrievalMode: "lexical" as const,
    };
  });
  return {
    entries,
    searchNextCursor: page.next_cursor ?? null,
    searchHasMore: page.has_more,
  };
}

/**
 * Read the response-level recall disclosure from a lexical search page. The
 * server may surface it at `page.recall` or nested under `page.meta.recall`
 * (per `disclose-lexical-recall-windows`). Returns null when neither is present.
 */
function lexicalRecall(page: SearchResultPage): SearchRecallMeta | null {
  return page.recall ?? page.meta?.recall ?? null;
}

/**
 * THE RECALL HONESTY GATE (Codex Explore HOLD).
 *
 * A lexical page may be promoted to a `keyword_pageable` descriptor — which the
 * canvas treats as exhaustive ("Browse all matching records") — ONLY when the
 * server proves the ranking saw the whole corpus. A bounded candidate window
 * (`ranking_scope: "candidate_window"`, `count_accuracy: "lower_bound"`,
 * `recall.complete: false`) does NOT: there may be matching records the ranker
 * never scored, so deep-paging the cursor cannot reach them and the page is a
 * bounded SAMPLE, not a pageable-to-the-end set.
 *
 * Returns true only when recall is provably complete. Absent disclosure ⇒ false
 * (conservative: never claim exhaustive on unproven recall). Note the deployed
 * RS does not yet attach recall to top-N lexical responses, so today this is
 * false in the common case — exactly the honest default we want.
 */
function lexicalRecallIsExhaustive(page: SearchResultPage): boolean {
  const recall = lexicalRecall(page);
  if (recall) {
    return recall.complete === true && recall.ranking_scope === "all_matches";
  }
  if (page.count_accuracy) {
    return page.count_accuracy === "exact";
  }
  return false;
}

interface LexicalProbe {
  hasMoreRecords: boolean;
  hits: SearchResultPage["data"];
  lexicalHasMore: boolean;
  lexicalNextCursor: string | null;
  lexicalRecallExhaustive: boolean;
  warning: ExplorerWarning | null;
}

/**
 * Run the lexical search and read its recall disclosure. Returns the hits plus
 * the recall facts loadSearchFeed needs (recall-exhaustive? more results? the
 * cursor trail) and an optional `search_page_limited` warning when the window is
 * bounded. Extracted so the loader stays under the complexity budget.
 */
async function probeLexical(
  query: string,
  searchSort: "relevance" | "recent",
  searchCursor: string | null,
  dataSource: DashboardDataSource
): Promise<LexicalProbe> {
  // Most-relevant: pass the user cursor for pagination. Most-recent: no user
  // cursor (this fetch only feeds stream-door detection; the display results
  // come from the single-stream loader or the multi-stream fallback).
  const cursorOpt = searchSort !== "recent" && searchCursor ? { cursor: searchCursor } : {};
  const page = await dataSource.searchRecordsLexical(query, { limit: SEARCH_PAGE_LIMIT, ...cursorOpt });
  const lexicalRecallExhaustive = lexicalRecallIsExhaustive(page);
  // Bounded-search truth: the lexical page reported more results than this
  // bounded window. When recall is not provably full-corpus, surface it so the
  // owner never reads the window as a complete result set.
  const hasMoreRecords = page.has_more === true;
  const paged = searchSort !== "recent";
  const warning: ExplorerWarning | null =
    hasMoreRecords && !lexicalRecallExhaustive
      ? {
          code: "search_page_limited",
          message:
            "This page shows the top-ranked matches, not every matching record. Open a result's stream to browse its complete records.",
        }
      : null;
  return {
    hits: page.data,
    lexicalRecallExhaustive,
    hasMoreRecords,
    lexicalNextCursor: paged ? (page.next_cursor ?? null) : null,
    lexicalHasMore: paged ? page.has_more : false,
    warning,
  };
}

/**
 * The Most-relevant search result's recall-gated cursor + descriptor. Pulled out
 * of loadSearchFeed so the recall honesty gate is one testable place and the
 * loader stays under the complexity budget.
 *
 *  - hybrid OR a bounded lexical candidate window → relevance_bounded: a ranked
 *    SAMPLE with no sound deep pagination (no cursor, no Load-more).
 *  - lexical with PROVEN full-corpus recall → keyword_pageable: the cursor pages
 *    exhaustively, so "Browse all matching records" is true.
 */
function mostRelevantSearchResult(args: {
  hybridUsed: boolean;
  lexicalRecallExhaustive: boolean;
  lexicalHasMore: boolean;
  lexicalNextCursor: string | null;
}): { searchHasMore: boolean; searchNextCursor: string | null; descriptor: SetDescriptor } {
  const exhaustive = !args.hybridUsed && args.lexicalRecallExhaustive;
  if (exhaustive) {
    return {
      searchHasMore: args.lexicalHasMore,
      searchNextCursor: args.lexicalNextCursor,
      descriptor: {
        kind: "keyword_pageable",
        ordering: "relevance",
        completeness: "pageable",
        has_more: args.lexicalHasMore,
        cursor: args.lexicalNextCursor,
      },
    };
  }
  return {
    searchHasMore: false,
    searchNextCursor: null,
    descriptor: {
      kind: "relevance_bounded",
      ordering: "relevance",
      completeness: "bounded_sample",
      has_more: false,
      cursor: null,
    },
  };
}

async function loadSearchFeed(
  query: string,
  searchSort: "relevance" | "recent",
  searchCursor: string | null,
  filteredSummaries: RefConnectorSummary[],
  filterStreams: ReadonlySet<string>,
  timestampMetadata: ReadonlyMap<string, SearchTimestampMetadata>,
  manifestFieldNames: ReadonlyMap<string, readonly string[]>,
  declaredFieldTypes: ReadonlyMap<string, DeclaredFieldTypes>,
  declaredFieldRoles: ReadonlyMap<string, DeclaredFieldRoles>,
  selectedConnectionIds: ReadonlySet<string>,
  // EXCLUDE scope ("is not" / `-con:`/`-stream:`): drop excluded hits BEFORE counts/
  // descriptors are built so "everything except X" is honest in search too.
  exclude: { instanceIds: ReadonlySet<string>; streams: ReadonlySet<string> },
  dataSource: DashboardDataSource
): Promise<FeedLoadResult> {
  // Selected-connection chips cannot be enforced at the request layer for
  // search today (public `/v1/search` does not accept `connection_id`), so
  // we narrow post-hoc by connector type. When a forward-compatible RS returns
  // concrete connection identity on a hit, we tighten to per-connection.
  const allowedConnectors = new Set(filteredSummaries.map((s) => s.connector_id));
  const allowedConnectionIds = new Set<string>();
  for (const s of filteredSummaries) {
    allowedConnectionIds.add(s.connection_id);
    if (s.connector_instance_id) {
      allowedConnectionIds.add(s.connector_instance_id);
    }
  }
  const enforceConnectionFilter = selectedConnectionIds.size > 0;
  const hybridAdvertised = await dataSource.isHybridRetrievalAdvertised();

  // ── Most-relevant mode (default): global top-N ranked results ──────────────
  //
  // Hybrid has no sound relevance cursor; lexical is deep-pageable via next_cursor.
  // We wire the next_cursor so "Load more results" works in Most-relevant lexical mode.
  //
  // Most-recent mode also needs a lexical probe (without the user cursor) to discover
  // which stream(s) the query matches so detectSingleStreamDoor can fire. The probe
  // results are only used for stream-door detection; the actual display results come
  // from loadMostRecentSingleStream (single-stream) or the lexical fallback (multi-stream).

  const warnings: ExplorerWarning[] = [];
  let hits: Awaited<ReturnType<typeof dataSource.searchRecordsLexical>>["data"] = [];
  let hybridUsed = false;
  let lexicalNextCursor: string | null = null;
  let lexicalHasMore = false;
  // RECALL HONESTY: true only when the server proved the ranking saw the whole
  // corpus. A bounded candidate window stays false so the descriptor is
  // relevance_bounded (a sample), never keyword_pageable (claims exhaustive).
  let lexicalRecallExhaustive = false;
  // Bounded-search truth: the lexical page reported more matches than this window.
  // Function-scoped so the Most-relevant return can mark the feed truncated.
  let hasMoreRecords = false;

  if (hybridAdvertised && searchSort !== "recent") {
    // Hybrid is only available for Most-relevant (it has no sound deep pagination).
    try {
      const page = await dataSource.searchRecordsHybrid(query, { limit: SEARCH_PAGE_LIMIT });
      hits = page.data;
      hybridUsed = true;
      // Hybrid does not return a next_cursor by design — not a bug.
    } catch {
      // Owner-facing copy carries no engine vocabulary and no raw error detail: the
      // fallback path still runs (we drop into lexical below), so the owner only needs
      // to know coverage was reduced. The raw error is debug evidence — log server-side.
      warnings.push({
        code: "search_coverage_reduced",
        message:
          "Some search coverage was unavailable, so these results may be narrower than usual. Try again shortly.",
      });
    }
  }
  if (!hybridUsed) {
    const probe = await probeLexical(query, searchSort, searchCursor, dataSource);
    hits = probe.hits;
    lexicalRecallExhaustive = probe.lexicalRecallExhaustive;
    hasMoreRecords = probe.hasMoreRecords;
    lexicalNextCursor = probe.lexicalNextCursor;
    lexicalHasMore = probe.lexicalHasMore;
    if (probe.warning) {
      warnings.push(probe.warning);
    }
  }

  const filtered = hits.filter((h) => {
    if (filterStreams.size > 0 && !filterStreams.has(h.stream)) {
      return false;
    }
    // EXCLUDE a hit on an excluded stream ("everything except X").
    if (exclude.streams.size > 0 && exclude.streams.has(h.stream)) {
      return false;
    }
    return shouldIncludeSearchHit(h, {
      allowedConnectors,
      allowedConnectionIds,
      enforceConnectionFilter,
      excludeConnectionIds: exclude.instanceIds,
    });
  });

  // Detect single-entity case (all hits share same connection+stream) for the
  // per-source browse door and for Most-recent single-stream pagination.
  const streamDoor = detectSingleStreamDoor(filtered, filteredSummaries);

  // ── Most-recent mode: chronological, exhaustively pageable ─────────────────
  //
  // For a single-stream result set, use that stream's keyset cursor for true
  // exhaustive access. For multi-stream results, Phase 3 merged-timeline is
  // needed — leave an honest note and surface the per-source doors.
  if (searchSort === "recent") {
    if (streamDoor) {
      // Single-stream case: use lexical search scoped to that stream, with the user
      // cursor forwarded so pages advance through MATCHING records newest-first.
      const summary = filteredSummaries.find((s) => s.connection_id === streamDoor.connectionId);
      if (summary) {
        try {
          const result = await loadMostRecentSingleStream(
            query,
            summary,
            streamDoor.stream,
            searchCursor,
            timestampMetadata,
            manifestFieldNames,
            declaredFieldTypes,
            declaredFieldRoles,
            dataSource
          );
          return {
            entries: result.entries,
            exactWindowComplete: false,
            exactWindows: [],
            fromSearch: true,
            hybridUsed: false,
            searchHasMore: result.searchHasMore,
            searchNextCursor: result.searchNextCursor,
            nextCursor: null,
            newSinceAnchor: null,
            // keyword_pageable ordered by time: genuine emitted_at DESC via lexical
            // order=recent. This is the honest "Browse all matching records, newest
            // first" path for a single stream (F2 fix).
            descriptor: {
              kind: "keyword_pageable",
              ordering: "time",
              completeness: "pageable",
              has_more: result.searchHasMore,
              cursor: result.searchNextCursor,
            },
            snapshotAnchor: null,
            streamDoor,
            streamSeeAllLinks: [],
            truncated: false,
            warnings,
          };
        } catch (err) {
          // Owner-facing copy carries no raw error detail. The stream name is
          // useful and stays; the raw error is debug evidence logged server-side.
          console.warn(`[explore] most-recent ordering failed for ${streamDoor.displayName}: ${describeError(err)}`);
          warnings.push({
            code: "search_cursor_unavailable",
            message: `Couldn't switch ${streamDoor.displayName} to most-recent ordering, so it's showing the default order instead.`,
          });
        }
      }
    }
    // Multi-stream Most-recent (F2 fix): use lexical search with the user cursor so
    // the "Browse all matching records, newest first" label is true — every page
    // returns only MATCHING records and the cursor advances to older ones exhaustively.
    // We do NOT add a warning here because the results are genuinely query-filtered;
    // the absence of cross-source time ordering is an inherent trait of lexical search
    // (results are ranked, not strictly time-ordered), which the label does not claim.
    const fallbackPage = await dataSource.searchRecordsLexical(query, {
      limit: SEARCH_PAGE_LIMIT,
      // order=recent: genuine emitted_at DESC ordering so "Browse all matching records,
      // newest first" is not a lie. F2 fix for multi-stream Most-recent path.
      order: "recent",
      ...(searchCursor ? { cursor: searchCursor } : {}),
    });
    const fallbackFiltered = fallbackPage.data.filter((h) => {
      if (filterStreams.size > 0 && !filterStreams.has(h.stream)) {
        return false;
      }
      if (exclude.streams.size > 0 && exclude.streams.has(h.stream)) {
        return false;
      }
      return shouldIncludeSearchHit(h, {
        allowedConnectors,
        allowedConnectionIds,
        enforceConnectionFilter,
        excludeConnectionIds: exclude.instanceIds,
      });
    });
    const fallbackEntries: ExplorerFeedEntry[] = fallbackFiltered.map((hit) => {
      const display = pickSearchDisplayTimestamp({
        data: null,
        emittedAt: hit.emitted_at,
        metadata: lookupSearchTimestampMetadata(timestampMetadata, hit.connector_id, hit.stream),
      });
      const attribution = attributeSearchHit(hit, filteredSummaries);
      const metaKey = searchTimestampMetadataKey(hit.connector_id, hit.stream);
      return {
        connectorId: hit.connector_id,
        connectionId: attribution.connectionId,
        connectionDisplayName: attribution.connectionDisplayName,
        stream: hit.stream,
        recordId: hit.record_key,
        emittedAt: hit.emitted_at,
        displayAt: display.value,
        // The matched-text excerpt for this search hit — a clearly-labelled secondary in
        // the row, NEVER a faked title. Absent when the server returns no snippet (the row
        // then shows the neutral record id, which is honest for a bodyless retrieval hit).
        snippet: hit.snippet?.text ? plainSnippetText(hit.snippet.text) : undefined,
        snippetSegments: hit.snippet?.text ? snippetSegments(hit.snippet.text) : undefined,
        kind: classifyRecordKind(
          hit.stream,
          null,
          declaredFieldTypes.get(metaKey),
          manifestFieldNames.get(metaKey),
          declaredFieldRoles.get(metaKey)
        ).kind,
        retrievalMode: "lexical" as const,
      };
    });
    const fallbackDoor = detectSingleStreamDoor(fallbackFiltered, filteredSummaries);
    const fallbackNextCursor = fallbackPage.next_cursor ?? null;
    return {
      entries: fallbackEntries,
      exactWindowComplete: false,
      exactWindows: [],
      fromSearch: true,
      hybridUsed: false,
      // Wire the lexical cursor so "Browse all matching records" pages exhaustively
      // through MATCHING records (F2 fix: previously searchHasMore was hardcoded false).
      searchHasMore: fallbackPage.has_more,
      searchNextCursor: fallbackNextCursor,
      nextCursor: null,
      newSinceAnchor: null,
      // keyword_pageable ordered by time: multi-stream Most-recent path uses
      // lexical order=recent, so results are genuinely emitted_at DESC within
      // the lexical candidate window. Cross-source strict time ordering requires
      // the Phase 3 merged timeline; this is the honest bounded alternative.
      descriptor: {
        kind: "keyword_pageable",
        ordering: "time",
        completeness: "pageable",
        has_more: fallbackPage.has_more,
        cursor: fallbackNextCursor,
      },
      snapshotAnchor: null,
      streamDoor: fallbackDoor,
      streamSeeAllLinks: [],
      truncated: false,
      warnings,
    };
  }

  // ── Most-relevant mode: map hits to feed entries ────────────────────────────

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
      // The matched-text excerpt for this search hit — a clearly-labelled secondary in
      // the row, NEVER a faked title. Absent when the server returns no snippet (the row
      // then shows the neutral record id, which is honest for a bodyless retrieval hit).
      snippet: hit.snippet?.text ? plainSnippetText(hit.snippet.text) : undefined,
      snippetSegments: hit.snippet?.text ? snippetSegments(hit.snippet.text) : undefined,
      kind: classifyRecordKind(
        hit.stream,
        null,
        declaredFieldTypes.get(metaKey),
        manifestFieldNames.get(metaKey),
        declaredFieldRoles.get(metaKey)
      ).kind,
      retrievalMode: hit.retrieval_mode ?? (hybridUsed ? "hybrid" : "lexical"),
    };
  });

  return {
    entries,
    exactWindowComplete: false,
    exactWindows: [],
    fromSearch: true,
    hybridUsed,
    nextCursor: null,
    newSinceAnchor: null,
    // Recall honesty gate: a bounded candidate window is a ranked sample
    // (relevance_bounded, no cursor), not an exhaustive keyword_pageable set.
    ...mostRelevantSearchResult({ hybridUsed, lexicalRecallExhaustive, lexicalHasMore, lexicalNextCursor }),
    snapshotAnchor: null,
    streamDoor,
    streamSeeAllLinks: [],
    truncated: hasMoreRecords,
    warnings,
  };
}

interface FeedDispatch {
  feed: FeedLoadResult;
  lens: ExplorerLens;
}

async function dispatchFeed(args: {
  query: string;
  searchSort: "relevance" | "recent";
  searchCursor: string | null;
  /** Recent-lens accumulating cursor trail (`cursors=c1,c2,…`); empty = first page. */
  cursorTrail: readonly string[];
  /** Upcoming (future) accumulating cursor trail (`ucursors=u1,u2,…`); empty = head only. */
  upcomingTrail: readonly string[];
  /** Original snapshot anchor carried in the URL (`anchor`); null on first load. */
  snapshotAnchorParam: string | null;
  since: string;
  until: string;
  filteredSummaries: RefConnectorSummary[];
  filterStreamSet: ReadonlySet<string>;
  timestampMetadata: ReadonlyMap<string, SearchTimestampMetadata>;
  manifestFieldNames: ReadonlyMap<string, readonly string[]>;
  declaredFieldTypes: ReadonlyMap<string, DeclaredFieldTypes>;
  /** Declared presentation ROLES per connector::stream (parallel to declaredFieldTypes). */
  declaredFieldRoles: ReadonlyMap<string, DeclaredFieldRoles>;
  filterConnectionSet: ReadonlySet<string>;
  /** EXCLUDED connection ids (facet "is not" / `-con:`). Applied on the recent lens. */
  excludeConnectionSet: ReadonlySet<string>;
  /** EXCLUDED stream names (facet "is not" / `-stream:`). Applied on the recent lens. */
  excludeStreamSet: ReadonlySet<string>;
  /** All summaries (unfiltered) so exclusion can resolve instance ids for excluded connections. */
  summaries: RefConnectorSummary[];
  /**
   * Recent-lens feed direction: "desc" (newest-first browse, default) or "asc"
   * (the order=oldest re-page — pages the merged-timeline keyset ascending from
   * the earliest record). Only the merged-timeline lens consumes it.
   */
  feedDirection: "asc" | "desc";
  dataSource: DashboardDataSource;
}): Promise<FeedDispatch> {
  const {
    query,
    searchSort,
    searchCursor,
    cursorTrail,
    upcomingTrail,
    snapshotAnchorParam,
    since,
    until,
    filteredSummaries,
    filterStreamSet,
    timestampMetadata,
    manifestFieldNames,
    declaredFieldTypes,
    declaredFieldRoles,
    filterConnectionSet,
    excludeConnectionSet,
    excludeStreamSet,
    summaries,
    feedDirection,
    dataSource,
  } = args;
  const hasTimeWindow = since !== "" || until !== "";
  // The resolved EXCLUDE scope ("is not" facet / `-con:`/`-stream:`), applied across
  // EVERY lens so "everything except X" is honest for search and time-range too (not
  // only the recent feed). instanceIds = the excluded connections' connector_instance
  // ids over ALL summaries; streams = excluded stream names. Applied to membership
  // BEFORE counts/descriptors are built (so a post-exclusion descriptor is honest).
  const exclude = {
    instanceIds: buildExcludedInstanceIds(excludeConnectionSet, summaries),
    streams: excludeStreamSet,
  };
  if (query) {
    const feed = await loadSearchFeed(
      query,
      searchSort,
      searchCursor,
      filteredSummaries,
      filterStreamSet,
      timestampMetadata,
      manifestFieldNames,
      declaredFieldTypes,
      declaredFieldRoles,
      filterConnectionSet,
      exclude,
      dataSource
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
      filterStreamSet,
      exclude,
      dataSource
    );
    return { feed, lens: "time_range" };
  }
  // Try the real merged-timeline endpoint first (Phase 3 wiring).
  // The recent lens is the merged cross-source timeline endpoint, full stop.
  // No fan-out fallback: a failure surfaces honestly rather than silently
  // capping the feed.
  const mergedFeed = await loadMergedTimelineFeed(
    cursorTrail,
    upcomingTrail,
    snapshotAnchorParam,
    filteredSummaries,
    declaredFieldTypes,
    declaredFieldRoles,
    manifestFieldNames,
    filterStreamSet,
    filterConnectionSet,
    timestampMetadata,
    exclude,
    feedDirection,
    dataSource
  );
  return { feed: mergedFeed, lens: "recent" };
}

interface ManifestMetadata {
  /**
   * Declared presentation ROLES (field name → role: which card SLOT a field
   * fills), keyed by connector::stream. The manifest-side parallel of
   * `declaredFieldTypes`: sourced from `schema.properties[field].x_pdpp_role`,
   * the same declaration the server surfaces as `field_capabilities[].role`.
   * The recent merged-timeline feed reads it to dispatch typed cards (message /
   * money / titled / …) without loading per-stream metadata first. Only streams
   * declaring at least one valid role appear; undeclared streams resolve to the
   * empty map (the honest generic card). Presentation-only.
   */
  declaredFieldRoles: Map<string, DeclaredFieldRoles>;
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
  /**
   * Declared exact-filterable scalar field names per connector::stream — the
   * fields a `field:value` operator may push to the server as `filter[field]=`.
   * A field qualifies when it is declared in the manifest schema and its
   * declared presentation type is a scalar/exact type (not a blob or a nested
   * object/array), mirroring how the records list page filters declared fields.
   */
  serverFilterableFields: Map<string, Set<string>>;
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

/**
 * Extract a stream's declared presentation ROLES from its manifest, mirroring the
 * reference server's role projection: `schema.properties[field].x_pdpp_role`
 * (the same source the server surfaces as `field_capabilities[].role`). Unknown
 * roles are dropped by `parseFieldRole` so they degrade to the honest generic
 * fallback (never a field-name guess). Returns the empty map when the stream
 * declares no valid role — so undeclared records take the generic key/value card.
 *
 * This is the manifest-side parallel of `extractDeclaredFieldTypes`: the recent
 * merged-timeline feed reads roles from the BUNDLED manifest (it never loads
 * per-stream metadata before first paint), exactly as it reads types, so the
 * roles must be indexed alongside the types — keyed by connector::stream.
 */
function extractDeclaredFieldRoles(stream: ManifestStream): DeclaredFieldRoles {
  const props = stream.schema?.properties;
  if (!(props && typeof props === "object")) {
    return EMPTY_DECLARED_FIELD_ROLES;
  }
  const entries: [string, FieldRole][] = [];
  for (const [field, schema] of Object.entries(props)) {
    if (!(schema && typeof schema === "object")) {
      continue;
    }
    const role = parseFieldRole((schema as { x_pdpp_role?: unknown }).x_pdpp_role);
    if (role) {
      entries.push([field, role]);
    }
  }
  return entries.length > 0 ? (Object.fromEntries(entries) as DeclaredFieldRoles) : EMPTY_DECLARED_FIELD_ROLES;
}

// Declared presentation types that are NOT server exact-filterable scalars: a
// blob is a binary affordance and nested object/array shapes are not top-level
// scalar filter keys.
const NON_FILTERABLE_DECLARED_TYPES = new Set(["blob", "object", "array", "json"]);

/**
 * The declared scalar field names a `field:value` operator may push to the
 * server as `filter[field]=`. A field qualifies when it is declared in the
 * manifest schema and (if it carries a declared presentation type) that type is
 * a scalar/exact type — never a blob or a nested object/array.
 */
function serverFilterableFieldsForStream(
  fieldNames: readonly string[] | undefined,
  declaredTypes: DeclaredFieldTypes | undefined
): Set<string> {
  const out = new Set<string>();
  for (const name of fieldNames ?? []) {
    const declaredType = declaredTypes?.[name]?.toLowerCase();
    if (declaredType && NON_FILTERABLE_DECLARED_TYPES.has(declaredType)) {
      continue;
    }
    out.add(name);
  }
  return out;
}

/**
 * Union the declared exact-filterable field names across the in-scope feed
 * streams (filtered connections × selected streams). Extracted from
 * `assembleExplorerData` to keep that function within its complexity budget.
 */
function unionServerFilterableFields(
  filteredSummaries: readonly RefConnectorSummary[],
  filterStreamSet: ReadonlySet<string>,
  serverFilterableFields: ReadonlyMap<string, Set<string>>
): Set<string> {
  const union = new Set<string>();
  for (const summary of filteredSummaries) {
    for (const streamName of summary.streams ?? []) {
      if (filterStreamSet.size > 0 && !filterStreamSet.has(streamName)) {
        continue;
      }
      const key = searchTimestampMetadataKey(summary.connector_id, streamName);
      for (const field of serverFilterableFields.get(key) ?? []) {
        union.add(field);
      }
    }
  }
  return union;
}

/** Build the per-stream metadata for one manifest stream, mutating the maps. */
function indexManifestStream(
  connectorId: string,
  stream: ManifestStream,
  maps: {
    declaredFieldRoles: Map<string, DeclaredFieldRoles>;
    declaredFieldTypes: Map<string, DeclaredFieldTypes>;
    manifestFieldNames: Map<string, readonly string[]>;
    serverFilterableFields: Map<string, Set<string>>;
    timestampMetadata: Map<string, SearchTimestampMetadata>;
  }
): void {
  const key = searchTimestampMetadataKey(connectorId, stream.name);
  maps.timestampMetadata.set(key, {
    consent_time_field: typeof stream.consent_time_field === "string" ? stream.consent_time_field : null,
    cursor_field: typeof stream.cursor_field === "string" ? stream.cursor_field : null,
  });
  const props = stream.schema?.properties;
  const fieldNames = props && typeof props === "object" ? Object.keys(props) : undefined;
  if (fieldNames) {
    maps.manifestFieldNames.set(key, fieldNames);
  }
  const declared = extractDeclaredFieldTypes(stream);
  if (declared) {
    maps.declaredFieldTypes.set(key, declared);
  }
  // Declared presentation ROLES (parallel to types): the manifest's
  // x_pdpp_role per field. Only index streams that declare at least one valid
  // role; undeclared streams resolve to EMPTY_DECLARED_FIELD_ROLES at lookup.
  const declaredRoles = extractDeclaredFieldRoles(stream);
  if (Object.keys(declaredRoles).length > 0) {
    maps.declaredFieldRoles.set(key, declaredRoles);
  }
  const filterable = serverFilterableFieldsForStream(fieldNames, declared ?? undefined);
  if (filterable.size > 0) {
    maps.serverFilterableFields.set(key, filterable);
  }
}

// The canonical short connector key the way STORED RECORDS carry it (e.g. "usaa").
// Bundled manifests set `connector_id` to the registry URI
// (https://registry.pdpp.org/connectors/usaa) and `connector_key` to the plain
// key. Per-connector metadata is looked up against `record.connector_id` (the
// plain key), so it MUST be indexed by the plain key — keying by the URI silently
// missed EVERY lookup and collapsed all timeline display timestamps to emitted_at.
export function manifestConnectorKey(manifest: { connector_id: string; connector_key?: string }): string {
  if (typeof manifest.connector_key === "string" && manifest.connector_key.length > 0) {
    return manifest.connector_key;
  }
  // Fallback: strip a registry URL down to its last path segment.
  try {
    const url = new URL(manifest.connector_id);
    const last = url.pathname.split("/").filter(Boolean).at(-1);
    if (last) {
      return decodeURIComponent(last);
    }
  } catch {
    // not a URL — already a plain key
  }
  return manifest.connector_id;
}

async function buildManifestMetadata(dataSource: DashboardDataSource): Promise<ManifestMetadata> {
  const maps = {
    timestampMetadata: new Map<string, SearchTimestampMetadata>(),
    manifestFieldNames: new Map<string, readonly string[]>(),
    declaredFieldTypes: new Map<string, DeclaredFieldTypes>(),
    declaredFieldRoles: new Map<string, DeclaredFieldRoles>(),
    serverFilterableFields: new Map<string, Set<string>>(),
  };
  for (const manifest of await dataSource.listConnectorManifests()) {
    const connectorKey = manifestConnectorKey(manifest);
    for (const stream of (manifest.streams ?? []) as ManifestStream[]) {
      indexManifestStream(connectorKey, stream, maps);
    }
  }
  return maps;
}

function resolvePeekConnection(
  parsed: { connectorId: string; connectionId: string | null },
  byConnectionId: ReadonlyMap<string, RefConnectorSummary>
): RefConnectorSummary | null {
  // Prefer the concrete `connection_id` carried in the peek param.
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
  // No concrete connection: resolve only when exactly one visible connection
  // has that connector type. Otherwise use connector-id default scope.
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
  dataSource: DashboardDataSource,
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
    const record = await dataSource.getRecord(parsed.connectorId, parsed.stream, parsed.recordId, {
      connectorInstanceId,
    });
    const data = recordData(record.data);
    let fieldCapabilities: ExplorerFieldCapability[] = [];
    let peekStreamMetadata: { consent_time_field?: string | null; cursor_field?: string | null } | null = null;
    try {
      const metadata = await dataSource.getStreamMetadata(parsed.connectorId, parsed.stream, { connectorInstanceId });
      fieldCapabilities = fieldCapabilitiesFromMetadata(metadata);
      peekStreamMetadata = {
        consent_time_field:
          typeof (metadata as Record<string, unknown>).consent_time_field === "string"
            ? ((metadata as Record<string, unknown>).consent_time_field as string)
            : null,
        cursor_field:
          typeof (metadata as Record<string, unknown>).cursor_field === "string"
            ? ((metadata as Record<string, unknown>).cursor_field as string)
            : null,
      };
    } catch {
      fieldCapabilities = [];
    }
    const peekSemantic = pickSearchDisplayTimestamp({
      data,
      emittedAt: record.emitted_at,
      metadata: peekStreamMetadata,
    });
    // Structural check, not value-equality: an authored time can legitimately
    // equal the ingest time, and we must still show it as the authored date.
    const semanticTimestamp = peekSemantic.isSemantic ? { label: peekSemantic.label, value: peekSemantic.value } : null;
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
      semanticTimestamp,
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
      semanticTimestamp: null,
    };
  }
}

export interface ExplorerSearchParams {
  /**
   * ISO timestamp of the snapshot anchor forwarded from a prior page load.
   * When present, records with emitted_at > anchor are counted as newSinceAnchor.
   * On first load (no cursor) the assembler creates a fresh anchor.
   */
  anchor?: string;
  connection?: string | string[];
  /**
   * Opaque cursor for lexical search pagination in Most-relevant mode OR the
   * keyset cursor for Most-recent single-stream pagination (search lenses).
   * Cleared when the query or sort mode changes.
   */
  cursor?: string;
  /**
   * Accumulating cursor TRAIL for the recent merged-timeline lens
   * (`cursors=c1,c2,…`). Each element is a `next_cursor` produced by a prior
   * page; the assembler fetches page 1 (no cursor) + each trail cursor in order
   * and CONCATENATES the entries so "Load more" appends rather than replaces.
   * Empty/absent = first page. Reset (dropped) on any feed-defining change
   * (query / sort / filters / range), exactly like `cursor`.
   */
  cursors?: string | string[];
  /**
   * Feed sort direction for the recent merged-timeline lens. "newest" (default)
   * = newest-first browse; "oldest" = the order=oldest re-page that walks the
   * server keyset ASCENDING from the earliest record forward (the honest
   * replacement for the old client-side window reverse). Feed-defining: a flip
   * resets the cursor trail upstream. Only meaningful for the empty-query feed.
   */
  order?: string;
  peek?: string;
  q?: string;
  /**
   * Search result sort mode. "relevance" (default) = global top-N ranked.
   * "recent" = chronological, exhaustively pageable (single-stream via keyset
   * cursor; multi-stream requires Phase 3 merged-timeline endpoint).
   */
  search_sort?: string;
  since?: string;
  stream?: string | string[];
  /**
   * Upcoming (future) accumulating cursor trail (`ucursors=u1,u2,…`). "Load more
   * upcoming" appends the upcoming_next_cursor so revealed future records stay
   * visible. Empty/absent = the page-1 head only; reset on any feed-defining change.
   */
  ucursors?: string | string[];
  until?: string;
  /**
   * EXCLUDED connection ids (`xconnection=…`, repeatable). The facet "is not"
   * toggle (Linear) and the `-con:` operator (Gmail/Stripe) both land here, so
   * "everything except X" is ONE canonical query. The recent-lens feed applies
   * exclusion as a defence-in-depth post-filter over the loaded window (the
   * merged-timeline endpoint has no `connection!=` param yet — a recorded
   * follow-up); facet counts stay honest ("in view"), so no count is faked.
   */
  xconnection?: string | string[];
  /** EXCLUDED stream names (`xstream=…`, repeatable). Mirrors `xconnection`. */
  xstream?: string | string[];
}

/**
 * Assemble RecordsExplorerData from search params and a data source.
 *
 * The live page supplies liveDashboardDataSource and getRsInternalUrl().
 * The sandbox page supplies sandboxDashboardDataSource and the illustrative
 * RS base domain. Neither page duplicates feed or peek logic.
 */

// ─── Over-time chart volume band (the honesty engine) ─────────────────────
//
// The bars come from the SERVER over-time bucket aggregate (true per-bucket
// totals over the index-scoped corpus), NOT from loaded feed entries. A SINGLE
// index-backed call (`listExploreRecordBuckets` → `GET /_ref/explore/records/
// buckets`) returns DENSE zero-filled calendar buckets plus an EXACT reachable
// `extent.count`, scoped to the SAME in-scope (connection, stream) targets the
// feed shows. This replaces the prior per-(connection, stream)
// `aggregateRecordsByTime` fan-out with one call on the critical path. Bucketing is
// UTC to MATCH the feed's day-grouping (design §4.3).

interface ChartTarget {
  connectionId: string | null;
  connectorId: string;
  connectorInstanceId: string | null;
  stream: string;
}

// The over-time chart now uses one server-side bucket endpoint. Do not cap the
// client target list here: truncating targets would make `extent.count` smaller
// than the reachable default browse corpus.

/**
 * Resolve ONE (summary, stream) into the structural scope for the server bucket
 * endpoint, or null when it is out of scope (filtered/excluded).
 */
function resolveChartTarget(
  summary: RefConnectorSummary,
  streamName: string,
  filterStreams: ReadonlySet<string>,
  excludeStreams: ReadonlySet<string>
): ChartTarget | null {
  if (filterStreams.size > 0 && !filterStreams.has(streamName)) {
    return null;
  }
  if (excludeStreams.size > 0 && excludeStreams.has(streamName)) {
    return null;
  }
  return {
    connectorId: summary.connector_id,
    connectorInstanceId: summary.connector_instance_id ?? summary.connection_id ?? null,
    connectionId: summary.connection_id ?? null,
    stream: streamName,
  };
}

/** Resolve the in-scope (connection, stream) targets that declare a time field. */
function chartTargets(
  filteredSummaries: readonly RefConnectorSummary[],
  filterStreams: ReadonlySet<string>,
  excludeStreams: ReadonlySet<string>
): { targets: ChartTarget[]; partial: boolean } {
  const targets: ChartTarget[] = [];
  for (const summary of filteredSummaries) {
    for (const streamName of summary.streams ?? []) {
      const target = resolveChartTarget(summary, streamName, filterStreams, excludeStreams);
      if (!target) {
        continue;
      }
      targets.push(target);
    }
  }
  return { targets, partial: false };
}

/**
 * Compute the over-time chart's bucket-request INPUTS for the active filtered set,
 * WITHOUT awaiting the 3.6s server bucket call. Returns null when the chart should
 * not render (a free-text search, a `relevance_bounded` set — no honest exhaustive
 * time-distribution — or no in-scope targets at all). The actual bucket aggregate
 * is loaded client-side post-mount via the `loadExploreBuckets` server action so
 * the feed paints immediately (Linear/Vercel "list instant, chart fills in").
 *
 * The (connection, stream) scope is derived from the SAME `chartTargets` over
 * `filteredSummaries` the old inline load used, so the deferred bars reconcile
 * with the feed's structural scope (chart scope == feed scope), and the gate is
 * the SAME `chartIsVisible` — search-suppression is byte-for-byte preserved, just
 * moved off the await path. The resulting `total` (loaded later) stays the
 * server's exact reachable `extent.count` (count == reachability).
 */
function computeBucketRequest(args: {
  descriptor: SetDescriptor;
  /**
   * True when the feed is a free-text SEARCH result. The chart is suppressed in
   * that case: the aggregate endpoint structurally cannot scope to the query, so
   * its bars would sum the FULL corpus while the feed shows only the matches — a
   * caption-vs-bars lie. A search result-set is not an honest time-distribution.
   */
  fromSearch: boolean;
  filteredSummaries: readonly RefConnectorSummary[];
  filterStreams: ReadonlySet<string>;
  excludeConnections: ReadonlySet<string>;
  excludeStreams: ReadonlySet<string>;
  since: string;
  until: string;
}): ExploreBucketRequest | null {
  // Visibility gating: suppress over a set with no honest exhaustive
  // time-distribution (relevance_bounded) AND over any free-text search lens
  // (the aggregate cannot scope to the query). design §4.1 / §5.
  if (!chartIsVisible(args.descriptor.kind, args.fromSearch)) {
    return null;
  }
  const { targets } = chartTargets(args.filteredSummaries, args.filterStreams, args.excludeStreams);
  if (targets.length === 0) {
    return null;
  }

  // Scope the deferred bucket call to the SAME structural (connection, stream)
  // targets the fan-out queried — so the bars reconcile with the feed's structural
  // scope. Deriving from `targets` reproduces the prior per-target scope exactly
  // (an excluded stream never became a target; a connection-filtered feed yields
  // only its connections), with NO all-corpus leak.
  const connections = uniqueStrings(
    targets.map((t) => t.connectionId).filter((id): id is string => typeof id === "string" && id.length > 0)
  );
  const streams = uniqueStrings(targets.map((t) => t.stream));

  return {
    connections,
    streams,
    // EXCLUDED connections: `chartTargets` iterates `filteredSummaries` (the
    // INCLUDE-filtered set) and does NOT drop the `-con:` exclusions, so an
    // excluded connection's streams DO land in `connections` above. Carry the
    // exclusion so the deferred aggregate drops them server-side — otherwise the
    // chart would count a connection the feed hid (chart scope != feed scope, bars
    // overstating the reachable distribution). The feed already excludes them.
    excludeConnections: [...args.excludeConnections],
    // Excluded streams are already absent from `targets`; carry the set so the
    // action re-asserts the same exclusion server-side (defense in depth — the
    // include scope already narrows it, but passing it keeps the request honest).
    excludeStreams: [...args.excludeStreams],
    since: args.since,
    until: args.until,
    descriptorKind: args.descriptor.kind,
    fromSearch: args.fromSearch,
  };
}

/**
 * Assemble the data the Explorer canvas renders.
 */
export async function assembleExplorerData(
  params: ExplorerSearchParams,
  dataSource: DashboardDataSource,
  rsBaseUrl: string
): Promise<RecordsExplorerData> {
  const query = (params.q ?? "").trim();
  const selectedConnectionIds = uniqueStrings(asStringArray(params.connection));
  const selectedStreams = uniqueStrings(asStringArray(params.stream));
  // EXCLUDED selections (facet "is not" / `-con:`/`-stream:`). A connection/stream
  // that is BOTH included and excluded is a contradiction; the include wins (the
  // explicit positive scope), and the exclude is dropped so the URL stays coherent.
  const excludeConnectionIds = uniqueStrings(asStringArray(params.xconnection)).filter(
    (id) => !selectedConnectionIds.includes(id)
  );
  const excludeStreams = uniqueStrings(asStringArray(params.xstream)).filter((s) => !selectedStreams.includes(s));
  const rawSince = (params.since ?? "").trim();
  const rawUntil = (params.until ?? "").trim();
  const since = isValidIsoDate(rawSince) ? rawSince : "";
  const until = isValidIsoDate(rawUntil) ? rawUntil : "";

  const [response, manifestMetadata] = await Promise.all([
    dataSource.listConnectorSummaries(),
    buildManifestMetadata(dataSource),
  ]);
  const summaries = response.data;

  const connections = summaries.map(toConnectionFacet).sort((a, b) => a.displayName.localeCompare(b.displayName));

  const filterConnectionSet = new Set(selectedConnectionIds);
  const filteredSummaries =
    filterConnectionSet.size > 0 ? summaries.filter((s) => filterConnectionSet.has(s.connection_id)) : summaries;

  const filterStreamSet = new Set(selectedStreams);
  // Exclude sets carry the connector_instance_ids to drop (built from the summaries
  // matching the excluded connection ids, so the post-filter matches the same
  // INSTANCE identity the inclusion filter uses) and the excluded stream names.
  const excludeConnectionSet = new Set(excludeConnectionIds);
  const excludeStreamSet = new Set(excludeStreams);
  const { timestampMetadata, manifestFieldNames, declaredFieldTypes, declaredFieldRoles, serverFilterableFields } =
    manifestMetadata;

  // Union the declared exact-filterable field names across the in-scope feed
  // streams. Search mode loads no per-stream metadata into this set (search hits
  // carry no stream capabilities), so a search-driven feed honestly reports an
  // empty set and every `field:value` stays client-side.
  const filterableFieldUnion = query
    ? new Set<string>()
    : unionServerFilterableFields(filteredSummaries, filterStreamSet, serverFilterableFields);

  // Search sort mode: "relevance" (default) or "recent" (chronological).
  // Only meaningful when query is set; ignored for recency/time-range feeds.
  const searchSort: "relevance" | "recent" = params.search_sort === "recent" ? "recent" : "relevance";
  const supportsTimelineDirection = (await dataSource.supportsExploreTimelineDirection?.()) ?? false;
  // Feed direction for the empty-query recent lens: "oldest" is only active when
  // the server explicitly supports true ascending keyset paging. Before that
  // foundation exists, a manual `order=oldest` URL no-ops to newest-first.
  const feedDirection: "asc" | "desc" = supportsTimelineDirection && params.order === "oldest" ? "asc" : "desc";
  // Opaque cursor: the SINGLE-page cursor for search pagination (lexical / single
  // -stream Most-recent). The recent merged-timeline lens instead accumulates via
  // the `cursors` TRAIL below. Both are cleared when query/sort/filters/range change.
  const searchCursor = typeof params.cursor === "string" && params.cursor.length > 0 ? params.cursor : null;
  // Recent-lens accumulating cursor trail (`cursors=c1,c2,…`): each `next_cursor`
  // produced so far, in order. Mirrors the per-stream pager's `cursors` param but
  // CONCATENATES pages instead of replacing. Empty = first page.
  const cursorTrail = parseCursorTrail(params.cursors);
  // Upcoming (future) accumulating trail (`ucursors=u1,u2,…`): each
  // `upcoming_next_cursor` so far, walking the future projection to exhaustion.
  // Empty = the page-1 upcoming head only. Reset whenever the feed resets.
  const upcomingTrail = parseCursorTrail(params.ucursors);

  // P3 point-in-time anchor. On first load (no anchor in URL) the real
  // /_ref/explore/records endpoint supplies `snapshot_at`; we forward it in the
  // URL on subsequent pages for stability. The fan-out fallback synthesises a
  // local timestamp. On search feeds, no anchor is maintained.
  const rawAnchor = typeof params.anchor === "string" && params.anchor.length > 0 ? params.anchor : null;
  // First load = no search cursor, no recent-lens trail, and no carried anchor.
  const isFirstPage = !(searchCursor || cursorTrail.length > 0 || rawAnchor);
  // Placeholder; overridden below once feedResult is available.
  const snapshotAnchorFallback = rawAnchor ?? (query ? null : new Date().toISOString());

  const [feedDispatch, peek] = await Promise.all([
    dispatchFeed({
      query,
      searchSort,
      searchCursor,
      cursorTrail,
      upcomingTrail,
      snapshotAnchorParam: rawAnchor,
      since,
      until,
      filteredSummaries,
      filterStreamSet,
      timestampMetadata,
      manifestFieldNames,
      declaredFieldTypes,
      declaredFieldRoles,
      filterConnectionSet,
      excludeConnectionSet,
      excludeStreamSet,
      summaries,
      feedDirection,
      dataSource,
    }),
    buildPeek(params.peek, summaryByConnectionId(summaries), dataSource, rsBaseUrl),
  ]);
  const { feed: feedResult, lens } = feedDispatch;

  // Over-time chart bucket INPUTS — computed synchronously (the same `chartIsVisible`
  // + `chartTargets` gate the inline load used), but the 3.6s bucket aggregate is NO
  // LONGER awaited here. Suppressed (→ null) over search / relevance_bounded / no
  // targets, exactly as before. The canvas loads the band post-mount via the
  // `loadExploreBuckets` action so the feed paints immediately; the deferred bars
  // stay scoped to the SAME (connection, stream) targets the feed shows.
  const bucketRequest = computeBucketRequest({
    descriptor: feedResult.descriptor,
    fromSearch: feedResult.fromSearch,
    filteredSummaries,
    filterStreams: filterStreamSet,
    excludeConnections: excludeConnectionSet,
    excludeStreams: excludeStreamSet,
    since,
    until,
  });

  const warnings: ExplorerWarning[] = [...feedResult.warnings];
  if (peek?.error) {
    // Owner-facing copy carries no internal path (connectorId/stream/recordId)
    // and no raw error detail. Those are debug evidence logged server-side; the
    // owner only needs to know this record couldn't be opened right now.
    console.warn(`[explore] peek read failed for ${peek.connectorId}/${peek.stream}/${peek.recordId}: ${peek.error}`);
    warnings.push({
      code: "peek_unreachable",
      message: `Couldn't open this record from ${peekSourceLabel(peek.connectionDisplayName)} right now. Try again shortly.`,
    });
  }

  // P3: newSinceAnchor and snapshotAnchor.
  // When the real /_ref/explore/records endpoint ran, it supplies both values
  // directly (feedResult.newSinceAnchor, feedResult.snapshotAnchor).
  // When the fan-out fallback ran, we synthesise from the URL anchor as before.
  const computedNewSinceAnchor: number | null = (() => {
    if (feedResult.fromSearch) {
      return null;
    }
    // Real endpoint supplies this directly.
    if (feedResult.newSinceAnchor !== null) {
      return feedResult.newSinceAnchor;
    }
    if (isFirstPage) {
      return null;
    }
    // Fan-out fallback: conservative count from page entries.
    if (rawAnchor) {
      const anchorMs = Date.parse(rawAnchor);
      if (!Number.isNaN(anchorMs)) {
        const inPageNew = feedResult.entries.filter((e) => {
          const ms = Date.parse(e.emittedAt);
          return !Number.isNaN(ms) && ms > anchorMs;
        }).length;
        return inPageNew;
      }
    }
    return 0;
  })();

  // When the real endpoint ran, its snapshot_at is the authoritative anchor.
  // Fan-out: use URL anchor or synthesise current time (first page only).
  const resolvedSnapshotAnchor = feedResult.fromSearch ? null : (feedResult.snapshotAnchor ?? snapshotAnchorFallback);

  return {
    activitySummary: activitySummaryForFeed(feedResult),
    query,
    connections,
    // DEFERRED over-time chart inputs (null when suppressed: search /
    // relevance_bounded / no targets). The canvas loads the band post-mount from
    // these, off the first-paint critical path.
    bucketRequest,
    // The chart band is now loaded client-side post-mount (see `bucketRequest`),
    // so the assembler never blocks first paint on the 3.6s aggregate. Always null
    // here; the canvas holds the loaded series in its own state.
    bucketSeries: null,
    // SET-DESCRIPTOR: propagate the engine-level truth about completeness and ordering.
    // The canvas switches on this to decide what it may claim about the set.
    descriptor: feedResult.descriptor,
    supportsTimelineDirection,
    selectedConnectionIds,
    selectedStreams,
    excludeConnectionIds,
    excludeStreams,
    serverFilterableFields: [...filterableFieldUnion].sort(),
    since,
    until,
    lens,
    fromSearch: feedResult.fromSearch,
    hybridUsed: feedResult.hybridUsed,
    feed: feedResult.entries,
    truncated: feedResult.truncated,
    // P2: search sort toggle + lexical cursor trail
    searchHasMore: feedResult.searchHasMore,
    searchNextCursor: feedResult.searchNextCursor,
    searchSort: feedResult.fromSearch ? searchSort : "relevance",
    streamDoor: feedResult.streamDoor,
    streamSeeAllLinks: feedResult.streamSeeAllLinks,
    // P3 merged-timeline cursor and point-in-time stability.
    // When /_ref/explore/records ran: nextCursor is the real composite cursor
    // (non-null when has_more=true); snapshotAnchor is the endpoint's snapshot_at.
    nextCursor: feedResult.nextCursor ?? null,
    // The accumulating cursor trail backing this feed. Only the recent merged-
    // timeline lens accumulates; search / time-range lenses page via the single
    // searchNextCursor, so they carry an empty trail.
    cursorTrail: lens === "recent" ? cursorTrail : [],
    upcomingTrail: lens === "recent" ? upcomingTrail : [],
    snapshotAnchor: resolvedSnapshotAnchor,
    newSinceAnchor: computedNewSinceAnchor,
    // Server's separate Upcoming (future-dated) projection + true count. Empty for
    // non-recent lenses. The canvas renders the collapsed "Upcoming" section from
    // this; it does NOT re-derive the past/future boundary.
    upcoming: feedResult.upcoming ?? [],
    upcomingTotal: feedResult.upcomingTotal ?? 0,
    upcomingNextCursor: feedResult.upcomingNextCursor ?? null,
    upcomingHasMore: feedResult.upcomingHasMore ?? false,
    peek,
    warnings,
  };
}
