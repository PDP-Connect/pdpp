import { Fragment } from 'react';
import Link from 'next/link';
import { DashboardShell, OwnerTokenRequired, ServerUnreachable } from '../../../components/shell';
import { buttonVariants } from '@/components/ui/button';
import {
  PageHeader,
  Pager,
} from '../../../components/primitives';
import {
  computeDefaultColumns,
  deriveAllColumns,
  listConnectorManifests,
  queryRecords,
  resolveSelectedColumns,
  stringifyCell,
  truncate,
  type RecordsPage,
  type StreamManifest,
  type StreamRecord,
} from '../../../lib/rs-client';
import { ReferenceServerUnreachableError } from '../../../lib/owner-token';
import { ColumnsMenu } from './columns-menu';
import { Timestamp } from '@/components/ui/timestamp';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;
const TH = 'pdpp-eyebrow border-border/70 border-b px-3 py-2 text-left text-muted-foreground';
const TD = 'pdpp-caption border-border/70 border-b px-3 py-2';

export default async function StreamPage({
  params,
  searchParams,
}: {
  params: Promise<{ connector: string; stream: string }>;
  searchParams: Promise<{ cursors?: string; columns?: string }>;
}) {
  const { connector, stream } = await params;
  const { cursors: cursorsParam, columns: columnsParam } = await searchParams;
  const connectorId = decodeURIComponent(connector);
  const streamName = decodeURIComponent(stream);

  const trail = cursorsParam ? cursorsParam.split(',').filter(Boolean) : [];
  const streamPath = `/dashboard/records/${encodeURIComponent(connectorId)}/${encodeURIComponent(streamName)}`;

  let page: RecordsPage;
  let streamManifest: StreamManifest | null = null;
  try {
    const [pageResult, manifests] = await Promise.all([
      queryRecords(connectorId, streamName, {
        limit: PAGE_SIZE,
        cursor: trail[trail.length - 1],
      }),
      listConnectorManifests().catch(() => []),
    ]);
    page = pageResult;
    const connectorManifest = manifests.find((m) => m.connector_id === connectorId);
    const maybeStream = connectorManifest?.streams?.find((s: { name: string }) => s.name === streamName);
    streamManifest = (maybeStream ?? null) as StreamManifest | null;
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="records">
          <PageHeader title="Records" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  const allColumns = deriveAllColumns(page.data);
  const defaultColumns = computeDefaultColumns(page.data, streamManifest);
  const { columns, mode } = resolveSelectedColumns(columnsParam, allColumns, defaultColumns);
  const prevHref = trail.length ? hrefFor(streamPath, trail.slice(0, -1), columnsParam) : null;
  const nextHref = page.next_cursor
    ? hrefFor(streamPath, [...trail, page.next_cursor], columnsParam)
    : null;
  const recordHref = (id: string) => `${streamPath}/${encodeURIComponent(id)}`;

  return (
    <DashboardShell active="records">
      <PageHeader
        title={<code className="font-mono">{streamName}</code>}
        breadcrumbs={[
          { label: 'Records', href: '/dashboard/records' },
          { label: connectorId, href: `/dashboard/records/${encodeURIComponent(connectorId)}` },
          { label: streamName },
        ]}
        count={`page ${trail.length + 1} · ${page.data.length} records`}
        actions={
          <>
            {allColumns.length > 0 && (
              <ColumnsMenu
                allColumns={allColumns}
                defaultColumns={defaultColumns}
                selectedColumns={columns}
                mode={mode}
              />
            )}
            <Link href={`${streamPath}/health`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              Stream health →
            </Link>
          </>
        }
      />

      {page.data.length === 0 ? (
        <p className="pdpp-caption text-muted-foreground italic">No records.</p>
      ) : (
        <>
          {/* Mobile list */}
          <ul className="divide-border/70 divide-y border-y border-border/70 sm:hidden">
            {page.data.map((r) => (
              <li key={r.id}>
                <Link href={recordHref(r.id)} className="hover:bg-muted/40 block px-3 py-3">
                  <RecordCard record={r} columns={columns} />
                </Link>
              </li>
            ))}
          </ul>

          {/* Desktop table */}
          <div className="border-border/70 hidden overflow-x-auto rounded-md border sm:block">
            <table className="min-w-full">
              <thead className="bg-muted/40">
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
                  <tr key={r.id} className="hover:bg-muted/30 transition-colors">
                    <td className={`${TD} text-muted-foreground whitespace-nowrap`}>
                      <Link href={recordHref(r.id)} className="block">
                        <Timestamp value={r.emitted_at} />
                      </Link>
                    </td>
                    <td className={`${TD} whitespace-nowrap`}>
                      <Link
                        href={recordHref(r.id)}
                        className="text-foreground block font-mono underline-offset-2 hover:underline"
                      >
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

      <Pager prev={prevHref} next={nextHref} />
    </DashboardShell>
  );
}

function RecordCard({ record, columns }: { record: StreamRecord; columns: string[] }) {
  return (
    <dl className="pdpp-caption grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      <dt className="text-muted-foreground">emitted_at</dt>
      <dd className="text-muted-foreground break-all">
        <Timestamp value={record.emitted_at} />
      </dd>
      <dt className="text-muted-foreground">id</dt>
      <dd className="break-all font-mono">{truncate(record.id, 48)}</dd>
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

function hrefFor(base: string, trail: string[], columnsParam?: string): string {
  const parts: string[] = [];
  if (trail.length) parts.push(`cursors=${trail.join(',')}`);
  if (columnsParam) parts.push(`columns=${encodeURIComponent(columnsParam)}`);
  return parts.length ? `${base}?${parts.join('&')}` : base;
}
