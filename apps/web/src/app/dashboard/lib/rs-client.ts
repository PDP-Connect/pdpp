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
import { getOwnerToken, getRsInternalUrl, ReferenceServerUnreachableError } from "./owner-token.ts";

export interface StreamSummary {
  object: "stream";
  name: string;
  record_count: number;
  last_updated: string | null;
}

export interface StreamRecord {
  object: "record";
  id: string;
  stream: string;
  data: Record<string, unknown>;
  emitted_at: string;
}

export interface RecordsPage {
  object: "list";
  data: StreamRecord[];
  has_more: boolean;
  next_cursor?: string;
}

export interface ConnectorManifest {
  connector_id: string;
  provider_id?: string;
  display_name?: string;
  name?: string;
  streams?: Array<{ name: string; [k: string]: unknown }>;
}

const MANIFESTS_DIR = join(process.cwd(), "..", "..", "packages", "polyfill-connectors", "manifests");

async function authedFetch(path: string, params?: Record<string, string | number | undefined>) {
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
    throw new Error(`RS ${path} failed (${res.status}): ${body}`);
  }
  return res.json();
}

export async function listStreams(connectorId: string): Promise<StreamSummary[]> {
  const body = (await authedFetch("/v1/streams", { connector_id: connectorId })) as {
    data: StreamSummary[];
  };
  return body.data ?? [];
}

export async function getStreamMetadata(connectorId: string, stream: string): Promise<Record<string, unknown>> {
  return (await authedFetch(`/v1/streams/${encodeURIComponent(stream)}`, {
    connector_id: connectorId,
  })) as Record<string, unknown>;
}

export async function queryRecords(
  connectorId: string,
  stream: string,
  opts: { limit?: number; cursor?: string; order?: "asc" | "desc" } = {}
): Promise<RecordsPage> {
  return (await authedFetch(`/v1/streams/${encodeURIComponent(stream)}/records`, {
    connector_id: connectorId,
    limit: opts.limit ?? 50,
    cursor: opts.cursor,
    order: opts.order,
  })) as RecordsPage;
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
export async function getRecord(connectorId: string, stream: string, recordId: string): Promise<StreamRecord> {
  return (await authedFetch(`/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(recordId)}`, {
    connector_id: connectorId,
  })) as StreamRecord;
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
  object: "search_result";
  stream: string;
  record_key: string;
  connector_id: string;
  record_url?: string;
  emitted_at: string;
  matched_fields: string[];
  snippet?: { field: string; text: string };
  // Present only on semantic-retrieval hits. Required on every /v1/search/semantic
  // result per the approved spec; absent on lexical hits. "hybrid" is reserved
  // for a future tranche (v1 lexical_blending is always false).
  retrieval_mode?: "semantic" | "hybrid";
}

export interface SearchResultPage {
  object: "list";
  url?: string;
  has_more: boolean;
  next_cursor?: string;
  data: SearchResultHit[];
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
  return (await res.json()) as SearchResultPage;
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
  return (await res.json()) as SearchResultPage;
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
  connector: ConnectorManifest;
  streams: StreamSummary[];
  totalRecords: number;
  /** Most recent run (any status). Drives the status chip + elapsed time. */
  lastRun: ConnectorRunRef | null;
  /** Most recent SUCCEEDED run. Drives the "last synced" timestamp + delta. */
  lastSuccessfulRun: ConnectorRunRef | null;
  /** Shortcut: true iff lastRun.status ∈ {started, in_progress}. */
  isRunning: boolean;
  error?: string;
}

/** Thin projection of RunSummary fields the dashboard index needs.
 *  Keeps this module decoupled from ref-client (which is AS-scoped). */
export interface ConnectorRunRef {
  run_id: string;
  first_at: string;
  last_at: string;
  event_count: number;
  status: string;
  failure_reason: string | null;
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

  const declared = Array.isArray(streamManifest?.preview_fields)
    ? streamManifest!.preview_fields!.filter((f) => all.includes(f))
    : [];
  if (declared.length > 0) {
    return declared;
  }

  const keep = all.filter((key) => {
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
  });

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
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) {
    return "";
  }
  try {
    return new Date(iso)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "Z");
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
  name: string;
  declared: boolean;
  present: boolean; // appeared in at least one sampled record (non-missing key)
  nullCount: number; // null / undefined / empty-string / []
  nonNullCount: number;
  distinctValues: number; // capped; see DISTINCT_CAP
  distinctCapped: boolean;
  sampleValue: string | null; // a short example non-null value, for context
}

export interface StreamHealth {
  connectorId: string;
  streamName: string;
  totalRecords: number; // from RS metadata (not the sample)
  sampled: number;
  sampleLimit: number;
  limited: boolean; // totalRecords > sampled
  emittedAt: { min: string | null; max: string | null };
  cursorField: string | null;
  cursorRange: { min: string | null; max: string | null } | null;
  fields: FieldHealth[];
  summary: {
    declared: number;
    present: number;
    entirelyNull: number; // fields with nonNullCount === 0 (across sample)
    constValued: number; // fields with distinctValues === 1 and not all null
    declaredButAbsent: number; // manifest has it, data never emits it
    undeclaredPresent: number; // data has it, manifest doesn't declare it
  };
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
    return "s:" + v;
  }
  if (typeof v === "number") {
    return "n:" + String(v);
  }
  if (typeof v === "boolean") {
    return "b:" + String(v);
  }
  try {
    return "j:" + JSON.stringify(v);
  } catch {
    return "x:" + String(v);
  }
}

export async function streamHealth(
  connectorId: string,
  streamName: string,
  opts: { sampleSize?: number; pageSize?: number } = {}
): Promise<StreamHealth> {
  const sampleLimit = Math.max(1, Math.min(opts.sampleSize ?? 2000, 20_000));
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? 500, 1000));

  // Manifest lookup (schema.properties + cursor_field)
  const manifests = await listConnectorManifests();
  const manifest = manifests.find((m) => m.connector_id === connectorId);
  const streamDef = (manifest?.streams ?? []).find((s) => s.name === streamName) as
    | {
        schema?: { properties?: Record<string, unknown> };
        cursor_field?: string;
      }
    | undefined;
  const declaredProps = streamDef?.schema?.properties ? Object.keys(streamDef.schema.properties) : [];
  const cursorField = streamDef?.cursor_field ?? null;

  // Stream metadata (record_count)
  let totalRecords = 0;
  try {
    const meta = (await getStreamMetadata(connectorId, streamName)) as {
      record_count?: number;
    };
    if (typeof meta.record_count === "number") {
      totalRecords = meta.record_count;
    }
  } catch {
    // soft: health still works, just unknown total
  }

  // Paginate the standard records endpoint, capped at sampleLimit.
  const records: StreamRecord[] = [];
  let cursor: string | undefined;
  while (records.length < sampleLimit) {
    const remaining = sampleLimit - records.length;
    const page = await queryRecords(connectorId, streamName, {
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

  // Aggregate
  const fieldNames = new Set<string>(declaredProps);
  for (const r of records) {
    if (r.data && typeof r.data === "object") {
      for (const k of Object.keys(r.data)) {
        fieldNames.add(k);
      }
    }
  }

  interface Agg {
    present: boolean;
    nullCount: number;
    nonNullCount: number;
    distinct: Set<string>;
    distinctCapped: boolean;
    sampleValue: string | null;
  }

  const agg = new Map<string, Agg>();
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

  let minEmitted: string | null = null;
  let maxEmitted: string | null = null;
  let minCursor: string | null = null;
  let maxCursor: string | null = null;

  for (const r of records) {
    if (r.emitted_at) {
      if (minEmitted === null || r.emitted_at < minEmitted) {
        minEmitted = r.emitted_at;
      }
      if (maxEmitted === null || r.emitted_at > maxEmitted) {
        maxEmitted = r.emitted_at;
      }
    }
    const data = (r.data ?? {}) as Record<string, unknown>;
    if (cursorField) {
      const cv = data[cursorField];
      if (typeof cv === "string" && cv) {
        if (minCursor === null || cv < minCursor) {
          minCursor = cv;
        }
        if (maxCursor === null || cv > maxCursor) {
          maxCursor = cv;
        }
      } else if (typeof cv === "number") {
        const s = String(cv);
        if (minCursor === null || s < minCursor) {
          minCursor = s;
        }
        if (maxCursor === null || s > maxCursor) {
          maxCursor = s;
        }
      }
    }
    for (const f of fieldNames) {
      const a = agg.get(f)!;
      const hasKey = Object.hasOwn(data, f);
      if (hasKey) {
        a.present = true;
      }
      const v = hasKey ? data[f] : undefined;
      if (isEmpty(v)) {
        a.nullCount += 1;
      } else {
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
    }
  }

  const declaredSet = new Set(declaredProps);
  const fields: FieldHealth[] = Array.from(fieldNames)
    .map((name) => {
      const a = agg.get(name)!;
      return {
        name,
        declared: declaredSet.has(name),
        present: a.present,
        nullCount: a.nullCount,
        nonNullCount: a.nonNullCount,
        distinctValues: a.distinct.size,
        distinctCapped: a.distinctCapped,
        sampleValue: a.sampleValue,
      };
    })
    .sort((x, y) => {
      // declared-first, then by name, for stable display
      if (x.declared !== y.declared) {
        return x.declared ? -1 : 1;
      }
      return x.name.localeCompare(y.name);
    });

  const summary = {
    declared: fields.filter((f) => f.declared).length,
    present: fields.filter((f) => f.present).length,
    entirelyNull: fields.filter((f) => f.present && f.nonNullCount === 0).length,
    constValued: fields.filter((f) => f.nonNullCount > 0 && f.distinctValues === 1).length,
    declaredButAbsent: fields.filter((f) => f.declared && !f.present).length,
    undeclaredPresent: fields.filter((f) => !f.declared && f.present).length,
  };

  return {
    connectorId,
    streamName,
    totalRecords,
    sampled: records.length,
    sampleLimit,
    limited: totalRecords > records.length,
    emittedAt: { min: minEmitted, max: maxEmitted },
    cursorField,
    cursorRange: cursorField ? { min: minCursor, max: maxCursor } : null,
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
