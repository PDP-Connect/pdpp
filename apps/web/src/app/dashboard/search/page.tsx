import Link from "next/link";
import { redirect } from "next/navigation";
import { shouldAttemptSemanticUplift } from "pdpp-reference-implementation/deployment-diagnostics";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { DashboardShell, ServerUnreachable } from "../components/shell.tsx";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import {
  type GrantSummary,
  getDeploymentDiagnostics,
  type RunSummary,
  refSearch,
  type TraceSummary,
} from "../lib/ref-client.ts";
import {
  getRecord,
  isHybridRetrievalAdvertised,
  isSemanticRetrievalAdvertised,
  type SearchResultHit,
  type SearchResultPage,
  searchRecordsHybrid,
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

interface RecordHit {
  connectorId: string;
  emittedAt: string;
  // Which sources the hybrid endpoint reported for this specific record.
  // Undefined when hybrid retrieval was not used.
  hybridSources?: ("lexical" | "semantic")[];
  recordId: string;
  // True when the record came from client-side semantic uplift and was not
  // in the lexical result set. Drives the "semantic · experimental" badge.
  semanticOnly?: boolean;
  snippet: string;
  stream: string;
}

interface RecordPage {
  debug?: RetrievalDebug;
  hasMore: boolean;
  hits: RecordHit[];
  nextCursor: string | null;
  prevStack: string[];
  retrievalNotice: RetrievalNotice | null;
}

interface SearchResult {
  exact: { kind: "trace" | "grant" | "run"; id: string } | null;
  grants: GrantSummary[];
  records: RecordPage;
  runs: RunSummary[];
  traces: TraceSummary[];
}

interface RetrievalNotice {
  href: string;
  message: string;
  title: string;
}

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
 * Dashboard record search. Three retrieval modes in preference order:
 *
 * 1. Hybrid (preferred): When the RS advertises `capabilities.hybrid_retrieval`,
 *    call GET /v1/search/hybrid on the first page. The server deduplicates and
 *    scores server-side; results carry per-record provenance in `retrieval_sources`.
 *    No cursor in v1 — hybrid runs on the first page only.
 *
 * 2. Lexical + semantic blend (fallback when hybrid is absent): The original
 *    first-page-only semantic uplift. Lexical is primary and paginates;
 *    semantic-only hits are appended with a badge.
 *
 * 3. Lexical only (fallback when neither hybrid nor semantic are advertised or
 *    the participation gate is closed).
 *
 * All capability probes are fail-closed: an error returns false so the
 * dashboard degrades silently to a lower tier rather than surfacing
 * backend configuration errors the user cannot act on.
 */
async function searchRecords(query: string, cursor: string | null, prevStack: string[]): Promise<RecordPage> {
  let hybridAdvertised = false;
  let advertised = false;
  let participationFieldCount = 0;
  let semanticIndexState: "built" | "building" | "stale" | null = null;

  if (cursor === null) {
    // Probe both hybrid and semantic in parallel on the first page.
    const [hybridAdResult, semanticAdResult, diagnostics] = await Promise.all([
      isHybridRetrievalAdvertised(),
      isSemanticRetrievalAdvertised(),
      getDeploymentDiagnostics()
        .then((d) => ({
          participationFieldCount: d.semantic.participation.field_count,
          semanticIndexState: d.semantic.index.state,
        }))
        .catch(() => ({ participationFieldCount: 0, semanticIndexState: null })),
    ]);
    hybridAdvertised = hybridAdResult;
    advertised = semanticAdResult;
    participationFieldCount = diagnostics.participationFieldCount;
    semanticIndexState = diagnostics.semanticIndexState;
  }

  // ── Path 1: hybrid retrieval ──────────────────────────────────────────────
  if (hybridAdvertised && cursor === null) {
    const hybridResult = await searchRecordsHybrid(query, { limit: PAGE_LIMIT })
      .then((p) => ({ page: p, error: null as string | null }))
      .catch((err: unknown) => ({
        page: null as SearchResultPage | null,
        error: err instanceof Error ? err.message : String(err),
      }));

    if (hybridResult.page) {
      // Hybrid succeeded — use its results as the sole source for page 1.
      // Lexical still drives pages 2+; hybrid is a first-page quality boost.
      const lexicalPage = await searchRecordsLexical(query, { limit: PAGE_LIMIT });
      const hybridHits = await Promise.all(
        hybridResult.page.data.map(async (h: SearchResultHit) => {
          const base = await hitToRecordHit(h);
          return {
            ...base,
            hybridSources: Array.isArray(h.retrieval_sources) ? h.retrieval_sources : undefined,
          };
        })
      );

      const debug: RetrievalDebug = {
        isFirstPage: true,
        hybridAdvertised,
        hybridAttempted: true,
        hybridCount: hybridResult.page.data.length,
        hybridError: null,
        capabilityAdvertised: advertised,
        participationFieldCount,
        semanticIndexState,
        semanticAttempted: false,
        semanticError: null,
        lexicalCount: lexicalPage.data.length,
        semanticCount: 0,
        upliftCount: 0,
        dedupedOutCount: 0,
        semanticHitKeys: [],
      };

      return {
        hits: hybridHits,
        hasMore: lexicalPage.has_more,
        nextCursor: lexicalPage.next_cursor ?? null,
        prevStack,
        retrievalNotice: buildRetrievalNotice(semanticIndexState),
        debug,
      };
    }
    // Hybrid call failed — fall through to the lexical+semantic blend.
    // Log the error in debug but keep the gate open for the semantic path.
  }

  // ── Path 2 & 3: lexical (+ optional semantic uplift) ─────────────────────
  //
  // Semantic uplift requires TWO signals:
  //   1. RS advertises capabilities.semantic_retrieval.supported = true
  //   2. Diagnostics report ≥1 participating (connector, stream, field) tuple
  // The second check prevents "advertised + zero corpus" from looking like
  // "semantic ran and found nothing".
  const wantSemantic = cursor === null && shouldAttemptSemanticUplift({ advertised, participationFieldCount });

  const [lexicalPage, semanticResult] = await Promise.all([
    searchRecordsLexical(query, {
      limit: PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    }),
    wantSemantic
      ? searchRecordsSemantic(query, { limit: SEMANTIC_UPLIFT_LIMIT })
          .then((p) => ({ page: p, error: null as string | null }))
          .catch((err: unknown) => ({
            page: null as SearchResultPage | null,
            error: err instanceof Error ? err.message : String(err),
          }))
      : Promise.resolve({ page: null as SearchResultPage | null, error: null as string | null }),
  ]);

  const semanticPage = semanticResult.page;
  const lexicalHits = await Promise.all(lexicalPage.data.map((h) => hitToRecordHit(h)));

  let upliftHits: RecordHit[] = [];
  let dedupedOutCount = 0;
  if (semanticPage?.data?.length) {
    const dedupKeys = new Set(lexicalHits.map((h) => `${h.connectorId}::${h.stream}::${h.recordId}`));
    const semanticOnly: SearchResultHit[] = semanticPage.data.filter(
      (h: SearchResultHit) => !dedupKeys.has(`${h.connector_id}::${h.stream}::${h.record_key}`)
    );
    dedupedOutCount = semanticPage.data.length - semanticOnly.length;
    upliftHits = await Promise.all(
      semanticOnly.map(async (h: SearchResultHit) => {
        const base = await hitToRecordHit(h);
        return { ...base, semanticOnly: true };
      })
    );
  }

  const debug: RetrievalDebug = {
    isFirstPage: cursor === null,
    hybridAdvertised,
    hybridAttempted: false,
    hybridCount: 0,
    hybridError: null,
    capabilityAdvertised: advertised,
    participationFieldCount,
    semanticIndexState,
    semanticAttempted: wantSemantic,
    semanticError: semanticResult.error,
    lexicalCount: lexicalPage.data.length,
    semanticCount: semanticPage?.data?.length ?? 0,
    upliftCount: upliftHits.length,
    dedupedOutCount,
    semanticHitKeys:
      semanticPage?.data?.map((h: SearchResultHit) => `${h.connector_id}::${h.stream}::${h.record_key}`) ?? [],
  };

  return {
    hits: [...lexicalHits, ...upliftHits],
    hasMore: lexicalPage.has_more,
    nextCursor: lexicalPage.next_cursor ?? null,
    prevStack,
    retrievalNotice: buildRetrievalNotice(semanticIndexState),
    debug,
  };
}

interface RetrievalDebug {
  capabilityAdvertised: boolean;
  dedupedOutCount: number;
  hybridAdvertised: boolean;
  hybridAttempted: boolean;
  hybridCount: number;
  hybridError: string | null;
  isFirstPage: boolean;
  lexicalCount: number;
  participationFieldCount: number;
  semanticAttempted: boolean;
  semanticCount: number;
  semanticError: string | null;
  semanticHitKeys: string[];
  semanticIndexState: "built" | "building" | "stale" | null;
  upliftCount: number;
}

function buildRetrievalNotice(indexState: "built" | "building" | "stale" | null): RetrievalNotice | null {
  if (indexState === "building") {
    return {
      href: "/dashboard/deployment",
      title: "Semantic indexing is still running",
      message:
        "Search is using the records already indexed. Results may be partial until the background semantic rebuild finishes.",
    };
  }
  if (indexState === "stale") {
    return {
      href: "/dashboard/deployment",
      title: "Semantic index needs a rebuild",
      message:
        "The active embedding profile or declared semantic fields changed. Lexical search still works; semantic uplift may be stale or absent.",
    };
  }
  return null;
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

function exactMatchRedirectTarget(exact: { id: string; kind: "trace" | "grant" | "run" }): string {
  const { kind, id } = exact;
  if (kind === "trace") {
    return `/dashboard/traces/${encodeURIComponent(id)}`;
  }
  if (kind === "grant") {
    return `/dashboard/grants/${encodeURIComponent(id)}`;
  }
  return `/dashboard/runs/${encodeURIComponent(id)}`;
}

interface LoadSearchOutput {
  result: SearchResult | null;
  unreachable: boolean;
}

async function loadSearchResult(
  query: string,
  cursor: string | null,
  prevStack: string[],
  jump: string | undefined
): Promise<LoadSearchOutput> {
  try {
    const spineResult = await refSearch(query);

    // Deep-link on exact id match. jump=0 opts out. Only on the first page;
    // deep-links from deeper cursor pages would be confusing.
    if (spineResult.exact && jump !== "0" && !cursor) {
      redirect(exactMatchRedirectTarget(spineResult.exact));
    }

    const records = await searchRecords(query, cursor, prevStack);
    return {
      result: {
        exact: spineResult.exact,
        traces: spineResult.traces,
        grants: spineResult.grants,
        runs: spineResult.runs,
        records,
      },
      unreachable: false,
    };
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return { result: null, unreachable: true };
    }
    throw err;
  }
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; cursor?: string; prev?: string; jump?: string; debug?: string }>;
}) {
  const { q: qParam, cursor: cursorParam, prev: prevParam, jump, debug: debugParam } = await searchParams;
  const debugMode = debugParam === "1";
  const query = (qParam ?? "").trim();
  const cursor = typeof cursorParam === "string" && cursorParam ? cursorParam : null;
  const prevStack = parsePrevStack(prevParam);

  const { result, unreachable } = query
    ? await loadSearchResult(query, cursor, prevStack, jump)
    : { result: null, unreachable: false };

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

      <form className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3" method="get">
        <input
          autoFocus
          className="w-full rounded border border-border bg-background px-3 py-2 sm:max-w-md"
          defaultValue={query}
          name="q"
          placeholder="trace id, grant id, run id, or text…"
          type="search"
        />
        <button
          className="self-start rounded border border-border px-3 py-2 hover:bg-muted/50 sm:self-auto"
          type="submit"
        >
          search
        </button>
      </form>

      {debugMode && result?.records.debug ? (
        <pre className="mb-4 overflow-auto rounded border border-amber-500/50 bg-amber-50/50 p-3 text-[11px] dark:bg-amber-950/30">
          {JSON.stringify(result.records.debug, null, 2)}
        </pre>
      ) : null}

      {query ? (
        result && (
          <>
            <ArtifactSection
              getKey={(t) => t.trace_id}
              href="/dashboard/traces"
              items={result.traces}
              renderItem={(t) => (
                <Link
                  className="block px-2 py-2 text-xs hover:bg-muted/50"
                  href={`/dashboard/traces/${encodeURIComponent(t.trace_id)}`}
                >
                  <code className="break-all font-medium">{t.trace_id}</code>
                  <div className="text-[11px] text-muted-foreground">
                    {t.status} · {t.event_count} events · {t.kinds.slice(0, 3).join(", ")}
                  </div>
                </Link>
              )}
              title="traces"
            />
            <ArtifactSection
              getKey={(g) => g.grant_id}
              href="/dashboard/grants"
              items={result.grants}
              renderItem={(g) => (
                <Link
                  className="block px-2 py-2 text-xs hover:bg-muted/50"
                  href={`/dashboard/grants/${encodeURIComponent(g.grant_id)}`}
                >
                  <code className="break-all font-medium">{g.grant_id}</code>
                  <div className="text-[11px] text-muted-foreground">
                    {g.status} · client {g.client_id ?? "—"}
                  </div>
                </Link>
              )}
              title="grants"
            />
            <ArtifactSection
              getKey={(r) => r.run_id}
              href="/dashboard/runs"
              items={result.runs}
              renderItem={(r) => (
                <Link
                  className="block px-2 py-2 text-xs hover:bg-muted/50"
                  href={`/dashboard/runs/${encodeURIComponent(r.run_id)}`}
                >
                  <code className="break-all font-medium">{r.run_id}</code>
                  <div className="text-[11px] text-muted-foreground">
                    {r.status} · {r.connector_id ?? "—"}
                  </div>
                </Link>
              )}
              title="runs"
            />

            <RetrievalNoticeCallout notice={result.records.retrievalNotice} />

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
                cursor={cursor}
                hasMore={result.records.hasMore}
                nextCursor={result.records.nextCursor}
                prevStack={prevStack}
                query={query}
              />
            </section>
          </>
        )
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
  getKey,
}: {
  title: string;
  href: string;
  items: T[];
  renderItem: (item: T) => React.ReactNode;
  getKey: (item: T) => string;
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
        <Link className="normal-case tracking-normal hover:text-foreground" href={href}>
          all →
        </Link>
      </h2>
      <ul className="divide-y divide-border border-y">
        {items.map((item) => (
          <li key={getKey(item)}>{renderItem(item)}</li>
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
    const newCursor = prevStack.at(-1) ?? "first";
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
    <nav aria-label="record pagination" className="mt-3 flex items-center gap-3 text-xs">
      {prevHref ? (
        <Link className="rounded border border-border px-3 py-1 hover:bg-muted/50" href={prevHref}>
          ← Previous
        </Link>
      ) : (
        <span className="px-3 py-1 text-muted-foreground opacity-50">← Previous</span>
      )}
      {nextHref ? (
        <Link className="rounded border border-border px-3 py-1 hover:bg-muted/50" href={nextHref}>
          Next →
        </Link>
      ) : (
        <span className="px-3 py-1 text-muted-foreground opacity-50">Next →</span>
      )}
    </nav>
  );
}

function RetrievalNoticeCallout({ notice }: { notice: RetrievalNotice | null }) {
  if (!notice) {
    return null;
  }
  return (
    <div className="mb-4 rounded border border-amber-400/50 bg-amber-50/70 px-3 py-2 text-xs dark:bg-amber-950/30">
      <div className="font-medium">{notice.title}</div>
      <p className="mt-1 text-muted-foreground">
        {notice.message}{" "}
        <Link className="underline underline-offset-2 hover:text-foreground" href={notice.href}>
          View deployment diagnostics
        </Link>
        .
      </p>
    </div>
  );
}

function RetrievalBadge({ hit }: { hit: RecordHit }) {
  if (hit.hybridSources && hit.hybridSources.length > 0) {
    return (
      <span
        className="ml-2 inline-flex items-baseline gap-1 rounded border border-border px-1.5 py-0.5 align-baseline text-[10px] text-muted-foreground uppercase tracking-wide"
        title={`Found by hybrid retrieval (experimental). Sources: ${hit.hybridSources.join(", ")}.`}
      >
        {hit.hybridSources.join(" + ")} · hybrid
      </span>
    );
  }
  if (hit.semanticOnly) {
    return (
      <span
        className="ml-2 inline-flex items-baseline gap-1 rounded border border-border px-1.5 py-0.5 align-baseline text-[10px] text-muted-foreground uppercase tracking-wide"
        title="This record did not match the text lexically. Found by semantic retrieval, which is an experimental feature and may change."
      >
        semantic · experimental
      </span>
    );
  }
  return null;
}

function RecordRow({ hit, query }: { hit: RecordHit; query: string }) {
  const href = `/dashboard/records/${encodeURIComponent(hit.connectorId)}/${encodeURIComponent(hit.stream)}/${encodeURIComponent(hit.recordId)}`;
  return (
    <Link
      className="grid gap-1 px-2 py-2 text-xs hover:bg-muted/50 sm:grid-cols-[10rem_9rem_1fr] sm:items-baseline sm:gap-4"
      href={href}
    >
      <Timestamp className="whitespace-nowrap text-muted-foreground" value={hit.emittedAt} />
      <span className="flex items-baseline gap-2 whitespace-nowrap">
        <span className="truncate font-medium">{shortConnectorName(hit.connectorId)}</span>
        <span className="truncate text-muted-foreground">{hit.stream}</span>
      </span>
      <span className="break-words">
        <Highlight query={query} text={hit.snippet} />
        <RetrievalBadge hit={hit} />
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
