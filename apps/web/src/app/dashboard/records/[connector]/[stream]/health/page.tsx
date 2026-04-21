import { Fragment } from 'react';
import Link from 'next/link';
import { DashboardShell, ServerUnreachable } from '../../../../components/shell';
import { streamHealth, type FieldHealth, type StreamHealth } from '../../../../lib/rs-client';
import { ReferenceServerUnreachableError } from '../../../../lib/owner-token';

export const dynamic = 'force-dynamic';

const DEFAULT_SAMPLE = 2000;
const MAX_SAMPLE = 20000;

const TH = 'border-border border-b px-3 py-2 text-left font-semibold';
const TD = 'border-border border-b px-3 py-2 align-top';

export default async function StreamHealthPage({
  params,
  searchParams,
}: {
  params: Promise<{ connector: string; stream: string }>;
  searchParams: Promise<{ sample?: string }>;
}) {
  const { connector, stream } = await params;
  const { sample } = await searchParams;
  const connectorId = decodeURIComponent(connector);
  const streamName = decodeURIComponent(stream);
  const streamPath = `/dashboard/records/${encodeURIComponent(connectorId)}/${encodeURIComponent(streamName)}`;

  const parsedSample = Number.parseInt(sample ?? '', 10);
  const sampleSize = Number.isFinite(parsedSample) && parsedSample > 0
    ? Math.min(parsedSample, MAX_SAMPLE)
    : DEFAULT_SAMPLE;

  let health: StreamHealth;
  try {
    health = await streamHealth(connectorId, streamName, { sampleSize });
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="records">
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  const { fields, summary, emittedAt, cursorField, cursorRange } = health;

  return (
    <DashboardShell active="records">
      <nav className="text-muted-foreground mb-3 flex flex-wrap items-center gap-x-2 text-xs">
        <Link href="/dashboard/records" className="hover:text-foreground">records</Link>
        <span>/</span>
        <Link href={`/dashboard/records/${encodeURIComponent(connectorId)}`} className="hover:text-foreground break-all">
          {connectorId}
        </Link>
        <span>/</span>
        <Link href={streamPath} className="hover:text-foreground break-all">{streamName}</Link>
        <span>/</span>
        <span className="text-foreground">health</span>
      </nav>

      <header className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <h1 className="text-lg font-semibold break-all">
          {streamName} <span className="text-muted-foreground">· health</span>
        </h1>
        <span className="text-muted-foreground">
          sample {health.sampled.toLocaleString()} / {health.totalRecords.toLocaleString()} records
          {health.limited ? ' · sample-based' : ''}
        </span>
      </header>

      {/* Summary strip */}
      <section className="border-border bg-muted/20 mb-4 rounded border px-3 py-2">
        <p className="break-words">
          <span className="tabular-nums">{summary.declared}</span> fields declared ·{' '}
          <span className="tabular-nums">{summary.present}</span> present ·{' '}
          <span className={summary.entirelyNull > 0 ? 'text-amber-600 dark:text-amber-400 tabular-nums' : 'tabular-nums'}>
            {summary.entirelyNull}
          </span>{' '}
          entirely null ·{' '}
          <span className="tabular-nums">{summary.constValued}</span> const-valued
          {summary.declaredButAbsent > 0 && (
            <>
              {' · '}
              <span className="text-amber-600 dark:text-amber-400 tabular-nums">
                {summary.declaredButAbsent}
              </span>{' '}
              declared-but-absent
            </>
          )}
          {summary.undeclaredPresent > 0 && (
            <>
              {' · '}
              <span className="text-amber-600 dark:text-amber-400 tabular-nums">
                {summary.undeclaredPresent}
              </span>{' '}
              undeclared-but-present
            </>
          )}
        </p>
        {health.limited && (
          <p className="text-muted-foreground mt-1">
            Sample limited to {health.sampleLimit.toLocaleString()} records; results are not authoritative for the full{' '}
            {health.totalRecords.toLocaleString()}-record stream. Raise via{' '}
            <code className="bg-muted rounded px-1">?sample=N</code> (max {MAX_SAMPLE.toLocaleString()}).
          </p>
        )}
      </section>

      {/* Freshness */}
      <section className="mb-6">
        <h2 className="text-muted-foreground mb-2 text-xs uppercase tracking-wide">freshness</h2>
        <div className="border-border overflow-x-auto rounded border">
          <table className="min-w-full">
            <thead className="bg-muted/50">
              <tr>
                <th className={TH}>field</th>
                <th className={TH}>min</th>
                <th className={TH}>max</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className={TD}>emitted_at</td>
                <td className={`${TD} whitespace-nowrap`}>{emittedAt.min ?? <Dash />}</td>
                <td className={`${TD} whitespace-nowrap`}>{emittedAt.max ?? <Dash />}</td>
              </tr>
              {cursorField && (
                <tr>
                  <td className={TD}>
                    {cursorField} <span className="text-muted-foreground">(cursor)</span>
                  </td>
                  <td className={`${TD} whitespace-nowrap`}>{cursorRange?.min ?? <Dash />}</td>
                  <td className={`${TD} whitespace-nowrap`}>{cursorRange?.max ?? <Dash />}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {!cursorField && (
          <p className="text-muted-foreground mt-1">Manifest declares no cursor_field for this stream.</p>
        )}
      </section>

      {/* Fields */}
      <section>
        <h2 className="text-muted-foreground mb-2 text-xs uppercase tracking-wide">
          fields ({fields.length})
        </h2>
        {fields.length === 0 ? (
          <p className="text-muted-foreground">No fields in manifest or sample.</p>
        ) : (
          <>
            {/* Mobile */}
            <ul className="divide-border divide-y border-y sm:hidden">
              {fields.map((f) => (
                <li key={f.name} className={`px-2 py-3 ${rowBg(f)}`}>
                  <FieldCard field={f} sampled={health.sampled} />
                </li>
              ))}
            </ul>

            {/* Desktop */}
            <div className="border-border hidden overflow-x-auto rounded border sm:block">
              <table className="min-w-full">
                <thead className="bg-muted/50">
                  <tr>
                    <th className={TH}>field</th>
                    <th className={TH}>declared</th>
                    <th className={TH}>present</th>
                    <th className={TH}>null %</th>
                    <th className={TH}>distinct</th>
                    <th className={TH}>example</th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((f) => (
                    <tr key={f.name} className={rowBg(f)}>
                      <td className={`${TD} whitespace-nowrap`}>
                        <span className="font-medium break-all">{f.name}</span>
                        {flagLabels(f).map((lbl) => (
                          <Fragment key={lbl}>
                            {' '}
                            <span className="text-amber-600 dark:text-amber-400">{lbl}</span>
                          </Fragment>
                        ))}
                      </td>
                      <td className={TD}>{f.declared ? 'yes' : <span className="text-muted-foreground">no</span>}</td>
                      <td className={TD}>{f.present ? 'yes' : <span className="text-muted-foreground">no</span>}</td>
                      <td className={`${TD} tabular-nums whitespace-nowrap`}>
                        {nullPct(f, health.sampled)}
                      </td>
                      <td className={`${TD} tabular-nums whitespace-nowrap`}>
                        {f.distinctValues}
                        {f.distinctCapped ? '+' : ''}
                      </td>
                      <td className={`${TD} text-muted-foreground`}>
                        <span className="block max-w-[24rem] truncate" title={f.sampleValue ?? ''}>
                          {f.sampleValue ?? ''}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </DashboardShell>
  );
}

function Dash() {
  return <span className="text-muted-foreground">—</span>;
}

function nullPct(f: FieldHealth, sampled: number): string {
  if (sampled === 0) return '—';
  const total = f.nullCount + f.nonNullCount;
  if (total === 0) return '—';
  const pct = (f.nullCount / total) * 100;
  return `${pct.toFixed(pct === 100 || pct === 0 ? 0 : 1)}%`;
}

function flagLabels(f: FieldHealth): string[] {
  const flags: string[] = [];
  if (f.declared && !f.present) flags.push('[absent]');
  if (!f.declared && f.present) flags.push('[undeclared]');
  if (f.present && f.nonNullCount === 0) flags.push('[all-null]');
  if (f.nonNullCount > 0 && f.distinctValues === 1) flags.push('[const]');
  return flags;
}

function rowBg(f: FieldHealth): string {
  const flagged =
    (f.declared && !f.present) ||
    (!f.declared && f.present) ||
    (f.present && f.nonNullCount === 0) ||
    (f.nonNullCount > 0 && f.distinctValues === 1);
  return flagged ? 'bg-amber-500/5' : '';
}

function FieldCard({ field: f, sampled }: { field: FieldHealth; sampled: number }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      <dt className="text-muted-foreground">field</dt>
      <dd className="break-all">
        <span className="font-medium">{f.name}</span>
        {flagLabels(f).map((lbl) => (
          <Fragment key={lbl}>
            {' '}
            <span className="text-amber-600 dark:text-amber-400">{lbl}</span>
          </Fragment>
        ))}
      </dd>
      <dt className="text-muted-foreground">declared</dt>
      <dd>{f.declared ? 'yes' : 'no'}</dd>
      <dt className="text-muted-foreground">present</dt>
      <dd>{f.present ? 'yes' : 'no'}</dd>
      <dt className="text-muted-foreground">null %</dt>
      <dd className="tabular-nums">{nullPct(f, sampled)}</dd>
      <dt className="text-muted-foreground">distinct</dt>
      <dd className="tabular-nums">
        {f.distinctValues}
        {f.distinctCapped ? '+' : ''}
      </dd>
      {f.sampleValue && (
        <>
          <dt className="text-muted-foreground">example</dt>
          <dd className="text-muted-foreground break-words">{f.sampleValue}</dd>
        </>
      )}
    </dl>
  );
}
