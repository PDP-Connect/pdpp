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
  getRecord,
  searchRecordsLexical,
  type SearchResultHit,
} from '../lib/rs-client';
import { summarize } from '../lib/timeline-summaries';
import { shortConnectorName } from '../lib/timeline';

export const dynamic = 'force-dynamic';

// Page size for record hits. The public /v1/search surface enforces its own
// max; we just pass a reasonable default and honor the server's `has_more` +
// `next_cursor` for subsequent pages.
const RECORDS_PAGE_SIZE = 50;

type RecordHit = {
  connectorId: string;
  stream: string;
  recordId: string;
  emittedAt: string;
  snippet: string;
};

type RecordPage = {
  hits: RecordHit[];
  nextCursor?: string;
  hasMore: boolean;
};

type SearchResult = {
  exact: { kind: 'trace' | 'grant' | 'run'; id: string } | null;
  traces: TraceSummary[];
  grants: GrantSummary[];
  runs: RunSummary[];
  records: RecordPage;
};

/**
 * Map a public search_result hit into the dashboard's RecordHit shape. The
 * snippet is OPTIONAL in the public contract; when absent we hydrate a
 * one-line summary by reading the canonical record under the owner token.
 *
 * If hydration fails (record removed between index match and read, etc.)
 * we degrade to a stream-and-key label so the row still renders.
 */
async function hitToRecordHit(hit: SearchResultHit): Promise<RecordHit> {
  let snippet: string;
  if (hit.snippet?.text) {
    snippet = hit.snippet.text;
  } else {
    try {
      const record = await getRecord(hit.connector_id, hit.stream, hit.record_key);
      const data = (record.data ?? {}) as Record<string, unknown>;
      snippet = summarize(hit.connector_id, hit.stream, data) || `${hit.stream}/${hit.record_key}`;
    } catch {
      snippet = `${hit.stream}/${hit.record_key}`;
    }
  }
  return {
    connectorId: hit.connector_id,
    stream: hit.stream,
    recordId: hit.record_key,
    emittedAt: hit.emitted_at,
    snippet,
  };
}

/**
 * Fetch a single record page via the public lexical retrieval surface.
 * Defaults to all streams — the server fans out across every owner-visible
 * stream that declares `query.search.lexical_fields`.
 */
async function searchRecords(query: string, cursor?: string): Promise<RecordPage> {
  const page = await searchRecordsLexical(query, {
    limit: RECORDS_PAGE_SIZE,
    cursor,
  });
  const hits = await Promise.all(page.data.map(hitToRecordHit));
  return {
    hits,
    nextCursor: page.next_cursor,
    hasMore: Boolean(page.has_more),
  };
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; cursor?: string; jump?: string }>;
}) {
  const { q: qParam, cursor, jump } = await searchParams;
  const query = (qParam ?? '').trim();

  let result: SearchResult | null = null;
  let unreachable = false;

  if (query) {
    try {
      const spineResult = await refSearch(query);

      // Deep-link on exact id match. jump=0 opts out. Only applied on the
      // first page (no cursor) so paginating doesn't surprise the operator
      // by jumping away.
      if (spineResult.exact && jump !== '0' && !cursor) {
        const { kind, id } = spineResult.exact;
        const target =
          kind === 'trace'
            ? `/dashboard/traces/${encodeURIComponent(id)}`
            : kind === 'grant'
            ? `/dashboard/grants/${encodeURIComponent(id)}`
            : `/dashboard/runs/${encodeURIComponent(id)}`;
        redirect(target);
      }

      const records = await searchRecords(query, cursor);
      result = {
        exact: spineResult.exact,
        traces: spineResult.traces,
        grants: spineResult.grants,
        runs: spineResult.runs,
        records,
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

  const nextHref =
    result?.records.hasMore && result.records.nextCursor
      ? buildNextHref({ query, cursor: result.records.nextCursor })
      : null;

  return (
    <DashboardShell active="search">
      <header className="mb-4 flex items-baseline justify-between gap-4">
        <h1 className="text-lg font-semibold">Search</h1>
        {result && (
          <span className="text-muted-foreground text-xs">
            {result.traces.length + result.grants.length + result.runs.length} artifacts · {result.records.hits.length} records{result.records.hasMore ? '+' : ''}
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
        <button type="submit" className="border-border hover:bg-muted/50 self-start rounded border px-3 py-2 sm:self-auto">
          search
        </button>
      </form>

      {!query ? (
        <p className="text-muted-foreground text-xs">
          Paste a request/trace/grant/run id for a direct jump, or enter text to lexically search
          records across every stream that declares searchable fields.
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
              records ({result.records.hits.length}{result.records.hasMore ? '+' : ''})
            </h2>
            {result.records.hits.length === 0 ? (
              <p className="text-muted-foreground text-xs">No record-content hits.</p>
            ) : (
              <ul className="divide-border divide-y border-y">
                {result.records.hits.map((h) => (
                  <li key={`${h.connectorId}::${h.stream}::${h.recordId}`}>
                    <RecordRow hit={h} query={query} />
                  </li>
                ))}
              </ul>
            )}
            {nextHref ? (
              <div className="mt-3 flex justify-end">
                <Link href={nextHref} className="border-border hover:bg-muted/50 rounded border px-3 py-1.5 text-xs">
                  next page →
                </Link>
              </div>
            ) : null}
          </section>
        </>
      )}
    </DashboardShell>
  );
}

function buildNextHref({ query, cursor }: { query: string; cursor: string }): string {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  params.set('cursor', cursor);
  // Suppress the exact-id jump so an operator paginating doesn't redirect.
  params.set('jump', '0');
  return `/dashboard/search?${params.toString()}`;
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
