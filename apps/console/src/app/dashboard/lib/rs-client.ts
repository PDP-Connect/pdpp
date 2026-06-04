/**
 * Typed wrappers around the Resource Server endpoints used by the dashboard.
 * All calls go through the standard PDPP `/v1/streams` surface as an owner-
 * self-export client.
 *
 * Because `/v1/streams` is per-connector for owner tokens, the dashboard
 * derives the connector list from the shipped polyfill manifests directory
 * and then probes the RS per connector. Only the records path is exercised
 * through the spec API.
 *
 * Server-only: do not import from client components.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getOwnerToken,
  getRsInternalUrl,
  ReferenceServerUnreachableError,
  ResourceServerHttpError,
} from "./owner-token.ts";
import { type CanonicalReadWarning, extractReadWarnings } from "./read-envelope.ts";
import type { RefConnectionHealthSnapshot, RefLocalDeviceProgress, RefRetainedBytesBreakdown } from "./ref-client.ts";
import { verifyDashboardSession } from "./verify-session.ts";

export interface StreamSummary {
  last_updated: string | null;
  name: string;
  object: "stream";
  record_count: number;
}

export interface StreamRecord {
  connection_id?: string;
  data: Record<string, unknown>;
  display_name?: string;
  emitted_at: string;
  id: string;
  object: "record";
  stream: string;
  /**
   * Canonical `meta.warnings`, surfaced when this record was fetched via a
   * single-record envelope that carries non-fatal lossiness (e.g. deprecated
   * alias use). Empty when the response had no warnings or pre-canonical
   * runtimes returned no `meta` block.
   */
  warnings: CanonicalReadWarning[];
}

export interface RecordsWindowMeta {
  earliest_at: string | null;
  latest_at: string | null;
  total: number;
}

export interface RecordsPage {
  data: StreamRecord[];
  has_more: boolean;
  meta?: {
    window?: RecordsWindowMeta;
    [k: string]: unknown;
  };
  next_cursor?: string;
  object: "list";
  /**
   * Canonical `meta.warnings`, surfaced when the runtime emits them on this
   * list page (e.g. deprecated alias use). Empty when missing or malformed.
   * Consumers MUST render warnings out-of-band without dropping the data.
   */
  warnings: CanonicalReadWarning[];
}

export interface FieldCapability {
  granted?: boolean;
  schema?: Record<string, unknown>;
  type?: string;
  usable?: boolean;
  [k: string]: unknown;
}

export interface StreamMetadata {
  field_capabilities?: Record<string, FieldCapability>;
  name: string;
  object?: "stream_metadata" | string;
  [k: string]: unknown;
}

export interface ConnectorManifest {
  connector_id: string;
  display_name?: string;
  name?: string;
  provider_id?: string;
  /**
   * Runtime binding requirements. The add-connection catalog classifies each
   * connector's modality from `runtime_requirements.bindings` (the same signal
   * the backend owner-agent intent route reads), so the manifest type must carry
   * it through the typed `listConnectorManifests()` path.
   */
  runtime_requirements?: { bindings?: Record<string, unknown> | null } | null;
  streams?: Array<{ name: string; [k: string]: unknown }>;
}

const MANIFESTS_DIR = join(process.cwd(), "..", "..", "packages", "polyfill-connectors", "manifests");
const FRACTIONAL_SECONDS_RE = /\.\d+Z$/;

async function authedFetch(path: string, params?: Record<string, string | number | undefined | null>) {
  // DAL gate. Memoized via React.cache, so fanned-out sibling fetches verify
  // exactly once per render — see ./verify-session.ts.
  await verifyDashboardSession();
  const token = await getOwnerToken();
  const url = new URL(`${getRsInternalUrl()}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
  }
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch (err) {
    throw new ReferenceServerUnreachableError(`Cannot reach resource server at ${getRsInternalUrl()}`, err);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new ResourceServerHttpError(path, res.status, body);
  }
  return res.json();
}

interface ConnectionReadOptions {
  connectorInstanceId?: string | null;
}

export async function listStreams(connectorId: string, opts: ConnectionReadOptions = {}): Promise<StreamSummary[]> {
  const body = (await authedFetch("/v1/streams", {
    connector_id: connectorId,
    connector_instance_id: opts.connectorInstanceId,
  })) as {
    data: StreamSummary[];
  };
  return body.data ?? [];
}

export async function getStreamMetadata(
  connectorId: string,
  stream: string,
  opts: ConnectionReadOptions = {}
): Promise<StreamMetadata> {
  return (await authedFetch(`/v1/streams/${encodeURIComponent(stream)}`, {
    connector_id: connectorId,
    connector_instance_id: opts.connectorInstanceId,
  })) as StreamMetadata;
}

export async function queryRecords(
  connectorId: string,
  stream: string,
  opts: {
    connectorInstanceId?: string | null;
    cursor?: string;
    limit?: number;
    order?: "asc" | "desc";
    window?: "exact" | "none";
  } = {}
): Promise<RecordsPage> {
  const body = (await authedFetch(`/v1/streams/${encodeURIComponent(stream)}/records`, {
    connector_id: connectorId,
    connector_instance_id: opts.connectorInstanceId,
    limit: opts.limit ?? 50,
    cursor: opts.cursor,
    order: opts.order,
    window: opts.window,
  })) as RecordsPage;
  const data = Array.isArray(body.data) ? body.data : [];
  // Single-record envelopes still wear the legacy `{ object: 'record', id, stream, data, emitted_at }`
  // shape today (canonical task 3.4 is intentionally deferred). The list path
  // already carries per-record identity decoration when the snapshot has it;
  // we just defensively normalize `warnings: []` per record so callers can
  // pass a record through `extractReadWarnings`-shaped surfaces uniformly.
  return {
    ...body,
    data: data.map((record) => ({
      ...record,
      warnings: Array.isArray(record.warnings) ? record.warnings : [],
    })),
    warnings: extractReadWarnings(body),
  };
}

/**
 * Fetch a single record by its envelope key.
 *
 * Uses the spec endpoint `GET /v1/streams/:stream/records/:id`. The :id in the
 * URL path is the `record.id` returned in list responses (which maps to
 * `record_key` in the RS). The spec list endpoint's `filter[field]=val` applies
 * to *payload* fields, not the envelope id, so we use the path-parameter form
 * rather than trying to filter the list.
 */
export async function getRecord(
  connectorId: string,
  stream: string,
  recordId: string,
  opts: ConnectionReadOptions = {}
): Promise<StreamRecord> {
  const body = (await authedFetch(`/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(recordId)}`, {
    connector_id: connectorId,
    connector_instance_id: opts.connectorInstanceId,
  })) as StreamRecord;
  return {
    ...body,
    warnings: extractReadWarnings(body),
  };
}

/**
 * One result from the lexical retrieval extension's GET /v1/search.
 * Mirrors the public contract at:
 *   openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md
 *
 * `connector_id` is required on every result so owner-mode hydration knows
 * which per-connector scope to read under. `record_url` and `snippet` are
 * optional; the page must render correctly when they are absent.
 */
export interface SearchResultHit {
  // Canonical connection identity on search hits. The reference runtime
  // emits `connection_id` (and the deprecated `connector_instance_id`
  // alias) on every hit whose snapshot captured the binding (see
  // `reference-implementation/test/search-connection-identity.test.js`).
  // Both remain optional in the type because pre-identity snapshots
  // predating the runtime change still emit hits without the field.
  connection_id?: string;
  connector_id: string;
  connector_instance_id?: string;
  display_name?: string;
  emitted_at: string;
  matched_fields: string[];
  object: "search_result";
  record_key: string;
  record_url?: string;
  // Present on semantic and hybrid hits; absent on lexical hits.
  retrieval_mode?: "semantic" | "hybrid";
  // Present only on hybrid hits: which source(s) contributed this record.
  retrieval_sources?: ("lexical" | "semantic")[];
  snippet?: { field: string; text: string };
  stream: string;
}

export interface SearchResultPage {
  data: SearchResultHit[];
  has_more: boolean;
  next_cursor?: string;
  object: "list";
  url?: string;
  /**
   * Canonical `meta.warnings`, surfaced when the runtime emits them on the
   * search response (e.g. `source_skipped_not_applicable` when a stream
   * lacks the requested retrieval mode). Empty when missing or malformed.
   */
  warnings: CanonicalReadWarning[];
}

/**
 * Call the public lexical retrieval extension at GET /v1/search with the
 * dashboard's owner-bound bearer token. Owner-mode search fans out across
 * every owner-visible connector internally; the dashboard never sends a
 * connector_id query param (the public surface rejects it in v1).
 *
 * `streams` narrows the cross-connector scope. Empty/undefined means
 * "every owner-visible stream that declares lexical_fields".
 */
export async function searchRecordsLexical(
  query: string,
  opts: { streams?: string[]; limit?: number; cursor?: string } = {}
): Promise<SearchResultPage> {
  await verifyDashboardSession();
  const token = await getOwnerToken();
  const url = new URL(`${getRsInternalUrl()}/v1/search`);
  url.searchParams.set("q", query);
  if (typeof opts.limit === "number") {
    url.searchParams.set("limit", String(opts.limit));
  }
  if (typeof opts.cursor === "string" && opts.cursor) {
    url.searchParams.set("cursor", opts.cursor);
  }
  // Repeated `streams=` entries — server normalizes to an array.
  for (const s of opts.streams ?? []) {
    if (typeof s === "string" && s.length > 0) {
      url.searchParams.append("streams", s);
    }
  }
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch (err) {
    throw new ReferenceServerUnreachableError(`Cannot reach resource server at ${getRsInternalUrl()}`, err);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`RS /v1/search failed (${res.status}): ${body}`);
  }
  const body = (await res.json()) as SearchResultPage;
  return { ...body, warnings: extractReadWarnings(body) };
}

/**
 * Call the public semantic retrieval experimental extension at
 * GET /v1/search/semantic with the dashboard's owner-bound bearer token.
 * Shape mirrors searchRecordsLexical exactly — same opts, same
 * SearchResultPage envelope — so dashboard pagination code is identical
 * for the two retrieval surfaces.
 *
 * The extension is EXPERIMENTAL and UNSTABLE in v1. When the RS advertises
 * capabilities.semantic_retrieval with stability: "experimental", callers
 * MUST accept that breaking revisions are acceptable while that marker
 * remains.
 *
 * Servers that do not configure an embedding backend return 404 here; the
 * caller should treat that as "semantic retrieval is unavailable on this
 * server" and fall back to searchRecordsLexical if desired. This extension
 * is NOT a replacement for lexical retrieval (lexical remains the stable
 * retrieval floor).
 *
 * `streams` narrows the cross-connector scope. Empty/undefined means
 * "every owner-visible stream that declares semantic_fields".
 *
 * See: openspec/changes/add-semantic-retrieval-experimental-extension/specs/semantic-retrieval/spec.md
 */
export async function searchRecordsSemantic(
  query: string,
  opts: { streams?: string[]; limit?: number; cursor?: string } = {}
): Promise<SearchResultPage> {
  await verifyDashboardSession();
  const token = await getOwnerToken();
  const url = new URL(`${getRsInternalUrl()}/v1/search/semantic`);
  url.searchParams.set("q", query);
  if (typeof opts.limit === "number") {
    url.searchParams.set("limit", String(opts.limit));
  }
  if (typeof opts.cursor === "string" && opts.cursor) {
    url.searchParams.set("cursor", opts.cursor);
  }
  for (const s of opts.streams ?? []) {
    if (typeof s === "string" && s.length > 0) {
      url.searchParams.append("streams", s);
    }
  }
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch (err) {
    throw new ReferenceServerUnreachableError(`Cannot reach resource server at ${getRsInternalUrl()}`, err);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`RS /v1/search/semantic failed (${res.status}): ${body}`);
  }
  const body = (await res.json()) as SearchResultPage;
  return { ...body, warnings: extractReadWarnings(body) };
}

/**
 * Fail-closed probe for `capabilities.semantic_retrieval.supported: true` on
 * the RS's protected-resource metadata document. Returns false on any
 * error (network, parse, unsupported). Stripe/Linear-style — dashboards
 * should never surface backend configuration errors the user cannot act on.
 *
 * The metadata document is unauthenticated, so no token is required.
 */
export async function isSemanticRetrievalAdvertised(): Promise<boolean> {
  try {
    const res = await fetch(`${getRsInternalUrl()}/.well-known/oauth-protected-resource`, {
      cache: "no-store",
    });
    if (!res.ok) {
      return false;
    }
    const body = (await res.json()) as { capabilities?: { semantic_retrieval?: { supported?: boolean } } };
    return body.capabilities?.semantic_retrieval?.supported === true;
  } catch {
    return false;
  }
}

/**
 * Fail-closed probe for `capabilities.hybrid_retrieval.supported: true` on
 * the RS's protected-resource metadata document. Returns false on any error.
 * Mirrors isSemanticRetrievalAdvertised exactly — same fail-closed contract.
 */
export async function isHybridRetrievalAdvertised(): Promise<boolean> {
  try {
    const res = await fetch(`${getRsInternalUrl()}/.well-known/oauth-protected-resource`, {
      cache: "no-store",
    });
    if (!res.ok) {
      return false;
    }
    const body = (await res.json()) as { capabilities?: { hybrid_retrieval?: { supported?: boolean } } };
    return body.capabilities?.hybrid_retrieval?.supported === true;
  } catch {
    return false;
  }
}

/**
 * Call the experimental hybrid retrieval endpoint at GET /v1/search/hybrid.
 * Only call this when `isHybridRetrievalAdvertised()` returns true.
 *
 * The endpoint deduplicates by (connector_id, stream, record_key) server-side
 * and returns provenance in `retrieval_sources`. v1 does not support cursors;
 * this is a first-page-only call.
 *
 * See: openspec/changes/define-hybrid-retrieval/specs/hybrid-retrieval/spec.md
 */
export async function searchRecordsHybrid(
  query: string,
  opts: { streams?: string[]; limit?: number } = {}
): Promise<SearchResultPage> {
  await verifyDashboardSession();
  const token = await getOwnerToken();
  const url = new URL(`${getRsInternalUrl()}/v1/search/hybrid`);
  url.searchParams.set("q", query);
  if (typeof opts.limit === "number") {
    url.searchParams.set("limit", String(opts.limit));
  }
  for (const s of opts.streams ?? []) {
    if (typeof s === "string" && s.length > 0) {
      url.searchParams.append("streams", s);
    }
  }
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch (err) {
    throw new ReferenceServerUnreachableError(`Cannot reach resource server at ${getRsInternalUrl()}`, err);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`RS /v1/search/hybrid failed (${res.status}): ${body}`);
  }
  const body = (await res.json()) as SearchResultPage;
  return { ...body, warnings: extractReadWarnings(body) };
}

export async function listConnectorManifests(): Promise<ConnectorManifest[]> {
  const files = await readdir(MANIFESTS_DIR);
  const manifests: ConnectorManifest[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    try {
      const raw = await readFile(join(MANIFESTS_DIR, file), "utf8");
      const m = JSON.parse(raw) as ConnectorManifest;
      if (m.connector_id) {
        manifests.push(m);
      }
    } catch {
      // skip malformed
    }
  }
  manifests.sort((a, b) => a.connector_id.localeCompare(b.connector_id));
  return manifests;
}

export interface ConnectorOverview {
  connectionHealth?: RefConnectionHealthSnapshot;
  connectionId?: string;
  connector: ConnectorManifest;
  connectorDisplayName?: string;
  connectorInstanceId?: string;
  error?: string;
  /** Shortcut: true iff lastRun.status ∈ {started, in_progress}. */
  isRunning: boolean;
  /** Most recent run (any status). Drives the status chip + elapsed time. */
  lastRun: ConnectorRunRef | null;
  /** Most recent SUCCEEDED run. Drives the "last synced" timestamp + delta. */
  lastSuccessfulRun: ConnectorRunRef | null;
  /**
   * Push-mode (local-device exporter) durable progress for this connection.
   * Populated only when the reference server has a trusted device-side
   * heartbeat row scoped to this `connectorInstanceId`. The records page
   * uses this to render "last ingest" / "last checked" instead of
   * "no scheduler run yet".
   */
  localDeviceProgress?: RefLocalDeviceProgress | null;
  retainedBytes?: RefRetainedBytesBreakdown | null;
  streamCount?: number;
  streams: StreamSummary[];
  totalRecords: number;
  totalRetainedBytes?: number | null;
}

/** Thin projection of RunSummary fields the dashboard index needs.
 *  Keeps this module decoupled from ref-client (which is AS-scoped). */
export interface ConnectorRunRef {
  event_count: number;
  failure_reason: string | null;
  first_at: string;
  known_gaps?: unknown[];
  last_at: string;
  run_id: string;
  status: string;
}

// ─── Display helpers (colocated to keep page files small) ────────────────

/**
 * All observed data keys across the provided records, in insertion order.
 * Used as the "All columns" superset the user can customize against.
 */
export function deriveAllColumns(records: StreamRecord[]): string[] {
  if (!records.length) {
    return [];
  }
  const keys = new Set<string>();
  for (const r of records) {
    if (r.data && typeof r.data === "object") {
      for (const k of Object.keys(r.data)) {
        keys.add(k);
      }
    }
  }
  return Array.from(keys);
}

/**
 * Backward-compatible cap — used only by callers that want a truncated view
 * and do not need quality filtering.
 */
export function deriveColumns(records: StreamRecord[], max = 10): string[] {
  return deriveAllColumns(records).slice(0, max);
}

const PRIORITY_KEYS = [
  "id",
  "name",
  "title",
  "subject",
  "label",
  "status",
  "state",
  "created_at",
  "updated_at",
  "emitted_at",
];

interface ColumnStats {
  allLong: boolean;
  allSameValue: boolean;
  nonNullCount: number;
}

function computeColumnStats(key: string, records: StreamRecord[]): ColumnStats {
  let nonNullCount = 0;
  let firstValue: string | null = null;
  let allSameValue = true;
  let allLong = true;
  for (const r of records) {
    const v = r.data?.[key];
    if (v === null || v === undefined) {
      continue;
    }
    nonNullCount += 1;
    const s = stringifyCell(v);
    if (firstValue === null) {
      firstValue = s;
    } else if (s !== firstValue) {
      allSameValue = false;
    }
    if (s.length <= 120) {
      allLong = false;
    }
  }
  return { nonNullCount, allSameValue, allLong };
}

function shouldKeepColumn(key: string, records: StreamRecord[]): boolean {
  const { nonNullCount, allSameValue, allLong } = computeColumnStats(key, records);
  if (nonNullCount === 0) {
    return false; // all-null in this page
  }
  if (nonNullCount >= 2 && allSameValue) {
    return false; // constant column
  }
  if (nonNullCount >= 2 && allLong) {
    return false; // blob column
  }
  return true;
}

/**
 * Progressive disclosure default column set. SLVP convention:
 *   1. If the stream's manifest declares `preview_fields: string[]`, use it
 *      (subset to keys actually present in the current page — a manifest
 *      may declare fields that don't appear in every record).
 *   2. Otherwise, heuristic: drop always-null, always-constant, and
 *      always-long-blob columns, then prefer PRIORITY_KEYS, cap at `limit`.
 */
export function computeDefaultColumns(
  records: StreamRecord[],
  streamManifest?: StreamManifest | null,
  limit = 6
): string[] {
  const all = deriveAllColumns(records);
  if (all.length === 0) {
    return [];
  }

  const previewFields = streamManifest?.preview_fields;
  const declared = Array.isArray(previewFields) ? previewFields.filter((f) => all.includes(f)) : [];
  if (declared.length > 0) {
    return declared;
  }

  const keep = all.filter((key) => shouldKeepColumn(key, records));

  keep.sort((a, b) => {
    const ai = PRIORITY_KEYS.indexOf(a);
    const bi = PRIORITY_KEYS.indexOf(b);
    if (ai !== -1 && bi !== -1) {
      return ai - bi;
    }
    if (ai !== -1) {
      return -1;
    }
    if (bi !== -1) {
      return 1;
    }
    return a.localeCompare(b);
  });

  return keep.slice(0, limit);
}

/**
 * Parse the user's URL `columns` selection into a resolved column list.
 *   - undefined / empty → defaults (caller-computed)
 *   - '*' → all observed columns
 *   - 'a,b,c' → exactly these, in this order, filtered to keys that appear
 */
export function resolveSelectedColumns(
  param: string | undefined,
  allColumns: string[],
  defaults: string[]
): { columns: string[]; mode: "default" | "custom" | "all" } {
  if (!param || param === "") {
    return { columns: defaults, mode: "default" };
  }
  if (param === "*") {
    return { columns: allColumns, mode: "all" };
  }
  const requested = param
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = requested.filter((c) => allColumns.includes(c));
  if (valid.length === 0) {
    return { columns: defaults, mode: "default" };
  }
  return { columns: valid, mode: "custom" };
}

export interface StreamManifest {
  name: string;
  preview_fields?: string[];
  [k: string]: unknown;
}

export function stringifyCell(v: unknown): string {
  if (v === null || v === undefined) {
    return "";
  }
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
}

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) {
    return "";
  }
  try {
    return new Date(iso).toISOString().replace("T", " ").replace(FRACTIONAL_SECONDS_RE, "Z");
  } catch {
    return iso;
  }
}

// ─── Stream health aggregation ──────────────────────────────────────────
//
// Samples up to `sampleSize` records (paginating the spec endpoint) and
// computes per-field null density, distinct value counts, whether the field
// appears anywhere in the data, and freshness (min/max `emitted_at` plus min/
// max of the manifest-declared `cursor_field` if any). Field set is the union
// of manifest-declared `schema.properties` and keys observed in the sample.

export interface FieldHealth {
  declared: boolean;
  distinctCapped: boolean;
  distinctValues: number; // capped; see DISTINCT_CAP
  name: string;
  nonNullCount: number;
  nullCount: number; // null / undefined / empty-string / []
  present: boolean; // appeared in at least one sampled record (non-missing key)
  sampleValue: string | null; // a short example non-null value, for context
}

export interface StreamHealth {
  connectorId: string;
  cursorField: string | null;
  cursorRange: { min: string | null; max: string | null } | null;
  emittedAt: { min: string | null; max: string | null };
  fields: FieldHealth[];
  limited: boolean; // totalRecords > sampled
  sampled: number;
  sampleLimit: number;
  streamName: string;
  summary: {
    declared: number;
    present: number;
    entirelyNull: number; // fields with nonNullCount === 0 (across sample)
    constValued: number; // fields with distinctValues === 1 and not all null
    declaredButAbsent: number; // manifest has it, data never emits it
    undeclaredPresent: number; // data has it, manifest doesn't declare it
  };
  totalRecords: number; // from RS metadata (not the sample)
}

const DISTINCT_CAP = 50;

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) {
    return true;
  }
  if (typeof v === "string" && v.length === 0) {
    return true;
  }
  if (Array.isArray(v) && v.length === 0) {
    return true;
  }
  return false;
}

function sampleRepr(v: unknown): string {
  if (v === null || v === undefined) {
    return "";
  }
  const s = typeof v === "string" ? v : stringifyCell(v);
  return truncate(s, 80);
}

function distinctKey(v: unknown): string {
  if (v === null || v === undefined) {
    return "\u0000null";
  }
  if (typeof v === "string") {
    return `s:${v}`;
  }
  if (typeof v === "number") {
    return `n:${String(v)}`;
  }
  if (typeof v === "boolean") {
    return `b:${String(v)}`;
  }
  try {
    return `j:${JSON.stringify(v)}`;
  } catch {
    return `x:${String(v)}`;
  }
}

interface StreamDef {
  cursor_field?: string;
  schema?: { properties?: Record<string, unknown> };
}

async function resolveStreamDef(
  connectorId: string,
  streamName: string
): Promise<{ cursorField: string | null; declaredProps: string[] }> {
  const manifests = await listConnectorManifests();
  const manifest = manifests.find((m) => m.connector_id === connectorId);
  const streamDef = (manifest?.streams ?? []).find((s) => s.name === streamName) as StreamDef | undefined;
  const declaredProps = streamDef?.schema?.properties ? Object.keys(streamDef.schema.properties) : [];
  const cursorField = streamDef?.cursor_field ?? null;
  return { cursorField, declaredProps };
}

async function resolveTotalRecords(
  connectorId: string,
  streamName: string,
  opts: ConnectionReadOptions = {}
): Promise<number> {
  try {
    const meta = (await getStreamMetadata(connectorId, streamName, opts)) as { record_count?: number };
    return typeof meta.record_count === "number" ? meta.record_count : 0;
  } catch {
    // soft: health still works, just unknown total
    return 0;
  }
}

async function paginateSampleRecords(
  connectorId: string,
  streamName: string,
  sampleLimit: number,
  pageSize: number,
  opts: ConnectionReadOptions = {}
): Promise<StreamRecord[]> {
  const records: StreamRecord[] = [];
  let cursor: string | undefined;
  while (records.length < sampleLimit) {
    const remaining = sampleLimit - records.length;
    const page = await queryRecords(connectorId, streamName, {
      connectorInstanceId: opts.connectorInstanceId,
      limit: Math.min(pageSize, remaining),
      cursor,
    });
    records.push(...page.data);
    if (!(page.has_more && page.next_cursor)) {
      break;
    }
    cursor = page.next_cursor;
    if (page.data.length === 0) {
      break;
    }
  }
  return records;
}

function collectFieldNames(declaredProps: string[], records: StreamRecord[]): Set<string> {
  const fieldNames = new Set<string>(declaredProps);
  for (const r of records) {
    if (r.data && typeof r.data === "object") {
      for (const k of Object.keys(r.data)) {
        fieldNames.add(k);
      }
    }
  }
  return fieldNames;
}

interface FieldAgg {
  distinct: Set<string>;
  distinctCapped: boolean;
  nonNullCount: number;
  nullCount: number;
  present: boolean;
  sampleValue: string | null;
}

function initAggMap(fieldNames: Set<string>): Map<string, FieldAgg> {
  const agg = new Map<string, FieldAgg>();
  for (const f of fieldNames) {
    agg.set(f, {
      present: false,
      nullCount: 0,
      nonNullCount: 0,
      distinct: new Set<string>(),
      distinctCapped: false,
      sampleValue: null,
    });
  }
  return agg;
}

function updateFieldAgg(a: FieldAgg, hasKey: boolean, v: unknown): void {
  if (hasKey) {
    a.present = true;
  }
  if (isEmpty(v)) {
    a.nullCount += 1;
    return;
  }
  a.nonNullCount += 1;
  if (!a.sampleValue) {
    a.sampleValue = sampleRepr(v);
  }
  if (!a.distinctCapped) {
    a.distinct.add(distinctKey(v));
    if (a.distinct.size > DISTINCT_CAP) {
      a.distinctCapped = true;
    }
  }
}

interface RangeTracker {
  max: string | null;
  min: string | null;
}

function extendRange(range: RangeTracker, value: string): void {
  if (range.min === null || value < range.min) {
    range.min = value;
  }
  if (range.max === null || value > range.max) {
    range.max = value;
  }
}

function extractCursorValue(data: Record<string, unknown>, cursorField: string): string | null {
  const cv = data[cursorField];
  if (typeof cv === "string" && cv) {
    return cv;
  }
  if (typeof cv === "number") {
    return String(cv);
  }
  return null;
}

interface ScanResult {
  agg: Map<string, FieldAgg>;
  cursorRange: RangeTracker;
  emittedRange: RangeTracker;
}

function scanRecords(records: StreamRecord[], fieldNames: Set<string>, cursorField: string | null): ScanResult {
  const agg = initAggMap(fieldNames);
  const emittedRange: RangeTracker = { min: null, max: null };
  const cursorRange: RangeTracker = { min: null, max: null };

  for (const r of records) {
    if (r.emitted_at) {
      extendRange(emittedRange, r.emitted_at);
    }
    const data = (r.data ?? {}) as Record<string, unknown>;
    if (cursorField) {
      const cv = extractCursorValue(data, cursorField);
      if (cv !== null) {
        extendRange(cursorRange, cv);
      }
    }
    for (const [f, a] of agg) {
      const hasKey = Object.hasOwn(data, f);
      updateFieldAgg(a, hasKey, hasKey ? data[f] : undefined);
    }
  }

  return { agg, emittedRange, cursorRange };
}

function projectFields(agg: Map<string, FieldAgg>, declaredProps: string[]): FieldHealth[] {
  const declaredSet = new Set(declaredProps);
  return Array.from(agg, ([name, a]) => ({
    name,
    declared: declaredSet.has(name),
    present: a.present,
    nullCount: a.nullCount,
    nonNullCount: a.nonNullCount,
    distinctValues: a.distinct.size,
    distinctCapped: a.distinctCapped,
    sampleValue: a.sampleValue,
  })).sort((x, y) => {
    // declared-first, then by name, for stable display
    if (x.declared !== y.declared) {
      return x.declared ? -1 : 1;
    }
    return x.name.localeCompare(y.name);
  });
}

function computeFieldSummary(fields: FieldHealth[]) {
  return {
    declared: fields.filter((f) => f.declared).length,
    present: fields.filter((f) => f.present).length,
    entirelyNull: fields.filter((f) => f.present && f.nonNullCount === 0).length,
    constValued: fields.filter((f) => f.nonNullCount > 0 && f.distinctValues === 1).length,
    declaredButAbsent: fields.filter((f) => f.declared && !f.present).length,
    undeclaredPresent: fields.filter((f) => !f.declared && f.present).length,
  };
}

export async function streamHealth(
  connectorId: string,
  streamName: string,
  opts: { connectorInstanceId?: string | null; sampleSize?: number; pageSize?: number } = {}
): Promise<StreamHealth> {
  const sampleLimit = Math.max(1, Math.min(opts.sampleSize ?? 2000, 20_000));
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? 500, 1000));

  const { cursorField, declaredProps } = await resolveStreamDef(connectorId, streamName);
  const totalRecords = await resolveTotalRecords(connectorId, streamName, {
    connectorInstanceId: opts.connectorInstanceId,
  });

  const records = await paginateSampleRecords(connectorId, streamName, sampleLimit, pageSize, {
    connectorInstanceId: opts.connectorInstanceId,
  });
  const fieldNames = collectFieldNames(declaredProps, records);
  const { agg, emittedRange, cursorRange } = scanRecords(records, fieldNames, cursorField);

  const fields = projectFields(agg, declaredProps);
  const summary = computeFieldSummary(fields);

  return {
    connectorId,
    streamName,
    totalRecords,
    sampled: records.length,
    sampleLimit,
    limited: totalRecords > records.length,
    emittedAt: { min: emittedRange.min, max: emittedRange.max },
    cursorField,
    cursorRange: cursorField ? { min: cursorRange.min, max: cursorRange.max } : null,
    fields,
    summary,
  };
}

const RUNNING_STATUSES = new Set(["started", "in_progress"]);

function projectRun(
  summary:
    | {
        run_id: string;
        first_at: string;
        last_at: string;
        event_count: number;
        status: string;
        failure_reason: string | null;
        known_gaps?: Record<string, unknown>[] | null;
      }
    | undefined
): ConnectorRunRef | null {
  if (!summary) {
    return null;
  }
  return {
    run_id: summary.run_id,
    first_at: summary.first_at,
    last_at: summary.last_at,
    event_count: summary.event_count,
    status: summary.status,
    failure_reason: summary.failure_reason,
    known_gaps: summary.known_gaps ?? [],
  };
}

export async function getConnectorOverview(connector: ConnectorManifest): Promise<ConnectorOverview> {
  try {
    const streams = await listStreams(connector.connector_id);
    const totalRecords = streams.reduce((sum, s) => sum + (s.record_count ?? 0), 0);

    // Run data: most-recent run (any status) + most-recent succeeded.
    // Kept lazy-import to avoid a cycle: ref-client imports from owner-token
    // which imports from here in some flows. Deferred require pattern.
    const { listRuns } = await import("./ref-client.ts");
    const [latestResp, successResp] = await Promise.all([
      listRuns({ connector_id: connector.connector_id, limit: 1 }),
      listRuns({ connector_id: connector.connector_id, status: "succeeded", limit: 1 }),
    ]);
    const lastRun = projectRun(latestResp.data?.[0]);
    const lastSuccessfulRun = projectRun(successResp.data?.[0]);
    const isRunning = lastRun != null && RUNNING_STATUSES.has(lastRun.status);

    return {
      connector,
      streams,
      totalRecords,
      lastRun,
      lastSuccessfulRun,
      isRunning,
    };
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      throw err;
    }
    return {
      connector,
      streams: [],
      totalRecords: 0,
      lastRun: null,
      lastSuccessfulRun: null,
      isRunning: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
