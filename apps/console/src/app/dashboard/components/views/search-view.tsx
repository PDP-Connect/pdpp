/**
 * Shared dashboard Jump view. Renders the spine artifact lookup surface:
 * artifact buckets for traces, grants, and runs returned by
 * `GET /_ref/search`. Record content search lives on Explore, not here
 * (see `narrow-search-to-spine-jump`).
 *
 * The page resolves the data source query (artifact spine search only)
 * and passes a flat `SearchData` struct here. The view does not call any
 * data source itself.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import type { GrantSummary, RunSummary, TraceSummary } from "../../lib/ref-client.ts";
import type { Routes } from "./routes.ts";

export interface SearchData {
  exact: { kind: "trace" | "grant" | "run"; id: string } | null;
  grants: GrantSummary[];
  runs: RunSummary[];
  traces: TraceSummary[];
}

export function SearchView({
  query,
  data,
  routes,
  emptyHint,
}: {
  query: string;
  data: SearchData | null;
  routes: Routes;
  emptyHint?: ReactNode;
}) {
  return (
    <>
      <header className="mb-4 flex items-baseline justify-between gap-4">
        <h1 className="font-semibold text-lg">Jump</h1>
        {data ? (
          <span className="text-muted-foreground text-xs">
            {data.traces.length + data.grants.length + data.runs.length} artifacts
          </span>
        ) : null}
      </header>

      <form className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3" method="get">
        <input
          autoFocus
          className="w-full rounded border border-border bg-background px-3 py-2 sm:max-w-md"
          defaultValue={query}
          name="q"
          placeholder="trace id, grant id, or run id…"
          type="search"
        />
        <button
          className="self-start rounded border border-border px-3 py-2 hover:bg-muted/50 sm:self-auto"
          type="submit"
        >
          jump
        </button>
      </form>

      {query ? null : (
        <p className="text-muted-foreground text-xs">
          {emptyHint ?? "Paste a trace, grant, or run id."}
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
