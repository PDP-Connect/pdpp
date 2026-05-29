import Link from "next/link";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import type { DatasetSummary } from "../lib/ref-client.ts";

/**
 * Overview-page credibility hero.
 *
 * Three-band composition (per
 * `openspec/changes/reference-implementation-program/design-notes/dashboard-hero-compositions-2026-04-22.md`,
 * Composition A):
 *
 *   1. Integrated headline — retained bytes, records, connectors, timespan
 *   2. Quiet breadth row — top connectors by record count, identity dots
 *   3. Anatomy callout — generic explanatory sentence about the protocol flow
 *
 * No tiles, no cards, no sparklines, no deltas. Every number is live from
 * `GET /_ref/dataset/summary`. Degrades to an honest empty state when the
 * substrate holds no records yet.
 */
export function OverviewHero({
  summary,
  recordsHref,
  exploreHref,
}: {
  summary: DatasetSummary;
  recordsHref: string;
  exploreHref?: string;
}) {
  const projection = getProjectionMetadata(summary);
  const status = getProjectionStatus(projection);
  if (summary.record_count === 0 && projection && !projection.computed_at && status !== "fresh") {
    if (status === "failed") {
      return <OverviewHeroError message={projection.last_error ?? undefined} />;
    }
    return <OverviewHeroPlaceholder />;
  }
  if (summary.record_count === 0) {
    return <EmptyHero projection={projection} status={status} />;
  }

  return (
    <section aria-label="Dataset overview" className="mb-8">
      <p className="pdpp-heading font-semibold text-foreground tabular-nums">
        <span>{formatBytes(summary.total_retained_bytes)}</span>
        <span className="font-normal text-muted-foreground"> across </span>
        <span>{formatInteger(summary.record_count)}</span>
        <span className="font-normal text-muted-foreground"> records from </span>
        <span>{formatInteger(summary.connector_count)}</span>
        <span className="font-normal text-muted-foreground">
          {summary.connector_count === 1 ? " connector" : " connectors"}
        </span>
        {summary.earliest_record_time ? (
          <>
            <span className="font-normal text-muted-foreground"> · since </span>
            <Timestamp className="font-medium" mode="absolute" precision="date" value={summary.earliest_record_time} />
          </>
        ) : null}
      </p>

      <BreadthRow
        connectors={summary.top_connectors}
        recordsHref={recordsHref}
        totalConnectors={summary.connector_count}
      />
      {status ? <ProjectionStatusLine projection={projection} status={status} /> : null}

      <p className="pdpp-body mt-3 text-muted-foreground">
        Each approved grant issues runs that write records into streams.{" "}
        {exploreHref ? (
          <>
            <Link
              className="text-muted-foreground decoration-muted-foreground/50 underline-offset-2 hover:text-foreground hover:underline"
              href={exploreHref}
            >
              Explore records →
            </Link>{" "}
          </>
        ) : null}
        Every record is also readable through{" "}
        <Link
          className="text-muted-foreground decoration-muted-foreground/50 underline-offset-2 hover:text-foreground hover:underline"
          href={recordsHref}
        >
          individual connections
        </Link>{" "}
        or <code className="pdpp-caption font-mono">/v1/streams</code>.
      </p>
    </section>
  );
}

export function OverviewHeroPlaceholder() {
  return (
    <section aria-label="Dataset overview" className="mb-8">
      <p className="pdpp-heading font-semibold text-foreground">
        <span>Summarizing retained records...</span>
      </p>
      <p className="pdpp-body mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-muted-foreground">
        <span>records pending</span>
        <span>bytes pending</span>
        <span>connectors pending</span>
      </p>
      <p className="pdpp-body mt-3 text-muted-foreground">
        The dashboard shell is ready while the retained-record summary loads.
      </p>
    </section>
  );
}

export function OverviewHeroError({ message }: { message?: string }) {
  return (
    <section aria-label="Dataset overview" className="mb-8">
      <p className="pdpp-heading font-semibold text-foreground">
        <span>Could not load retained-record summary</span>
      </p>
      <p className="pdpp-body mt-3 text-muted-foreground">
        {message ?? "The dashboard can still show other operator sections while summary facts are unavailable."}
      </p>
    </section>
  );
}

function EmptyHero({
  projection,
  status,
}: {
  projection: DatasetSummary["projection"];
  status: ProjectionStatus | null;
}) {
  return (
    <section aria-label="Dataset overview" className="mb-8">
      <p className="pdpp-heading font-semibold text-foreground">
        <span>No records yet</span>
        <span className="font-normal text-muted-foreground"> · 0 connectors connected</span>
      </p>
      {status ? <ProjectionStatusLine projection={projection} status={status} /> : null}
      <p className="pdpp-body mt-3 text-muted-foreground">
        Start a grant to begin ingesting. Every record lands inspectable through{" "}
        <code className="pdpp-caption font-mono">/v1/streams</code>.
      </p>
    </section>
  );
}

type ProjectionStatus = "fresh" | "refreshing" | "stale" | "rebuilding" | "failed";

function getProjectionMetadata(summary: DatasetSummary): DatasetSummary["projection"] {
  return (
    summary.projection ?? {
      computed_at: summary.computed_at,
    }
  );
}

function getProjectionStatus(projection: DatasetSummary["projection"]): ProjectionStatus | null {
  const state = projection?.state;
  if (
    state === "fresh" ||
    state === "refreshing" ||
    state === "stale" ||
    state === "rebuilding" ||
    state === "failed"
  ) {
    return state;
  }
  if (projection?.rebuild_status === "running") {
    return "rebuilding";
  }
  if (projection?.rebuild_status === "failed" || projection?.last_error) {
    return "failed";
  }
  return projection?.computed_at ? "fresh" : null;
}

function ProjectionStatusLine({
  projection,
  status,
}: {
  projection: DatasetSummary["projection"];
  status: ProjectionStatus;
}) {
  const computedAt = projection?.computed_at;
  const staleSince = projection?.stale_since;
  const error = projection?.last_error;
  const label = projectionStatusLabel(status);
  return (
    <p className="pdpp-caption mt-2 text-muted-foreground">
      <span className="font-medium text-foreground">{label}</span>
      {computedAt ? (
        <>
          <span> · last computed </span>
          <Timestamp value={computedAt} />
        </>
      ) : null}
      {staleSince ? (
        <>
          <span> · stale since </span>
          <Timestamp value={staleSince} />
        </>
      ) : null}
      {error ? <span> · {error}</span> : null}
    </p>
  );
}

function projectionStatusLabel(status: ProjectionStatus): string {
  if (status === "refreshing") {
    return "Refreshing summary";
  }
  if (status === "stale") {
    return "Stale summary";
  }
  if (status === "rebuilding") {
    return "Rebuilding summary";
  }
  if (status === "failed") {
    return "Could not refresh summary";
  }
  return "Summary updated";
}

function BreadthRow({
  connectors,
  totalConnectors,
  recordsHref,
}: {
  connectors: DatasetSummary["top_connectors"];
  totalConnectors: number;
  recordsHref: string;
}) {
  if (connectors.length === 0) {
    return null;
  }
  const extra = Math.max(totalConnectors - connectors.length, 0);
  return (
    <p className="pdpp-body mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-muted-foreground">
      {connectors.map((c, i) => (
        <span className="inline-flex items-baseline gap-1.5" key={c.connector_id}>
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: identityColor(i) }}
          />
          <code className="pdpp-caption font-mono text-foreground" title={c.connector_id}>
            {displayConnectorSlug(c.connector_id)}
          </code>
          <span className="tabular-nums">{formatInteger(c.record_count)}</span>
        </span>
      ))}
      {extra > 0 ? (
        <Link
          className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          href={recordsHref}
        >
          +{extra} more
        </Link>
      ) : null}
    </p>
  );
}

// Deterministic low-saturation identity colors for the top-connectors row.
// These are small decorative dots only; no meaning is carried by specific hue.
const IDENTITY_PALETTE = [
  "oklch(0.72 0.12 65)",
  "oklch(0.70 0.11 155)",
  "oklch(0.68 0.13 240)",
  "oklch(0.70 0.11 320)",
  "oklch(0.72 0.10 25)",
] as const;

function identityColor(index: number): string {
  // Modulo keeps the lookup in-bounds; the fallback is a defensive no-op
  // that also satisfies `noUncheckedIndexedAccess` without a non-null assertion.
  return IDENTITY_PALETTE[index % IDENTITY_PALETTE.length] ?? IDENTITY_PALETTE[0];
}

function formatInteger(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "0";
}

function displayConnectorSlug(connectorId: string): string {
  return connectorId;
}

/**
 * Decimal byte formatter (MB = 1,000,000 bytes) matching Stripe/Vercel/Plaid
 * conventions and consumer intuition about "184 MB". Scales up through GB, TB.
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  let rounded: string | number = value.toFixed(2);
  if (value >= 100) {
    rounded = Math.round(value);
  } else if (value >= 10) {
    rounded = value.toFixed(1);
  }
  return `${rounded} ${units[unitIndex]}`;
}
