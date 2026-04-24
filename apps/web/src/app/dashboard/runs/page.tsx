import Link from "next/link";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { LivePoller } from "../components/live-poller.tsx";
import { PeekEmpty, PeekPane, PeekTimeline, pivotsFromEnvelope } from "../components/peek.tsx";
import {
  DataList,
  FilterSummary,
  PageHeader,
  Pager,
  SplitLayout,
  StatusBadge,
  Toolbar,
} from "../components/primitives.tsx";
import { DashboardShell, EmptyState, ServerUnreachable } from "../components/shell.tsx";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import {
  getRunTimeline,
  type ListResponse,
  listRuns,
  type RunSummary,
  type TimelineEnvelope,
} from "../lib/ref-client.ts";

export const dynamic = "force-dynamic";

interface Params {
  connector_id?: string;
  cursor?: string;
  peek?: string;
  q?: string;
  status?: string;
}

function renderRunsPeek({
  peekId,
  peekEnvelope,
  closePeekHref,
  openPeekFullHref,
}: {
  peekId: string | undefined;
  peekEnvelope: TimelineEnvelope | null;
  closePeekHref: string;
  openPeekFullHref: string;
}) {
  if (!peekId) {
    return <PeekEmpty />;
  }
  if (!peekEnvelope) {
    return (
      <PeekPane closeHref={closePeekHref} openHref={openPeekFullHref} title={`run ${peekId}`}>
        <p className="text-muted-foreground">Run not found.</p>
      </PeekPane>
    );
  }
  return (
    <PeekPane
      cliCommand={`pdpp run timeline ${peekId}`}
      closeHref={closePeekHref}
      openHref={openPeekFullHref}
      title={`run ${peekId}`}
    >
      <Pivots currentKind="run" envelope={peekEnvelope} />
      <div className="pdpp-caption mb-2 text-muted-foreground">{peekEnvelope.events.length} events</div>
      <PeekTimeline events={peekEnvelope.events} />
    </PeekPane>
  );
}

function listHref(params: Params, overrides: Partial<Params> = {}): string {
  const merged = { ...params, ...overrides };
  const qs = Object.entries(merged)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return qs ? `/dashboard/runs?${qs}` : "/dashboard/runs";
}

export default async function RunsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const filters = {
    cursor: params.cursor,
    status: params.status,
    connector_id: params.connector_id,
    q: params.q,
    limit: 50,
  };

  let result: ListResponse<RunSummary>;
  let peekEnvelope: TimelineEnvelope | null = null;
  try {
    result = await listRuns(filters);
    if (params.peek) {
      peekEnvelope = await getRunTimeline(params.peek);
    }
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="runs">
          <PageHeader title="Runs" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  const closePeekHref = listHref(params, { peek: undefined });
  const openPeekFullHref = params.peek ? `/dashboard/runs/${encodeURIComponent(params.peek)}` : "";

  const activeFilters = [
    params.status ? { label: "status", value: params.status } : null,
    params.connector_id ? { label: "connector", value: params.connector_id } : null,
    params.q ? { label: "query", value: params.q } : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item));

  // Auto-refresh this list whenever a run is still running or waiting on
  // operator input. A run with `status === "started"` is non-terminal, and
  // a run whose kinds contain `run.interaction_required` without a matching
  // `run.interaction_completed` is awaiting input and may transition at any
  // time.
  const liveRunCount = result.data.filter(isLiveRun).length;

  return (
    <DashboardShell active="runs">
      <LivePoller enabled={liveRunCount > 0} />
      <PageHeader
        count={`${result.data.length}${result.has_more ? "+" : ""}`}
        description="Connector runs and their lifecycle: staging, advance, progress, and failures."
        title="Runs"
      />

      <form method="get">
        <Toolbar>
          <label className="flex min-w-0 flex-col gap-1" htmlFor="runs-query">
            <span className="pdpp-eyebrow">Query</span>
            <Input
              className="w-56 font-mono"
              defaultValue={params.q ?? ""}
              id="runs-query"
              name="q"
              placeholder="id contains…"
              type="search"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1" htmlFor="runs-connector-id">
            <span className="pdpp-eyebrow">Connector</span>
            <Input
              className="w-48 font-mono"
              defaultValue={params.connector_id ?? ""}
              id="runs-connector-id"
              name="connector_id"
              placeholder="connector_id"
              type="text"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1" htmlFor="runs-status">
            <span className="pdpp-eyebrow">Status</span>
            <Select defaultValue={params.status ?? ""} id="runs-status" name="status">
              <option value="">Any</option>
              <option value="succeeded">succeeded</option>
              <option value="failed">failed</option>
              <option value="cancelled">cancelled</option>
              <option value="started">started</option>
            </Select>
          </label>
          <Button className="mt-5" size="sm" type="submit">
            Filter
          </Button>
        </Toolbar>
      </form>

      <FilterSummary items={activeFilters} resetHref="/dashboard/runs" />

      <SplitLayout
        main={
          <>
            {result.data.length === 0 ? (
              <EmptyState
                hint="Run artifacts appear after connector runs stage, advance, or fail."
                title="No runs yet"
              />
            ) : (
              <DataList>
                {result.data.map((r) => (
                  <li key={r.run_id}>
                    <RunRow params={params} run={r} />
                  </li>
                ))}
              </DataList>
            )}
            {result.has_more && result.next_cursor && <Pager next={listHref(params, { cursor: result.next_cursor })} />}
          </>
        }
        peek={renderRunsPeek({ peekId: params.peek, peekEnvelope, closePeekHref, openPeekFullHref })}
      />
    </DashboardShell>
  );
}

function RunRow({ run, params }: { run: RunSummary; params: Params }) {
  const peeked = params.peek === run.run_id;
  const awaitingInput = isAwaitingInteraction(run);
  return (
    <Link
      aria-current={peeked ? "true" : undefined}
      className={`block px-3 py-2.5 transition-colors ${peeked ? "bg-muted" : "hover:bg-muted/40"}`}
      href={listHref(params, { peek: run.run_id })}
      scroll={false}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <code className="pdpp-caption break-all font-medium font-mono text-foreground">{run.run_id}</code>
        <div className="flex items-center gap-2">
          {awaitingInput ? <AwaitingInputChip /> : null}
          <StatusBadge status={run.status} />
          <span className="pdpp-caption text-muted-foreground">
            <Timestamp value={run.last_at} />
          </span>
        </div>
      </div>
      <div className="pdpp-caption mt-1 text-muted-foreground">
        {run.event_count} events
        {run.connector_id ? ` · ${run.connector_id}` : ""}
        {run.provider_id ? ` · provider ${run.provider_id}` : ""}
        {run.failure_reason ? ` · ${run.failure_reason}` : ""}
      </div>
    </Link>
  );
}

function AwaitingInputChip() {
  return (
    <span
      className="pdpp-eyebrow rounded-[3px] bg-[color:var(--warning-wash)] px-1.5 py-0.5 font-medium text-[color:var(--warning)]"
      data-surface="human"
      title="This run is paused and requires operator input. Open it to respond."
    >
      needs input
    </span>
  );
}

// A run is "live" (worth auto-polling) if it is non-terminal OR is waiting
// on operator input. We key off the summary `kinds` array because the
// reference /_ref/runs endpoint already aggregates event types per run;
// no new contract is needed.
function isLiveRun(run: RunSummary): boolean {
  if (run.status === "started") {
    return true;
  }
  return isAwaitingInteraction(run);
}

function isAwaitingInteraction(run: RunSummary): boolean {
  // Summary aggregation: if any interaction_required event exists but no
  // interaction_completed event does, the run is waiting on input. This is
  // a best-effort signal — the run detail page remains authoritative and
  // matches individual interaction ids against completions.
  const kinds = new Set(run.kinds ?? []);
  return kinds.has("run.interaction_required") && !kinds.has("run.interaction_completed");
}

function Pivots({ envelope, currentKind }: { envelope: TimelineEnvelope; currentKind: "trace" | "grant" | "run" }) {
  const pivots = pivotsFromEnvelope(envelope).filter((p) => p.kind !== currentKind);
  if (pivots.length === 0) {
    return null;
  }
  return (
    <div className="mb-3 flex flex-wrap gap-1">
      {pivots.map((p) => (
        <Link
          className="pdpp-eyebrow rounded border border-border px-2 py-0.5 hover:bg-muted/60"
          href={`/dashboard/${p.kind}s?peek=${encodeURIComponent(p.id)}`}
          key={`${p.kind}:${p.id}`}
        >
          {p.kind} {p.id} →
        </Link>
      ))}
    </div>
  );
}
