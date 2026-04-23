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
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ReferenceServerUnreachableError,
  getOwnerToken,
  getRsInternalUrl,
} from './owner-token';

export type StreamSummary = {
  object: 'stream';
  name: string;
  record_count: number;
  last_updated: string | null;
};

export type StreamRecord = {
  object: 'record';
  id: string;
  stream: string;
  data: Record<string, unknown>;
  emitted_at: string;
};

export type RecordsPage = {
  object: 'list';
  data: StreamRecord[];
  has_more: boolean;
  next_cursor?: string;
};

export type ConnectorManifest = {
  connector_id: string;
  provider_id?: string;
  display_name?: string;
  name?: string;
  streams?: Array<{ name: string; [k: string]: unknown }>;
};

const MANIFESTS_DIR = join(
  process.cwd(),
  '..',
  '..',
  'packages',
  'polyfill-connectors',
  'manifests',
);

async function authedFetch(path: string, params?: Record<string, string | number | undefined>) {
  const token = await getOwnerToken();
  const url = new URL(`${getRsInternalUrl()}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
  } catch (err) {
    throw new ReferenceServerUnreachableError(
      `Cannot reach resource server at ${getRsInternalUrl()}`,
      err,
    );
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`RS ${path} failed (${res.status}): ${body}`);
  }
  return res.json();
}

export async function listStreams(connectorId: string): Promise<StreamSummary[]> {
  const body = (await authedFetch('/v1/streams', { connector_id: connectorId })) as {
    data: StreamSummary[];
  };
  return body.data ?? [];
}

export async function getStreamMetadata(
  connectorId: string,
  stream: string,
): Promise<Record<string, unknown>> {
  return (await authedFetch(`/v1/streams/${encodeURIComponent(stream)}`, {
    connector_id: connectorId,
  })) as Record<string, unknown>;
}

export async function queryRecords(
  connectorId: string,
  stream: string,
  opts: { limit?: number; cursor?: string; order?: 'asc' | 'desc' } = {},
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
export async function getRecord(
  connectorId: string,
  stream: string,
  recordId: string,
): Promise<StreamRecord> {
  return (await authedFetch(
    `/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(recordId)}`,
    { connector_id: connectorId },
  )) as StreamRecord;
}

export async function listConnectorManifests(): Promise<ConnectorManifest[]> {
  const files = await readdir(MANIFESTS_DIR);
  const manifests: ConnectorManifest[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(MANIFESTS_DIR, file), 'utf8');
      const m = JSON.parse(raw) as ConnectorManifest;
      if (m.connector_id) manifests.push(m);
    } catch {
      // skip malformed
    }
  }
  manifests.sort((a, b) => a.connector_id.localeCompare(b.connector_id));
  return manifests;
}

export type ConnectorOverview = {
  connector: ConnectorManifest;
  streams: StreamSummary[];
  totalRecords: number;
  error?: string;
};

// ─── Display helpers (colocated to keep page files small) ────────────────

export function deriveColumns(records: StreamRecord[], max = 10): string[] {
  if (!records.length) return [];
  const keys = new Set<string>();
  for (const r of records.slice(0, 5)) {
    if (r.data && typeof r.data === 'object') {
      for (const k of Object.keys(r.data)) keys.add(k);
    }
  }
  return Array.from(keys).slice(0, max);
}

export function stringifyCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
}

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
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

export type FieldHealth = {
  name: string;
  declared: boolean;
  present: boolean; // appeared in at least one sampled record (non-missing key)
  nullCount: number; // null / undefined / empty-string / []
  nonNullCount: number;
  distinctValues: number; // capped; see DISTINCT_CAP
  distinctCapped: boolean;
  sampleValue: string | null; // a short example non-null value, for context
};

export type StreamHealth = {
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
};

const DISTINCT_CAP = 50;

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && v.length === 0) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

function sampleRepr(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : stringifyCell(v);
  return truncate(s, 80);
}

function distinctKey(v: unknown): string {
  if (v === null || v === undefined) return '\u0000null';
  if (typeof v === 'string') return 's:' + v;
  if (typeof v === 'number') return 'n:' + String(v);
  if (typeof v === 'boolean') return 'b:' + String(v);
  try {
    return 'j:' + JSON.stringify(v);
  } catch {
    return 'x:' + String(v);
  }
}

export async function streamHealth(
  connectorId: string,
  streamName: string,
  opts: { sampleSize?: number; pageSize?: number } = {},
): Promise<StreamHealth> {
  const sampleLimit = Math.max(1, Math.min(opts.sampleSize ?? 2000, 20000));
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? 500, 1000));

  // Manifest lookup (schema.properties + cursor_field)
  const manifests = await listConnectorManifests();
  const manifest = manifests.find((m) => m.connector_id === connectorId);
  const streamDef = (manifest?.streams ?? []).find(
    (s) => s.name === streamName,
  ) as
    | {
        schema?: { properties?: Record<string, unknown> };
        cursor_field?: string;
      }
    | undefined;
  const declaredProps = streamDef?.schema?.properties
    ? Object.keys(streamDef.schema.properties)
    : [];
  const cursorField = streamDef?.cursor_field ?? null;

  // Stream metadata (record_count)
  let totalRecords = 0;
  try {
    const meta = (await getStreamMetadata(connectorId, streamName)) as {
      record_count?: number;
    };
    if (typeof meta.record_count === 'number') totalRecords = meta.record_count;
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
    if (!page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
    if (page.data.length === 0) break;
  }

  // Aggregate
  const fieldNames = new Set<string>(declaredProps);
  for (const r of records) {
    if (r.data && typeof r.data === 'object') {
      for (const k of Object.keys(r.data)) fieldNames.add(k);
    }
  }

  type Agg = {
    present: boolean;
    nullCount: number;
    nonNullCount: number;
    distinct: Set<string>;
    distinctCapped: boolean;
    sampleValue: string | null;
  };

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
      if (minEmitted === null || r.emitted_at < minEmitted) minEmitted = r.emitted_at;
      if (maxEmitted === null || r.emitted_at > maxEmitted) maxEmitted = r.emitted_at;
    }
    const data = (r.data ?? {}) as Record<string, unknown>;
    if (cursorField) {
      const cv = data[cursorField];
      if (typeof cv === 'string' && cv) {
        if (minCursor === null || cv < minCursor) minCursor = cv;
        if (maxCursor === null || cv > maxCursor) maxCursor = cv;
      } else if (typeof cv === 'number') {
        const s = String(cv);
        if (minCursor === null || s < minCursor) minCursor = s;
        if (maxCursor === null || s > maxCursor) maxCursor = s;
      }
    }
    for (const f of fieldNames) {
      const a = agg.get(f)!;
      const hasKey = Object.prototype.hasOwnProperty.call(data, f);
      if (hasKey) a.present = true;
      const v = hasKey ? data[f] : undefined;
      if (isEmpty(v)) {
        a.nullCount += 1;
      } else {
        a.nonNullCount += 1;
        if (!a.sampleValue) a.sampleValue = sampleRepr(v);
        if (!a.distinctCapped) {
          a.distinct.add(distinctKey(v));
          if (a.distinct.size > DISTINCT_CAP) a.distinctCapped = true;
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
      if (x.declared !== y.declared) return x.declared ? -1 : 1;
      return x.name.localeCompare(y.name);
    });

  const summary = {
    declared: fields.filter((f) => f.declared).length,
    present: fields.filter((f) => f.present).length,
    entirelyNull: fields.filter((f) => f.present && f.nonNullCount === 0).length,
    constValued: fields.filter((f) => f.nonNullCount > 0 && f.distinctValues === 1)
      .length,
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

export async function getConnectorOverview(
  connector: ConnectorManifest,
): Promise<ConnectorOverview> {
  try {
    const streams = await listStreams(connector.connector_id);
    const totalRecords = streams.reduce((sum, s) => sum + (s.record_count ?? 0), 0);
    return { connector, streams, totalRecords };
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) throw err;
    return {
      connector,
      streams: [],
      totalRecords: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
