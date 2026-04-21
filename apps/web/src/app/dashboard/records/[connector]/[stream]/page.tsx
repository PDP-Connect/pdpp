import { Fragment } from 'react';
import Link from 'next/link';
import { DashboardShell, ServerUnreachable } from '../../../components/shell';
import {
  deriveColumns,
  queryRecords,
  stringifyCell,
  truncate,
  type RecordsPage,
  type StreamRecord,
} from '../../../lib/rs-client';
import { ReferenceServerUnreachableError } from '../../../lib/owner-token';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;
const TH = 'border-border border-b px-3 py-2 font-semibold';
const TD = 'border-border border-b px-3 py-2';

export default async function StreamPage({
  params,
  searchParams,
}: {
  params: Promise<{ connector: string; stream: string }>;
  searchParams: Promise<{ cursors?: string }>;
}) {
  const { connector, stream } = await params;
  const { cursors: cursorsParam } = await searchParams;
  const connectorId = decodeURIComponent(connector);
  const streamName = decodeURIComponent(stream);

  const trail = cursorsParam ? cursorsParam.split(',').filter(Boolean) : [];
  const streamPath = `/dashboard/records/${encodeURIComponent(connectorId)}/${encodeURIComponent(streamName)}`;

  let page: RecordsPage;
  try {
    page = await queryRecords(connectorId, streamName, {
      limit: PAGE_SIZE,
      cursor: trail[trail.length - 1],
    });
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

  const columns = deriveColumns(page.data);
  const prevHref = trail.length ? hrefFor(streamPath, trail.slice(0, -1)) : null;
  const nextHref = page.next_cursor ? hrefFor(streamPath, [...trail, page.next_cursor]) : null;
  const recordHref = (id: string) => `${streamPath}/${encodeURIComponent(id)}`;

  return (
    <DashboardShell active="records">
      <nav className="text-muted-foreground mb-3 flex flex-wrap items-center gap-x-2 text-xs">
        <Link href="/dashboard/records" className="hover:text-foreground">records</Link>
        <span>/</span>
        <Link href={`/dashboard/records/${encodeURIComponent(connectorId)}`} className="hover:text-foreground break-all">{connectorId}</Link>
        <span>/</span>
        <span className="text-foreground break-all">{streamName}</span>
      </nav>
      <header className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <h1 className="text-lg font-semibold break-all">{streamName}</h1>
        <span className="text-muted-foreground flex items-center gap-3 text-xs">
          <Link href={`${streamPath}/health`} className="hover:text-foreground underline-offset-2 hover:underline">
            health →
          </Link>
          <span>page {trail.length + 1} · {page.data.length} records</span>
        </span>
      </header>
      {page.data.length === 0 ? (
        <p className="text-muted-foreground text-xs">No records.</p>
      ) : (
        <>
          {/* Mobile */}
          <ul className="divide-border divide-y border-y sm:hidden">
            {page.data.map((r) => (
              <li key={r.id}>
                <Link href={recordHref(r.id)} className="hover:bg-muted/50 block px-2 py-3">
                  <RecordCard record={r} columns={columns} />
                </Link>
              </li>
            ))}
          </ul>

          {/* Desktop */}
          <div className="border-border hidden overflow-x-auto rounded border sm:block">
            <table className="min-w-full text-xs">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className={TH}>emitted_at</th>
                  <th className={TH}>id</th>
                  {columns.map((c) => (
                    <th key={c} className={TH}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.data.map((r) => (
                  <tr key={r.id} className="hover:bg-muted/30">
                    <td className={`${TD} text-muted-foreground whitespace-nowrap`}>
                      <Link href={recordHref(r.id)} className="block">{r.emitted_at}</Link>
                    </td>
                    <td className={`${TD} whitespace-nowrap`}>
                      <Link href={recordHref(r.id)} className="text-foreground hover:text-foreground block underline-offset-2 hover:underline">
                        {truncate(r.id, 32)}
                      </Link>
                    </td>
                    {columns.map((c) => (
                      <td key={c} className={`${TD} align-top`}>
                        <Link href={recordHref(r.id)} className="block">
                          <span className="block max-w-[24rem] truncate" title={stringifyCell(r.data?.[c])}>
                            {stringifyCell(r.data?.[c])}
                          </span>
                        </Link>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <nav className="mt-4 flex items-center justify-between text-xs">
        <PagerLink href={prevHref} label="← prev" />
        <PagerLink href={nextHref} label="next →" />
      </nav>
    </DashboardShell>
  );
}

function RecordCard({ record, columns }: { record: StreamRecord; columns: string[] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      <dt className="text-muted-foreground">emitted_at</dt>
      <dd className="text-muted-foreground break-all">{record.emitted_at}</dd>
      <dt className="text-muted-foreground">id</dt>
      <dd className="break-all">{truncate(record.id, 48)}</dd>
      {columns.map((c) => {
        const v = stringifyCell(record.data?.[c]);
        if (!v) return null;
        return (
          <Fragment key={c}>
            <dt className="text-muted-foreground truncate">{c}</dt>
            <dd className="break-words">{truncate(v, 120)}</dd>
          </Fragment>
        );
      })}
    </dl>
  );
}

function hrefFor(base: string, trail: string[]): string {
  return trail.length ? `${base}?cursors=${trail.join(',')}` : base;
}

function PagerLink({ href, label }: { href: string | null; label: string }) {
  if (!href) return <span className="text-muted-foreground/50">{label}</span>;
  return (
    <Link href={href} className="hover:text-foreground text-muted-foreground">
      {label}
    </Link>
  );
}
