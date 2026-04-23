import Link from 'next/link';
import type { DatasetSummary } from '../lib/ref-client';
import { Timestamp } from '@/components/ui/timestamp';

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
export function OverviewHero({ summary }: { summary: DatasetSummary }) {
  if (summary.record_count === 0) {
    return <EmptyHero />;
  }

  return (
    <section className="mb-8" aria-label="Dataset overview">
      <p className="pdpp-heading text-foreground font-semibold tabular-nums">
        <span>{formatBytes(summary.total_retained_bytes)}</span>
        <span className="text-muted-foreground font-normal"> across </span>
        <span>{formatInteger(summary.record_count)}</span>
        <span className="text-muted-foreground font-normal"> records from </span>
        <span>{formatInteger(summary.connector_count)}</span>
        <span className="text-muted-foreground font-normal">
          {summary.connector_count === 1 ? ' connector' : ' connectors'}
        </span>
        {summary.earliest_record_time ? (
          <>
            <span className="text-muted-foreground font-normal"> · since </span>
            <Timestamp value={summary.earliest_record_time} precision="date" mode="absolute" className="font-medium" />
          </>
        ) : null}
      </p>

      <BreadthRow
        connectors={summary.top_connectors}
        totalConnectors={summary.connector_count}
      />

      <p className="pdpp-body text-muted-foreground mt-3">
        Each approved grant issues runs that write records into streams —{' '}
        <Link
          href="/dashboard/records"
          className="text-muted-foreground decoration-muted-foreground/50 underline-offset-2 hover:text-foreground hover:underline"
        >
          every record is inspectable
        </Link>{' '}
        through <code className="pdpp-caption font-mono">/v1/streams</code>.
      </p>
    </section>
  );
}

function EmptyHero() {
  return (
    <section className="mb-8" aria-label="Dataset overview">
      <p className="pdpp-heading text-foreground font-semibold">
        <span>No records yet</span>
        <span className="text-muted-foreground font-normal"> · 0 connectors connected</span>
      </p>
      <p className="pdpp-body text-muted-foreground mt-3">
        Start a grant to begin ingesting. Every record lands inspectable through{' '}
        <code className="pdpp-caption font-mono">/v1/streams</code>.
      </p>
    </section>
  );
}

function BreadthRow({
  connectors,
  totalConnectors,
}: {
  connectors: DatasetSummary['top_connectors'];
  totalConnectors: number;
}) {
  if (connectors.length === 0) return null;
  const extra = Math.max(totalConnectors - connectors.length, 0);
  return (
    <p className="pdpp-body text-muted-foreground mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
      {connectors.map((c, i) => (
        <span key={c.connector_id} className="inline-flex items-baseline gap-1.5">
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: identityColor(i) }}
          />
          <code className="pdpp-caption text-foreground font-mono" title={c.connector_id}>
            {displayConnectorSlug(c.connector_id)}
          </code>
          <span className="tabular-nums">{formatInteger(c.record_count)}</span>
        </span>
      ))}
      {extra > 0 ? (
        <Link
          href="/dashboard/records"
          className="text-muted-foreground hover:text-foreground hover:underline underline-offset-2"
        >
          +{extra} more
        </Link>
      ) : null}
    </p>
  );
}

// Deterministic low-saturation identity colors for the top-connectors row.
// These are small decorative dots only; no meaning is carried by specific hue.
function identityColor(index: number): string {
  const palette = [
    'oklch(0.72 0.12 65)',
    'oklch(0.70 0.11 155)',
    'oklch(0.68 0.13 240)',
    'oklch(0.70 0.11 320)',
    'oklch(0.72 0.10 25)',
  ];
  return palette[index % palette.length];
}

function formatInteger(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '0';
}

/**
 * Shorten a connector_id for compact display in the breadth row. PDPP
 * connector_ids are often URLs like
 * `https://registry.pdpp.org/connectors/slack`; displaying the full URL
 * swallows the row. Fall through to the raw id for non-URL connector ids.
 */
function displayConnectorSlug(connectorId: string): string {
  try {
    const url = new URL(connectorId);
    const segments = url.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    return last || url.hostname;
  } catch {
    return connectorId;
  }
}


/**
 * Decimal byte formatter (MB = 1,000,000 bytes) matching Stripe/Vercel/Plaid
 * conventions and consumer intuition about "184 MB". Scales up through GB, TB.
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  const rounded = value >= 100 ? Math.round(value) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${rounded} ${units[unitIndex]}`;
}
