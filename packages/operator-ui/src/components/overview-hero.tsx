import Link from "next/link";
import type { ReactNode } from "react";
import { formatConnectorKeyForDisplay } from "../lib/connector-display.ts";
import type { DatasetSummary } from "../lib/ref-client.ts";
import { Timestamp } from "../ui/timestamp.tsx";

/**
 * Overview-page credibility hero.
 *
 * Operator metric summary (Stripe/Linear/Vercel idiom), replacing the prior
 * run-on headline sentence:
 *
 *   1. Metric strip — a small set of KPI figures (records, size, connectors,
 *      streams). One-word eyebrow labels; the figure carries the weight (strong
 *      reserved for the records KPI); secondary context muted; tabular-nums so
 *      the numbers align. Elevation = surface-card fill + hairline border
 *      (no drop shadow), radius-md, spacing from the named scale.
 *   2. Distribution — top connectors ranked by share of records, each a labelled
 *      mini-bar with a right-aligned tabular count. Reads as an intentional
 *      distribution, not a comma list.
 *   3. Freshness line — projection status + "last computed N ago" (preserved).
 *   4. Anatomy callout — generic explanatory sentence about the protocol flow.
 *
 * Every number is live from `GET /_ref/dataset/summary`. No data is dropped
 * relative to the prior composition (bytes, records, connectors, timespan,
 * per-connector counts, freshness all survive). Degrades to an honest empty
 * state when the substrate holds no records yet.
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
      <MetricStrip computedAt={projection?.computed_at} summary={summary} />

      <DistributionRow
        connectors={summary.top_connectors}
        recordsHref={recordsHref}
        totalConnectors={summary.connector_count}
        totalRecords={summary.record_count}
      />
      {status ? (
        <ProjectionStatusLine
          earliestRecordTime={summary.earliest_record_time}
          projection={projection}
          status={status}
        />
      ) : null}

      <p className="pdpp-body mt-4 text-muted-foreground">
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

/**
 * The KPI figures with ONE clear focal point. Records is the north-star metric,
 * so it is promoted to a primary hero tile: a wider card carrying the
 * display-scale figure, a protocol-primary tint + accent border, and a left
 * primary marker — the eye lands here first. Retained size, connectors, and
 * streams are demoted to a clearly secondary tier: a tighter row of plain cards
 * with smaller figures and a muted label, read as supporting facts to the
 * headline rather than four equal-weight peers. Every figure is tabular-nums so
 * the numbers align. Elevation is the surface ladder — `bg-card`/tint fill + a
 * hairline border, radius-md, no drop shadow; spacing from the named 4px scale.
 */
function MetricStrip({ summary, computedAt }: { summary: DatasetSummary; computedAt?: string | null }) {
  const bytes = splitBytes(summary.total_retained_bytes);
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.9fr)]">
      <PrimaryMetric
        caption={<RecordsSummaryLine computedAt={computedAt} summary={summary} />}
        context="retained"
        label="Records"
        value={formatInteger(summary.record_count)}
      />
      <dl className="grid grid-cols-3 gap-3">
        <SecondaryMetric context={bytes.unit} label="Retained" value={bytes.value} />
        <SecondaryMetric
          context={summary.connector_count === 1 ? "source" : "sources"}
          label="Connectors"
          value={formatInteger(summary.connector_count)}
        />
        <SecondaryMetric
          context={summary.stream_count === 1 ? "stream" : "streams"}
          label="Streams"
          value={formatInteger(summary.stream_count)}
        />
      </dl>
    </div>
  );
}

/**
 * One plain-language sentence under the dominant Records KPI — the investor /
 * standards-reviewer read of the same facts the figures already carry ("2.06M
 * records across 28 connectors · last synced 7m ago"). Every value is live: the
 * compact record count, the connector count, and the projection freshness
 * instant the status line already uses (reusing <Timestamp> so the "N ago" tick
 * stays consistent). Muted, single line, tabular-nums on the numbers.
 */
function RecordsSummaryLine({ summary, computedAt }: { summary: DatasetSummary; computedAt?: string | null }) {
  return (
    <span className="pdpp-caption text-muted-foreground">
      <span className="tabular-nums">{formatCompactInteger(summary.record_count)}</span> records across{" "}
      <span className="tabular-nums">{formatInteger(summary.connector_count)}</span>{" "}
      {summary.connector_count === 1 ? "connector" : "connectors"}
      {computedAt ? (
        <>
          {" · last synced "}
          <Timestamp className="text-muted-foreground" mode="relative" value={computedAt} />
        </>
      ) : null}
    </span>
  );
}

/**
 * The single dominant KPI. Primary tint + accent border + left marker and the
 * display-scale figure make it the page's one focal point. Rendered as its own
 * <dl> so the primary/secondary split doesn't break the description-list
 * semantics.
 */
function PrimaryMetric({
  label,
  value,
  context,
  caption,
}: {
  label: string;
  value: string;
  context: string;
  caption?: ReactNode;
}) {
  return (
    <dl className="rounded-md border border-primary/30 bg-[color:var(--primary-wash)] px-4 py-3 shadow-[inset_2px_0_0_0_var(--primary)]">
      <dt className="pdpp-eyebrow text-primary/90">{label}</dt>
      <dd className="mt-1 flex items-baseline gap-2">
        <span className="pdpp-display font-semibold text-foreground tabular-nums">{value}</span>
        <span className="pdpp-caption text-muted-foreground">{context}</span>
      </dd>
      {caption ? <dd className="mt-2">{caption}</dd> : null}
    </dl>
  );
}

/**
 * A supporting KPI: plain card, heading-scale figure at medium (not semibold)
 * weight so it reads as clearly subordinate to the 40px semibold Records hero
 * while staying a legible number — not a caption. `pdpp-heading` is the figure
 * scale; we deliberately avoid stacking a second font-size utility on top of it.
 */
function SecondaryMetric({ label, value, context }: { label: string; value: string; context: string }) {
  return (
    <div className="flex flex-col rounded-md border border-border bg-card px-4 py-3">
      <dt className="pdpp-eyebrow">{label}</dt>
      <dd className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="pdpp-heading font-medium text-foreground tabular-nums tracking-tight">{value}</span>
        <span className="pdpp-caption text-muted-foreground">{context}</span>
      </dd>
    </div>
  );
}

/**
 * Top connectors as a ranked distribution: each row is a labelled mini-bar
 * sized to its share of total records, with a right-aligned tabular count and
 * percentage. Dense but legible; reads as a distribution, not a comma list.
 */
function DistributionRow({
  connectors,
  totalConnectors,
  totalRecords,
  recordsHref,
}: {
  connectors: DatasetSummary["top_connectors"];
  totalConnectors: number;
  totalRecords: number;
  recordsHref: string;
}) {
  if (connectors.length === 0) {
    return null;
  }
  const extra = Math.max(totalConnectors - connectors.length, 0);
  const top = connectors[0]?.record_count ?? 0;
  return (
    <div className="mt-4">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="pdpp-eyebrow">Top connectors by records</h3>
        {extra > 0 ? (
          <Link
            className="pdpp-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            href={recordsHref}
          >
            +{extra} more →
          </Link>
        ) : null}
      </div>
      <ul className="flex flex-col gap-2">
        {connectors.map((c) => {
          const connectorKey = formatConnectorKeyForDisplay(c.connector_id);
          // Bar width is share of the leading connector (relative bar) so the
          // distribution shape is legible even when the long tail is small.
          const relative = top > 0 ? Math.max((c.record_count / top) * 100, 2) : 0;
          const share = totalRecords > 0 ? (c.record_count / totalRecords) * 100 : 0;
          return (
            <li className="flex items-center gap-3" key={c.connector_id}>
              <code
                className="pdpp-caption shrink-0 truncate font-mono text-foreground"
                style={{ width: "10.5rem" }}
                title={connectorKey}
              >
                {connectorKey}
              </code>
              <span aria-hidden className="hidden h-1.5 flex-1 overflow-hidden rounded-full bg-muted sm:block">
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${relative}%`, backgroundColor: distributionBarColor(c.record_count, top) }}
                />
              </span>
              <span className="pdpp-caption ml-auto flex shrink-0 items-baseline justify-end gap-2 tabular-nums">
                <span className="font-medium text-foreground" style={{ minWidth: "4.5rem", textAlign: "right" }}>
                  {formatInteger(c.record_count)}
                </span>
                <span className="text-muted-foreground" style={{ width: "2.5rem", textAlign: "right" }}>
                  {formatShare(share)}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function OverviewHeroPlaceholder() {
  return (
    <section aria-label="Dataset overview" className="mb-8">
      <p className="pdpp-heading font-semibold text-foreground">
        <span>Summarizing retained records…</span>
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
  earliestRecordTime,
}: {
  projection: DatasetSummary["projection"];
  status: ProjectionStatus;
  earliestRecordTime?: string | null;
}) {
  const computedAt = projection?.computed_at;
  const staleSince = projection?.stale_since;
  const error = projection?.last_error;
  const label = projectionStatusLabel(status);
  return (
    <p className="pdpp-caption mt-3 text-muted-foreground">
      <span className="font-medium text-foreground">{label}</span>
      {computedAt ? (
        <>
          <span> · last computed </span>
          <Timestamp value={computedAt} />
        </>
      ) : null}
      {earliestRecordTime ? (
        <>
          <span> · spanning since </span>
          <Timestamp className="font-medium" mode="absolute" precision="date" value={earliestRecordTime} />
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

/**
 * Single-hue intensity ramp for the top-connectors distribution bars.
 *
 * The bars are ranked by record share, so color should encode *magnitude*, not
 * arbitrary category. Each bar is the protocol-primary blue at an opacity scaled
 * to that connector's share of the leading connector: the largest connector is
 * the most saturated, the long tail fades toward the muted track. This retires
 * the prior decorative rainbow palette the token foundation was meant to remove.
 *
 * The opacity floor (0.5) keeps even the smallest bar legible against the muted
 * track in BOTH themes — `--primary` is a bright blue on the dark charcoal track
 * and a saturated blue on the light track, so the floored ramp holds contrast
 * either way. The square-root curve keeps mid-tail bars from collapsing to the
 * floor so the gradient stays readable as a distribution.
 */
function distributionBarColor(recordCount: number, leadCount: number): string {
  const OPACITY_FLOOR = 0.5;
  const ratio = leadCount > 0 ? Math.min(Math.max(recordCount / leadCount, 0), 1) : 0;
  // sqrt softens the falloff so a connector with a small share still reads as a
  // distinct, slightly-lighter blue rather than snapping to the floor.
  const opacity = OPACITY_FLOOR + (1 - OPACITY_FLOOR) * Math.sqrt(ratio);
  return `color-mix(in oklab, var(--primary) ${Math.round(opacity * 100)}%, transparent)`;
}

function formatInteger(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "0";
}

/**
 * Compact record count for the plain-language summary line ("2.06M", "28.4K").
 * Below 10,000 the full grouped integer still reads cleanly, so only larger
 * counts collapse to a K/M/B magnitude — keeping the sentence terse without
 * hiding small datasets behind a rounded "0.0K".
 */
function formatCompactInteger(n: number): string {
  if (!Number.isFinite(n) || n < 10_000) {
    return formatInteger(n);
  }
  const units: Array<{ suffix: string; divisor: number }> = [
    { suffix: "B", divisor: 1_000_000_000 },
    { suffix: "M", divisor: 1_000_000 },
    { suffix: "K", divisor: 1000 },
  ];
  for (const { suffix, divisor } of units) {
    if (n >= divisor) {
      const scaled = n / divisor;
      const rounded = scaled >= 100 ? Math.round(scaled).toString() : scaled.toFixed(scaled >= 10 ? 1 : 2);
      return `${rounded}${suffix}`;
    }
  }
  return formatInteger(n);
}

/**
 * Decimal byte formatter (MB = 1,000,000 bytes) matching Stripe/Vercel/Plaid
 * conventions and consumer intuition about "184 MB". Scales up through GB, TB.
 * Returns the magnitude and the unit separately so the metric strip can render
 * the figure in tabular-nums and the unit as a muted context line.
 */
function splitBytes(bytes: number): { value: string; unit: string } {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return { value: "0", unit: "B" };
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
  return { value: String(rounded), unit: units[unitIndex] ?? "B" };
}

/**
 * Share-of-total percentage for the distribution rows. Sub-1% shares round to
 * "<1%" rather than "0%" so a small-but-present connector never reads as empty.
 */
function formatShare(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) {
    return "0%";
  }
  if (percent < 1) {
    return "<1%";
  }
  return `${Math.round(percent)}%`;
}
