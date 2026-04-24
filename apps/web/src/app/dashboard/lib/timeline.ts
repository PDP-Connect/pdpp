/**
 * Cross-stream timeline loader.
 *
 * Pulls a bounded slice of records from every connector+stream that
 * declares a `consent_time_field`, filters by an optional [since, until]
 * window using that declared field, and returns the interleaved results
 * sorted by timestamp descending.
 *
 * Owner-token grants don't accept `time_range` as a query parameter, so
 * filtering is performed client-side here. We bound the per-stream fetch
 * to keep the page responsive; with the default PER_STREAM_LIMIT the
 * total work is at most (# time-anchored streams) * PER_STREAM_LIMIT
 * record fetches.
 */
import {
  type ConnectorManifest,
  listConnectorManifests,
  listStreams,
  queryRecords,
  type StreamRecord,
} from "./rs-client.ts";
import { summarize } from "./timeline-summaries.ts";

export type TimelineEntry = {
  connectorId: string;
  stream: string;
  recordId: string;
  timestamp: string; // ISO
  summary: string;
};

export type TimelineOptions = {
  since?: string; // ISO date or datetime
  until?: string;
  perStreamLimit?: number; // fetch budget per stream
  totalLimit?: number; // final trim after merge
};

type TimeAnchoredStream = {
  connectorId: string;
  streamName: string;
  consentTimeField: string;
};

// Defaults chosen so a 20-stream world comes in comfortably under a second.
const DEFAULT_PER_STREAM_LIMIT = 50;
const DEFAULT_TOTAL_LIMIT = 500;

export async function findTimeAnchoredStreams(): Promise<TimeAnchoredStream[]> {
  const manifests = await listConnectorManifests();
  const anchored: TimeAnchoredStream[] = [];
  for (const m of manifests) {
    for (const s of m.streams ?? []) {
      const ctf = (s as { consent_time_field?: string }).consent_time_field;
      if (ctf && typeof ctf === "string") {
        anchored.push({
          connectorId: m.connector_id,
          streamName: s.name,
          consentTimeField: ctf,
        });
      }
    }
  }
  return anchored;
}

/**
 * Return only the streams that actually have records in the current RS.
 * Called separately so callers can display "sources" hints without
 * re-querying.
 */
export async function connectorsWithData(manifests: ConnectorManifest[]): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  await Promise.all(
    manifests.map(async (m) => {
      try {
        const streams = await listStreams(m.connector_id);
        const withData = new Set(streams.filter((s) => s.record_count > 0).map((s) => s.name));
        if (withData.size) {
          result.set(m.connector_id, withData);
        }
      } catch {
        // Skip connector on error.
      }
    })
  );
  return result;
}

function parseTimestamp(raw: unknown): number | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw === "number") {
    // Epoch seconds vs ms heuristic.
    const ms = raw > 1e12 ? raw : raw * 1000;
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof raw !== "string") {
    return null;
  }
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

export async function loadTimeline(
  opts: TimelineOptions = {}
): Promise<{ entries: TimelineEntry[]; scanned: number; sources: number }> {
  const perStreamLimit = opts.perStreamLimit ?? DEFAULT_PER_STREAM_LIMIT;
  const totalLimit = opts.totalLimit ?? DEFAULT_TOTAL_LIMIT;
  const sinceMs = opts.since ? Date.parse(opts.since) : null;
  const untilMs = opts.until ? Date.parse(opts.until) : null;

  const manifests = await listConnectorManifests();
  const withData = await connectorsWithData(manifests);
  const anchored = await findTimeAnchoredStreams();

  // Only scan streams that (a) are time-anchored per manifest and
  // (b) have at least one record loaded in the RS.
  const target = anchored.filter((a) => withData.get(a.connectorId)?.has(a.streamName));

  const pages = await Promise.all(
    target.map(async (t) => {
      try {
        // order: 'desc' so the records endpoint returns newest row-ids
        // first. The record timestamp isn't strictly monotonic with row
        // id, but in the polyfill corpus it is close enough to
        // usefully bound the fetch.
        const page = await queryRecords(t.connectorId, t.streamName, {
          limit: perStreamLimit,
          order: "desc",
        });
        return { t, records: page.data };
      } catch {
        return { t, records: [] as StreamRecord[] };
      }
    })
  );

  let scanned = 0;
  const entries: TimelineEntry[] = [];

  for (const { t, records } of pages) {
    scanned += records.length;
    for (const r of records) {
      const raw = (r.data as Record<string, unknown>)?.[t.consentTimeField];
      const ms = parseTimestamp(raw);
      if (ms === null) {
        continue;
      }
      if (sinceMs !== null && ms < sinceMs) {
        continue;
      }
      if (untilMs !== null && ms >= untilMs) {
        continue;
      }
      entries.push({
        connectorId: t.connectorId,
        stream: t.streamName,
        recordId: r.id,
        timestamp: isoFromMs(ms),
        summary: summarize(t.connectorId, t.streamName, (r.data ?? {}) as Record<string, unknown>),
      });
    }
  }

  entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return {
    entries: entries.slice(0, totalLimit),
    scanned,
    sources: target.length,
  };
}

export function defaultWindow(days = 7): { since: string; until: string } {
  const now = Date.now();
  const since = new Date(now - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const until = new Date(now + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { since, until };
}

export function shortConnectorName(connectorId: string): string {
  const m = connectorId.match(/\/connectors\/([^/]+)$/);
  return m?.[1] ?? connectorId;
}
