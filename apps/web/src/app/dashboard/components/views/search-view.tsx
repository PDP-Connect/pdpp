/**
 * Shared dashboard search view. Renders the unified search surface:
 * artifact buckets (traces / grants / runs) and the lexical record
 * results, with optional first-page semantic uplift rows.
 *
 * The page resolves the data source query (lexical + artifact spine
 * search), hydrates record snippets, and passes a flat `SearchData`
 * struct here. The view does not call any data source itself.
 *
 * The live `/dashboard/search` page additionally surfaces semantic
 * retrieval notices and a debug pane; those are page-side props.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import type { GrantSummary, RunSummary, TraceSummary } from "../../lib/ref-client.ts";
import type { Routes } from "./routes.ts";

export interface SearchRecordHit {
  connectorId: string;
  emittedAt: string;
  recordId: string;
  semanticOnly?: boolean;
  snippet: string;
  stream: string;
}

export interface SearchData {
  exact: { kind: "trace" | "grant" | "run"; id: string } | null;
  grants: GrantSummary[];
  hasMore: boolean;
  hits: SearchRecordHit[];
  nextCursor: string | null;
  prevStack: string[];
  runs: RunSummary[];
  traces: TraceSummary[];
}

export interface RetrievalNoticeView {
  href: string;
  message: string;
  title: string;
}

export function SearchView({
  query,
  data,
  routes,
  retrievalNotice,
  debugSlot,
  emptyHint,
}: {
  query: string;
  data: SearchData | null;
  routes: Routes;
  retrievalNotice?: RetrievalNoticeView | null;
  debugSlot?: ReactNode;
  emptyHint?: ReactNode;
}) {
  return (
    <>
      <header className="mb-4 flex items-baseline justify-between gap-4">
        <h1 className="font-semibold text-lg">Search</h1>
        {data ? (
          <span className="text-muted-foreground text-xs">
            {data.traces.length + data.grants.length + data.runs.length} artifacts · {data.hits.length}
            {data.hasMore ? "+" : ""} records
          </span>
        ) : null}
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

      {debugSlot}

      {query ? null : (
        <p className="text-muted-foreground text-xs">
          {emptyHint ??
            "Paste a request/trace/grant/run id for a direct jump, or enter text to search records across every owner-visible stream that declares searchable fields."}
        </p>
      )}

      {query && data ? (
        <>
          <ArtifactSection
            getKey={(t: TraceSummary) => t.trace_id}
            href={routes.section.traces}
            items={data.traces}
            renderItem={(t: TraceSummary) => (
              <Link className="block px-2 py-2 text-xs hover:bg-muted/50" href={routes.trace(t.trace_id)}>
                <code className="break-all font-medium">{t.trace_id}</code>
                <div className="text-[11px] text-muted-foreground">
                  {t.status} · {t.event_count} events · {t.kinds.slice(0, 3).join(", ")}
                </div>
              </Link>
            )}
            title="traces"
          />
          <ArtifactSection
            getKey={(g: GrantSummary) => g.grant_id}
            href={routes.section.grants}
            items={data.grants}
            renderItem={(g: GrantSummary) => (
              <Link className="block px-2 py-2 text-xs hover:bg-muted/50" href={routes.grant(g.grant_id)}>
                <code className="break-all font-medium">{g.grant_id}</code>
                <div className="text-[11px] text-muted-foreground">
                  {g.status} · client {g.client_id ?? "—"}
                </div>
              </Link>
            )}
            title="grants"
          />
          <ArtifactSection
            getKey={(r: RunSummary) => r.run_id}
            href={routes.section.runs}
            items={data.runs}
            renderItem={(r: RunSummary) => (
              <Link className="block px-2 py-2 text-xs hover:bg-muted/50" href={routes.run(r.run_id)}>
                <code className="break-all font-medium">{r.run_id}</code>
                <div className="text-[11px] text-muted-foreground">
                  {r.status} · {r.connector_id ?? "—"}
                </div>
              </Link>
            )}
            title="runs"
          />

          {retrievalNotice ? <RetrievalNoticeCallout notice={retrievalNotice} /> : null}

          <section className="mb-6">
            <h2 className="mb-2 text-muted-foreground text-xs uppercase tracking-wide">
              records ({data.hits.length}
              {data.hasMore ? "+" : ""})
            </h2>
            {data.hits.length === 0 ? (
              <p className="text-muted-foreground text-xs">No record-content hits.</p>
            ) : (
              <ul className="divide-y divide-border border-y">
                {data.hits.map((h) => (
                  <li key={`${h.connectorId}::${h.stream}::${h.recordId}`}>
                    <RecordRow hit={h} query={query} routes={routes} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </>
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
  renderItem: (item: T) => ReactNode;
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

function RetrievalNoticeCallout({ notice }: { notice: RetrievalNoticeView }) {
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

const DEMO_SUFFIX_RE = /_demo$/;

function RecordRow({ hit, query, routes }: { hit: SearchRecordHit; query: string; routes: Routes }) {
  const href = routes.record(hit.connectorId, hit.stream, hit.recordId);
  return (
    <Link
      className="grid gap-1 px-2 py-2 text-xs hover:bg-muted/50 sm:grid-cols-[10rem_9rem_1fr] sm:items-baseline sm:gap-4"
      href={href}
    >
      <Timestamp className="whitespace-nowrap text-muted-foreground" value={hit.emittedAt} />
      <span className="flex items-baseline gap-2 whitespace-nowrap">
        <span className="truncate font-medium">{hit.connectorId.replace(DEMO_SUFFIX_RE, "")}</span>
        <span className="truncate text-muted-foreground">{hit.stream}</span>
      </span>
      <span className="break-words">
        <Highlight query={query} text={hit.snippet} />
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
