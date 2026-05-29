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
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { formatConnectorKeyForDisplay } from "../../lib/connector-display.ts";
import type { GrantSummary, RunSummary, TraceSummary } from "../../lib/ref-client.ts";
import { PageHeader } from "../primitives.tsx";
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
  const artifactCount = data ? data.traces.length + data.grants.length + data.runs.length : null;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Explore", href: routes.section.explore }, { label: "Jump" }]}
        count={artifactCount !== null ? `${artifactCount} artifact${artifactCount === 1 ? "" : "s"}` : undefined}
        description="Paste a trace, grant, or run id to jump directly to it. For record content search, use Explore."
        title="Jump to artifact"
      />

      <form className="mb-6 flex flex-wrap items-end gap-x-3 gap-y-2" method="get">
        <label className="flex min-w-0 flex-1 flex-col gap-1" htmlFor="jump-q">
          <span className="pdpp-eyebrow text-muted-foreground">Artifact id</span>
          <Input
            autoFocus
            defaultValue={query}
            id="jump-q"
            name="q"
            placeholder="trace id, grant id, or run id…"
            type="search"
          />
        </label>
        <Button size="sm" type="submit" variant="default">
          Go
        </Button>
      </form>

      {query ? null : (
        <p className="pdpp-caption text-muted-foreground">{emptyHint ?? "Paste a trace, grant, or run id above."}</p>
      )}

      {query && data ? (
        <>
          <ArtifactSection
            getKey={(t: TraceSummary) => t.trace_id}
            href={routes.section.traces}
            items={data.traces}
            renderItem={(t: TraceSummary) => (
              <Link className="block px-2 py-2 hover:bg-muted/50" href={routes.trace(t.trace_id)}>
                <code className="pdpp-caption break-all font-medium">{t.trace_id}</code>
                <div className="pdpp-caption text-muted-foreground">
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
              <Link className="block px-2 py-2 hover:bg-muted/50" href={routes.grant(g.grant_id)}>
                <code className="pdpp-caption break-all font-medium">{g.grant_id}</code>
                <div className="pdpp-caption text-muted-foreground">
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
              <Link className="block px-2 py-2 hover:bg-muted/50" href={routes.run(r.run_id)}>
                <code className="pdpp-caption break-all font-medium">{r.run_id}</code>
                <div className="pdpp-caption text-muted-foreground">
                  {r.status} · {r.connector_id ? formatConnectorKeyForDisplay(r.connector_id) : "—"}
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
      <h2 className="pdpp-eyebrow mb-2 flex items-baseline justify-between text-muted-foreground">
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
