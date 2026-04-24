import Link from "next/link";
import { redirect } from "next/navigation";
import { DashboardShell, ServerUnreachable } from "../components/shell.tsx";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import { type GrantSummary, type RunSummary, refSearch, type TraceSummary } from "../lib/ref-client.ts";
import {
  getRecord,
  isSemanticRetrievalAdvertised,
  type SearchResultHit,
  type SearchResultPage,
  searchRecordsLexical,
  searchRecordsSemantic,
} from "../lib/rs-client.ts";
import { shortConnectorName } from "../lib/timeline.ts";
import { summarize } from "../lib/timeline-summaries.ts";

export const dynamic = "force-dynamic";

// Page-level per-page size for lexical retrieval — the primary, stable
// retrieval surface that paginates. Not a hard cap; has_more/next_cursor
// advances to subsequent pages.
const PAGE_LIMIT = 25;

// Top-N cap for the semantic-retrieval uplift. Stripe/Linear-style:
// semantic is blended into the first page only, as a quality boost, and
// is NOT paginated independently. This keeps the UX honest about semantic
// being additive rather than a separate infinite-scroll surface, and
// matches the approved design's "experimental, revisable" framing.
const SEMANTIC_UPLIFT_LIMIT = 10;

type RecordHit = {
  connectorId: string;
  stream: string;
  recordId: string;
  emittedAt: string;
  snippet: string;
  // True when this row was brought in by the semantic-retrieval uplift
  // AND did not also appear in the lexical result set. Drives the
  // per-row "also found by semantic match (experimental)" badge. Rows
  // that lexical retrieval found stay unbadged — the Stripe/Linear
  // pattern of surfacing the retrieval source only when it would
  // otherwise leave the user wondering "how did this match?".
  semanticOnly?: boolean;
};

type RecordPage = {
  hits: RecordHit[];
  hasMore: boolean;
  nextCursor: string | null;
  prevStack: string[];
};

type SearchResult = {
  exact: { kind: "trace" | "grant" | "run"; id: string } | null;
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
 * Dashboard record search. Runs the public lexical retrieval extension
 * (the stable retrieval floor) across every owner-visible stream that
 * declares lexical_fields. When the RS also advertises
 * `capabilities.semantic_retrieval`, runs semantic retrieval in parallel
 * and blends its hits in as a first-page quality uplift — Stripe/Linear
 * style: one query box, best-effort blended retrieval, never ask the
 * user which surface they want.
 *
 * Blend rules:
 *   - Lexical is primary. Its ordering is preserved; its pagination drives
 *     the URL's ?cursor= stack.
 *   - Semantic is additive. Hits that the lexical set already contains
 *     are discarded (dedup by connector/stream/record). Hits that are
 *     semantic-only get appended after the lexical list, each tagged with
 *     `semanticOnly: true` so the row renders with an "experimental"
 *     badge.
 *   - Semantic runs ONLY on the first page (cursor === null). Subsequent
 *     pages advance lexical only; semantic is a first-impression boost,
 *     not a second retrieval surface paginating alongside. This matches
 *     how Linear's blended search actually behaves.
 *   - Capability probe is fail-closed: if the RS doesn't advertise
 *     semantic retrieval, or the probe errors, we skip semantic silently.
 *     Dashboards should never surface backend configuration errors the
 *     user cannot act on.
 */
async function searchRecords(query: string, cursor: string | null, prevStack: string[]): Promise<RecordPage> {
  const wantSemantic = cursor === null && (await isSemanticRetrievalAdvertised());

  const [lexicalPage, semanticPage] = await Promise.all([
    searchRecordsLexical(query, {
      limit: PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    }),
    wantSemantic
      ? searchRecordsSemantic(query, { limit: SEMANTIC_UPLIFT_LIMIT }).catch(
          // Fail-closed on any runtime error too (not just capability probe).
          () => null as SearchResultPage | null
        )
      : Promise.resolve(null),
  ]);

  const lexicalHits = await Promise.all(lexicalPage.data.map((h) => hitToRecordHit(h)));

  // Only uplift if semantic ran AND returned hits.
  let upliftHits: RecordHit[] = [];
  if (semanticPage?.data?.length) {
    const dedupKeys = new Set(lexicalHits.map((h) => `${h.connectorId}::${h.stream}::${h.recordId}`));
    const semanticOnly: SearchResultHit[] = semanticPage.data.filter(
      (h: SearchResultHit) => !dedupKeys.has(`${h.connector_id}::${h.stream}::${h.record_key}`)
    );
    upliftHits = await Promise.all(
      semanticOnly.map(async (h: SearchResultHit) => {
        const base = await hitToRecordHit(h);
        return { ...base, semanticOnly: true };
      })
    );
  }

  return {
    hits: [...lexicalHits, ...upliftHits],
    // Pagination follows lexical only. has_more / next_cursor describe the
    // lexical stream; the semantic uplift is first-page-only.
    hasMore: lexicalPage.has_more,
    nextCursor: lexicalPage.next_cursor ?? null,
    prevStack,
  };
}

function parsePrevStack(raw: string | undefined): string[] {
  if (typeof raw !== "string" || raw.length === 0) {
    return [];
  }
  return raw.split(",").filter((s) => s.length > 0);
}

function encodePrevStack(stack: string[]): string {
  return stack.join(",");
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; cursor?: string; prev?: string; jump?: string }>;
}) {
  const { q: qParam, cursor: cursorParam, prev: prevParam, jump } = await searchParams;
  const query = (qParam ?? "").trim();
  const cursor = typeof cursorParam === "string" && cursorParam ? cursorParam : null;
  const prevStack = parsePrevStack(prevParam);

  let result: SearchResult | null = null;
  let unreachable = false;

  if (query) {
    try {
      const spineResult = await refSearch(query);

      // Deep-link on exact id match. jump=0 opts out. Only on the first page;
      // deep-links from deeper cursor pages would be confusing.
      if (spineResult.exact && jump !== "0" && !cursor) {
        const { kind, id } = spineResult.exact;
        const target =
          kind === "trace"
            ? `/dashboard/traces/${encodeURIComponent(id)}`
            : kind === "grant"
              ? `/dashboard/grants/${encodeURIComponent(id)}`
              : `/dashboard/runs/${encodeURIComponent(id)}`;
        redirect(target);
      }

      const records = await searchRecords(query, cursor, prevStack);
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

  return (
    <DashboardShell active="search">
      <header className="mb-4 flex items-baseline justify-between gap-4">
        <h1 className="font-semibold text-lg">Search</h1>
        {result && (
          <span className="text-muted-foreground text-xs">
            {result.traces.length + result.grants.length + result.runs.length} artifacts · {result.records.hits.length}{" "}
            records{result.records.hasMore ? "+" : ""}
          </span>
        )}
      </header>

      <form method="get" className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="trace id, grant id, run id, or text…"
          className="w-full rounded border border-border bg-background px-3 py-2 sm:max-w-md"
          autoFocus
        />
        <button
          type="submit"
          className="self-start rounded border border-border px-3 py-2 hover:bg-muted/50 sm:self-auto"
        >
          search
        </button>
      </form>

      {query ? (
        result ? (
          <>
            <ArtifactSection
              title="traces"
              href="/dashboard/traces"
              items={result.traces}
              renderItem={(t) => (
                <Link
                  href={`/dashboard/traces/${encodeURIComponent(t.trace_id)}`}
                  className="block px-2 py-2 text-xs hover:bg-muted/50"
                >
                  <code className="break-all font-medium">{t.trace_id}</code>
                  <div className="text-[11px] text-muted-foreground">
                    {t.status} · {t.event_count} events · {t.kinds.slice(0, 3).join(", ")}
                  </div>
                </Link>
              )}
            />
            <ArtifactSection
              title="grants"
              href="/dashboard/grants"
              items={result.grants}
              renderItem={(g) => (
                <Link
                  href={`/dashboard/grants/${encodeURIComponent(g.grant_id)}`}
                  className="block px-2 py-2 text-xs hover:bg-muted/50"
                >
                  <code className="break-all font-medium">{g.grant_id}</code>
                  <div className="text-[11px] text-muted-foreground">
                    {g.status} · client {g.client_id ?? "—"}
                  </div>
                </Link>
              )}
            />
            <ArtifactSection
              title="runs"
              href="/dashboard/runs"
              items={result.runs}
              renderItem={(r) => (
                <Link
                  href={`/dashboard/runs/${encodeURIComponent(r.run_id)}`}
                  className="block px-2 py-2 text-xs hover:bg-muted/50"
                >
                  <code className="break-all font-medium">{r.run_id}</code>
                  <div className="text-[11px] text-muted-foreground">
                    {r.status} · {r.connector_id ?? "—"}
                  </div>
                </Link>
              )}
            />

            <section className="mb-6">
              <h2 className="mb-2 text-muted-foreground text-xs uppercase tracking-wide">
                records ({result.records.hits.length}
                {result.records.hasMore ? "+" : ""})
              </h2>
              {result.records.hits.length === 0 ? (
                <p className="text-muted-foreground text-xs">No record-content hits.</p>
              ) : (
                <ul className="divide-y divide-border border-y">
                  {result.records.hits.map((h) => (
                    <li key={`${h.connectorId}::${h.stream}::${h.recordId}`}>
                      <RecordRow hit={h} query={query} />
                    </li>
                  ))}
                </ul>
              )}
              <PaginationBar
                query={query}
                cursor={cursor}
                prevStack={prevStack}
                hasMore={result.records.hasMore}
                nextCursor={result.records.nextCursor}
              />
            </section>
          </>
        ) : null
      ) : (
        <p className="text-muted-foreground text-xs">
          Paste a request/trace/grant/run id for a direct jump, or enter text to search records across every
          owner-visible stream that declares searchable fields.
        </p>
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
  if (items.length === 0) {
    return null;
  }
  return (
    <section className="mb-6">
      <h2 className="mb-2 flex items-baseline justify-between text-muted-foreground text-xs uppercase tracking-wide">
        <span>
          {title} ({items.length})
        </span>
        <Link href={href} className="normal-case tracking-normal hover:text-foreground">
          all →
        </Link>
      </h2>
      <ul className="divide-y divide-border border-y">
        {items.map((item, i) => (
          <li key={i}>{renderItem(item)}</li>
        ))}
      </ul>
    </section>
  );
}

function PaginationBar({
  query,
  cursor,
  prevStack,
  hasMore,
  nextCursor,
}: {
  query: string;
  cursor: string | null;
  prevStack: string[];
  hasMore: boolean;
  nextCursor: string | null;
}) {
  // Nothing to navigate to: no previous pages AND no next page.
  if (prevStack.length === 0 && !hasMore) {
    return null;
  }

  // Previous: pop the top of prevStack and use it as the new cursor.
  // The popped remainder becomes the next request's prev stack.
  let prevHref: string | null = null;
  if (prevStack.length > 0) {
    // prevStack.length > 0, so pop() must yield a defined entry; coalesce to
    // the 'first' sentinel so the subsequent cursor branch type-narrows
    // without a non-null assertion.
    const newStack = prevStack.slice(0, -1);
    const newCursor = prevStack[prevStack.length - 1] ?? "first";
    const params = new URLSearchParams({ q: query });
    if (newCursor !== "first") {
      params.set("cursor", newCursor);
    }
    if (newStack.length > 0) {
      params.set("prev", encodePrevStack(newStack));
    }
    prevHref = `/dashboard/search?${params.toString()}`;
  }

  // Next: push the current cursor onto prevStack and use next_cursor as the
  // new cursor. For the first page (cursor === null) we push a sentinel
  // 'first' so the prev-chain back is unambiguous.
  let nextHref: string | null = null;
  if (hasMore && nextCursor) {
    const newStack = [...prevStack, cursor ?? "first"];
    const params = new URLSearchParams({ q: query, cursor: nextCursor, prev: encodePrevStack(newStack) });
    nextHref = `/dashboard/search?${params.toString()}`;
  }

  return (
    <nav className="mt-3 flex items-center gap-3 text-xs" aria-label="record pagination">
      {prevHref ? (
        <Link href={prevHref} className="rounded border border-border px-3 py-1 hover:bg-muted/50">
          ← Previous
        </Link>
      ) : (
        <span className="px-3 py-1 text-muted-foreground opacity-50">← Previous</span>
      )}
      {nextHref ? (
        <Link href={nextHref} className="rounded border border-border px-3 py-1 hover:bg-muted/50">
          Next →
        </Link>
      ) : (
        <span className="px-3 py-1 text-muted-foreground opacity-50">Next →</span>
      )}
    </nav>
  );
}

function RecordRow({ hit, query }: { hit: RecordHit; query: string }) {
  const href = `/dashboard/records/${encodeURIComponent(hit.connectorId)}/${encodeURIComponent(hit.stream)}/${encodeURIComponent(hit.recordId)}`;
  return (
    <Link
      href={href}
      className="grid gap-1 px-2 py-2 text-xs hover:bg-muted/50 sm:grid-cols-[10rem_9rem_1fr] sm:items-baseline sm:gap-4"
    >
      <span className="whitespace-nowrap text-muted-foreground tabular-nums">{hit.emittedAt}</span>
      <span className="flex items-baseline gap-2 whitespace-nowrap">
        <span className="truncate font-medium">{shortConnectorName(hit.connectorId)}</span>
        <span className="truncate text-muted-foreground">{hit.stream}</span>
      </span>
      <span className="break-words">
        <Highlight text={hit.snippet} query={query} />
        {hit.semanticOnly ? (
          <span
            className="ml-2 inline-flex items-baseline gap-1 rounded border border-border px-1.5 py-0.5 align-baseline text-[10px] text-muted-foreground uppercase tracking-wide"
            title="This record did not match the text lexically. Found by semantic retrieval, which is an experimental feature and may change."
          >
            semantic · experimental
          </span>
        ) : null}
      </span>
    </Link>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) {
    return <>{text}</>;
  }
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) {
    return <>{text}</>;
  }
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
