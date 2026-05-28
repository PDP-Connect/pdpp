import Link from "next/link";
import { redirect } from "next/navigation";
import { shouldAttemptSemanticUplift } from "pdpp-reference-implementation/deployment-diagnostics";
import { DashboardShell, ServerUnreachable } from "../components/shell.tsx";
import { dashboardRoutes } from "../components/views/routes.ts";
import { type SearchData, SearchView } from "../components/views/search-view.tsx";
import { WarningsBanner } from "../components/warnings-banner.tsx";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import type { CanonicalReadWarning } from "../lib/read-envelope.ts";
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
  listConnectorManifests,
  type SearchResultHit,
  type SearchResultPage,
  searchRecordsHybrid,
  searchRecordsLexical,
  searchRecordsSemantic,
} from "../lib/rs-client.ts";
import {
  lookupSearchTimestampMetadata,
  pickSearchDisplayTimestamp,
  type SearchTimestampMetadata,
  searchTimestampMetadataKey,
} from "../lib/search-record-timestamps.ts";
import { summarize } from "../lib/timeline-summaries.ts";
import { verifyDashboardSession } from "../lib/verify-session.ts";

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
  displayAt: string;
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
  timestampLabel: string;
}

interface RecordPage {
  debug?: RetrievalDebug;
  hasMore: boolean;
  hits: RecordHit[];
  nextCursor: string | null;
  prevStack: string[];
  retrievalNotice: RetrievalNotice | null;
  warnings: CanonicalReadWarning[];
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
async function buildSearchTimestampMetadata(): Promise<Map<string, SearchTimestampMetadata>> {
  const metadata = new Map<string, SearchTimestampMetadata>();
  for (const manifest of await listConnectorManifests()) {
    for (const stream of manifest.streams ?? []) {
      metadata.set(searchTimestampMetadataKey(manifest.connector_id, stream.name), {
        consent_time_field: typeof stream.consent_time_field === "string" ? stream.consent_time_field : null,
        cursor_field: typeof stream.cursor_field === "string" ? stream.cursor_field : null,
      });
    }
  }
  return metadata;
}

async function hitToRecordHit(
  hit: SearchResultHit,
  timestampMetadataByKey: ReadonlyMap<string, SearchTimestampMetadata>
): Promise<RecordHit> {
  let data: Record<string, unknown> | null = null;
  try {
    const record = await getRecord(hit.connector_id, hit.stream, hit.record_key);
    data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : null;
  } catch {
    data = null;
  }
  const snippet =
    hit.snippet?.text ??
    (data ? summarize(hit.connector_id, hit.stream, data) : null) ??
    `${hit.stream}/${hit.record_key}`;
  const displayTimestamp = pickSearchDisplayTimestamp({
    data,
    emittedAt: hit.emitted_at,
    metadata: lookupSearchTimestampMetadata(timestampMetadataByKey, hit.connector_id, hit.stream),
  });
  return {
    connectorId: hit.connector_id,
    stream: hit.stream,
    recordId: hit.record_key,
    displayAt: displayTimestamp.value,
    emittedAt: hit.emitted_at,
    snippet,
    timestampLabel: displayTimestamp.label,
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
      const [lexicalPage, timestampMetadataByKey] = await Promise.all([
        searchRecordsLexical(query, { limit: PAGE_LIMIT }),
        buildSearchTimestampMetadata(),
      ]);
      const hybridHits = await Promise.all(
        hybridResult.page.data.map(async (h: SearchResultHit) => {
          const base = await hitToRecordHit(h, timestampMetadataByKey);
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
        warnings: dedupeWarnings([...(hybridResult.page.warnings ?? []), ...(lexicalPage.warnings ?? [])]),
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
  const timestampMetadataByKey = await buildSearchTimestampMetadata();
  const lexicalHits = await Promise.all(lexicalPage.data.map((h) => hitToRecordHit(h, timestampMetadataByKey)));

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
        const base = await hitToRecordHit(h, timestampMetadataByKey);
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
    warnings: dedupeWarnings([...(lexicalPage.warnings ?? []), ...(semanticPage?.warnings ?? [])]),
  };
}

/**
 * Collapse multi-source search warnings by `code`+`dropped_parameter` so a
 * `source_skipped_not_applicable` emitted by both lexical and semantic does
 * not render twice. Keeps the first message we saw for each unique code.
 */
function dedupeWarnings(warnings: CanonicalReadWarning[]): CanonicalReadWarning[] {
  const seen = new Set<string>();
  const out: CanonicalReadWarning[] = [];
  for (const w of warnings) {
    const key = `${w.code}::${w.dropped_parameter ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(w);
  }
  return out;
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

  // Empty-query loads bypass `loadSearchResult`, so they would otherwise miss
  // the DAL gate. Verify the session here so the empty-shell render redirects
  // unauthenticated callers consistently with sibling dashboard routes.
  if (!query) {
    await verifyDashboardSession();
  }

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

  const data: SearchData | null = result
    ? {
        exact: result.exact,
        grants: result.grants,
        hasMore: result.records.hasMore,
        hits: result.records.hits,
        nextCursor: result.records.nextCursor,
        prevStack: result.records.prevStack,
        runs: result.runs,
        traces: result.traces,
      }
    : null;

  const searchWarnings = result?.records.warnings ?? [];

  return (
    <DashboardShell active="search">
      <WarningsBanner warnings={searchWarnings} />
      <SearchView
        currentCursor={cursor}
        data={data}
        debugSlot={
          debugMode && result?.records.debug ? (
            <pre className="mb-4 overflow-auto rounded border border-amber-500/50 bg-amber-50/50 p-3 text-[11px] dark:bg-amber-950/30">
              {JSON.stringify(result.records.debug, null, 2)}
            </pre>
          ) : null
        }
        emptyHint={
          <>
            Paste a request, trace, grant, or run id for a direct jump. To browse records by connection and stream, head
            to{" "}
            <Link className="underline underline-offset-2 hover:text-foreground" href={dashboardRoutes.section.explore}>
              Explore
            </Link>
            .
          </>
        }
        query={query}
        retrievalNotice={result?.records.retrievalNotice ?? null}
        routes={dashboardRoutes}
      />
    </DashboardShell>
  );
}
