import Link from 'next/link';
import { redirect } from 'next/navigation';
import { DashboardShell, ServerUnreachable } from '../components/shell';
import { ReferenceServerUnreachableError } from '../lib/owner-token';
import {
  refSearch,
  type GrantSummary,
  type RunSummary,
  type TraceSummary,
} from '../lib/ref-client';
import {
  listConnectorManifests,
  listStreams,
  queryRecords,
  type StreamRecord,
} from '../lib/rs-client';
import { summarize } from '../lib/timeline-summaries';
import { shortConnectorName } from '../lib/timeline';

export const dynamic = 'force-dynamic';

const PER_STREAM_LIMIT = 500;
const DEFAULT_MAX_RESULTS = 50;

type RecordHit = {
  connectorId: string;
  stream: string;
  recordId: string;
  emittedAt: string;
  snippet: string;
};

type SearchResult = {
  exact: { kind: 'trace' | 'grant' | 'run'; id: string } | null;
  traces: TraceSummary[];
  grants: GrantSummary[];
  runs: RunSummary[];
  records: RecordHit[];
  recordScanned: number;
  recordSources: number;
};

function looksLikeMessagesStream(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.includes('message') ||
    n.includes('chat') ||
    n.includes('conversation') ||
    n.includes('thread') ||
    n.includes('post') ||
    n.includes('comment') ||
    n.includes('note') ||
    n.includes('memo')
  );
}

function extractSnippet(data: Record<string, unknown>, query: string, radius = 60): string {
  const needle = query.toLowerCase();
  for (const [, v] of Object.entries(data)) {
    if (typeof v !== 'string') continue;
    const idx = v.toLowerCase().indexOf(needle);
    if (idx === -1) continue;
    const start = Math.max(0, idx - radius);
    const end = Math.min(v.length, idx + needle.length + radius);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < v.length ? '…' : '';
    return `${prefix}${v.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
  }
  return '';
}

function recordMatches(record: StreamRecord, query: string): boolean {
  if (!record.data) return false;
  const needle = query.toLowerCase();
  try {
    return JSON.stringify(record.data).toLowerCase().includes(needle);
  } catch {
    return false;
  }
}

async function searchRecords(query: string, scope: 'messages' | 'all'): Promise<{
  hits: RecordHit[];
  scanned: number;
  sources: number;
}> {
  const manifests = await listConnectorManifests();
  const perConnectorStreams = await Promise.all(
    manifests.map(async (m) => {
      try {
        const streams = await listStreams(m.connector_id);
        return streams
          .filter((s) => s.record_count > 0)
          .filter((s) => (scope === 'all' ? true : looksLikeMessagesStream(s.name)))
          .map((s) => ({ connectorId: m.connector_id, streamName: s.name }));
      } catch {
        return [];
      }
    }),
  );
  const targets = perConnectorStreams.flat();
  const pages = await Promise.all(
    targets.map(async (t) => {
      try {
        const page = await queryRecords(t.connectorId, t.streamName, {
          limit: PER_STREAM_LIMIT,
          order: 'desc',
        });
        return { t, records: page.data };
      } catch {
        return { t, records: [] as StreamRecord[] };
      }
    }),
  );

  let scanned = 0;
  const hits: RecordHit[] = [];
  for (const { t, records } of pages) {
    scanned += records.length;
    for (const r of records) {
      if (!recordMatches(r, query)) continue;
      const data = (r.data ?? {}) as Record<string, unknown>;
      const snippet = extractSnippet(data, query) || summarize(t.connectorId, t.streamName, data);
      hits.push({
        connectorId: t.connectorId,
        stream: t.streamName,
        recordId: r.id,
        emittedAt: r.emitted_at,
        snippet,
      });
      if (hits.length >= DEFAULT_MAX_RESULTS * 3) break;
    }
    if (hits.length >= DEFAULT_MAX_RESULTS * 3) break;
  }
  hits.sort((a, b) => (a.emittedAt < b.emittedAt ? 1 : a.emittedAt > b.emittedAt ? -1 : 0));
  return { hits: hits.slice(0, DEFAULT_MAX_RESULTS), scanned, sources: targets.length };
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; scope?: string; jump?: string }>;
}) {
  const { q: qParam, scope: scopeParam, jump } = await searchParams;
  const query = (qParam ?? '').trim();
  const scope = scopeParam === 'all' ? 'all' : 'messages';

  let result: SearchResult | null = null;
  let unreachable = false;

  if (query) {
    try {
      const spineResult = await refSearch(query);

      // Deep-link on exact id match. jump=0 opts out.
      if (spineResult.exact && jump !== '0') {
        const { kind, id } = spineResult.exact;
        const target =
          kind === 'trace'
            ? `/dashboard/traces/${encodeURIComponent(id)}`
            : kind === 'grant'
            ? `/dashboard/grants/${encodeURIComponent(id)}`
            : `/dashboard/runs/${encodeURIComponent(id)}`;
        redirect(target);
      }

      const recordResult = await searchRecords(query, scope);
      result = {
        exact: spineResult.exact,
        traces: spineResult.traces,
        grants: spineResult.grants,
        runs: spineResult.runs,
        records: recordResult.hits,
        recordScanned: recordResult.scanned,
        recordSources: recordResult.sources,
      };
    } catch (err) {
      if (err instanceof ReferenceServerUnreachableError) {
        unreachable = true;
      } else {
        throw err;
      }
    }
  }

  if (unreachable) {
    return (
      <DashboardShell active="search">
        <ServerUnreachable />
      </DashboardShell>
    );
  }

  return (
    <DashboardShell active="search">
      <header className="mb-4 flex items-baseline justify-between gap-4">
        <h1 className="text-lg font-semibold">Search</h1>
        {result && (
          <span className="text-muted-foreground text-xs">
            {result.traces.length + result.grants.length + result.runs.length} artifacts · {result.records.length} records
          </span>
        )}
      </header>

      <form method="get" className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="trace id, grant id, run id, or text…"
          className="border-border bg-background w-full rounded border px-3 py-2 sm:max-w-md"
          autoFocus
        />
        <label className="text-muted-foreground flex items-center gap-2 whitespace-nowrap text-xs">
          record scope
          <select
            name="scope"
            defaultValue={scope}
            className="border-border bg-background rounded border px-2 py-1"
          >
            <option value="messages">messages-like</option>
            <option value="all">all streams</option>
          </select>
        </label>
        <button type="submit" className="border-border hover:bg-muted/50 self-start rounded border px-3 py-2 sm:self-auto">
          search
        </button>
      </form>

      {!query ? (
        <p className="text-muted-foreground text-xs">
          Paste a request/trace/grant/run id for a direct jump, or enter text to substring-search
          records across streams.
        </p>
      ) : !result ? null : (
        <>
          <ArtifactSection title="traces" href="/dashboard/traces" items={result.traces} renderItem={(t) => (
            <Link href={`/dashboard/traces/${encodeURIComponent(t.trace_id)}`} className="hover:bg-muted/50 block px-2 py-2 text-xs">
              <code className="break-all font-medium">{t.trace_id}</code>
              <div className="text-muted-foreground text-[11px]">{t.status} · {t.event_count} events · {t.kinds.slice(0, 3).join(', ')}</div>
            </Link>
          )} />
          <ArtifactSection title="grants" href="/dashboard/grants" items={result.grants} renderItem={(g) => (
            <Link href={`/dashboard/grants/${encodeURIComponent(g.grant_id)}`} className="hover:bg-muted/50 block px-2 py-2 text-xs">
              <code className="break-all font-medium">{g.grant_id}</code>
              <div className="text-muted-foreground text-[11px]">{g.status} · client {g.client_id ?? '—'}</div>
            </Link>
          )} />
          <ArtifactSection title="runs" href="/dashboard/runs" items={result.runs} renderItem={(r) => (
            <Link href={`/dashboard/runs/${encodeURIComponent(r.run_id)}`} className="hover:bg-muted/50 block px-2 py-2 text-xs">
              <code className="break-all font-medium">{r.run_id}</code>
              <div className="text-muted-foreground text-[11px]">{r.status} · {r.connector_id ?? '—'}</div>
            </Link>
          )} />

          <section className="mb-6">
            <h2 className="text-muted-foreground mb-2 text-xs uppercase tracking-wide">
              records ({result.records.length})
              <span className="ml-2 normal-case tracking-normal">
                — {result.recordSources} streams scanned · {result.recordScanned} records
              </span>
            </h2>
            {result.records.length === 0 ? (
              <p className="text-muted-foreground text-xs">No record-content hits.</p>
            ) : (
              <ul className="divide-border divide-y border-y">
                {result.records.map((h) => (
                  <li key={`${h.connectorId}::${h.stream}::${h.recordId}`}>
                    <RecordRow hit={h} query={query} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </DashboardShell>
  );
}

function ArtifactSection<T>({
  title,
  href,
  items,
  renderItem,
}: {
  title: string;
  href: string;
  items: T[];
  renderItem: (item: T) => React.ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <section className="mb-6">
      <h2 className="text-muted-foreground mb-2 flex items-baseline justify-between text-xs uppercase tracking-wide">
        <span>
          {title} ({items.length})
        </span>
        <Link href={href} className="hover:text-foreground normal-case tracking-normal">
          all →
        </Link>
      </h2>
      <ul className="divide-border divide-y border-y">
        {items.map((item, i) => (
          <li key={i}>{renderItem(item)}</li>
        ))}
      </ul>
    </section>
  );
}

function RecordRow({ hit, query }: { hit: RecordHit; query: string }) {
  const href = `/dashboard/records/${encodeURIComponent(hit.connectorId)}/${encodeURIComponent(hit.stream)}/${encodeURIComponent(hit.recordId)}`;
  return (
    <Link href={href} className="hover:bg-muted/50 grid gap-1 px-2 py-2 text-xs sm:grid-cols-[10rem_9rem_1fr] sm:items-baseline sm:gap-4">
      <span className="text-muted-foreground whitespace-nowrap tabular-nums">{hit.emittedAt}</span>
      <span className="flex items-baseline gap-2 whitespace-nowrap">
        <span className="truncate font-medium">{shortConnectorName(hit.connectorId)}</span>
        <span className="text-muted-foreground truncate">{hit.stream}</span>
      </span>
      <span className="break-words">
        <Highlight text={hit.snippet} query={query} />
      </span>
    </Link>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-yellow-200 text-black dark:bg-yellow-700 dark:text-white">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}
