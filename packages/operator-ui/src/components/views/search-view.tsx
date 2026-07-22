// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
import { formatConnectorKeyForDisplay } from "../../lib/connector-display.ts";
import type { GrantSummary, RunSummary, TraceSummary } from "../../lib/ref-client.ts";
import { Button } from "../../ui/button.tsx";
import { Input } from "../../ui/input.tsx";
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
        count={artifactCount === null ? undefined : `${artifactCount} artifact${artifactCount === 1 ? "" : "s"}`}
        description="Paste a trace, grant, or run id to jump directly to it. For record content search, use Explore."
        title="Jump to artifact"
      />

      <form className="mb-6" method="get">
        <label className="mb-1 block" htmlFor="jump-q">
          <span className="pdpp-eyebrow text-muted-foreground">Artifact id</span>
        </label>
        {/* Input-group: single-unit control — input and Go share one border outline.
            Input: right side square (rounded-r-none), no right border (border-r-0).
            Button: left side square (rounded-l-none), inherits the shared border via
            outline variant; -ml-px collapses any sub-pixel gap. Both h-8 baseline. */}
        <div className="flex min-w-0">
          <Input
            autoFocus
            className="flex-1 rounded-r-none border-r-0 focus-visible:z-10"
            defaultValue={query}
            id="jump-q"
            name="q"
            placeholder="trace id, grant id, or run id…"
            type="search"
          />
          <Button
            className="-ml-px h-8 rounded-l-none px-3 text-sm focus-visible:z-10"
            size="default"
            type="submit"
            variant="outline"
          >
            Go
          </Button>
        </div>
      </form>

      {query ? null : (
        <p className="pdpp-caption text-muted-foreground">{emptyHint ?? "Paste a trace, grant, or run id above."}</p>
      )}

      {query && data ? (
        <>
          <ArtifactSection
            // biome-ignore lint/performance/noJsxPropsBind: non-memoized, inline binding intentional
            getKey={(t: TraceSummary) => t.trace_id}
            href={routes.section.traces}
            items={data.traces}
            // biome-ignore lint/performance/noJsxPropsBind: non-memoized, inline binding intentional
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
            // biome-ignore lint/performance/noJsxPropsBind: non-memoized, inline binding intentional
            getKey={(g: GrantSummary) => g.grant_id}
            href={routes.section.grants}
            items={data.grants}
            // biome-ignore lint/performance/noJsxPropsBind: non-memoized, inline binding intentional
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
            // biome-ignore lint/performance/noJsxPropsBind: non-memoized, inline binding intentional
            getKey={(r: RunSummary) => r.run_id}
            href={routes.section.runs}
            items={data.runs}
            // biome-ignore lint/performance/noJsxPropsBind: non-memoized, inline binding intentional
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
