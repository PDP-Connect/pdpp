/**
 * Shared paginated record-table view (records list inside a stream).
 * Used by /dashboard/records/[connector]/[stream] and the sandbox
 * equivalent.
 *
 * The page resolves cursor/columns search params, fetches the
 * RecordsPage via its data source, looks up the stream manifest, and
 * passes everything in. The view computes columns and renders the
 * mobile/desktop table.
 */

import { PageHeader, Pager } from "@pdpp/operator-ui/components/primitives";
import type { Routes } from "@pdpp/operator-ui/components/views/routes";
import { formatConnectorKeyForDisplay } from "@pdpp/operator-ui/lib/connector-display";
import Link from "next/link";
import { Fragment } from "react";
import { buttonVariants } from "@/components/ui/button.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import {
  computeDefaultColumns,
  deriveAllColumns,
  type RecordsPage,
  resolveSelectedColumns,
  type StreamManifest,
  type StreamRecord,
  stringifyCell,
  truncate,
} from "../../lib/rs-client.ts";
import { ColumnsMenu } from "../../records/[connector]/[stream]/columns-menu.tsx";

const TH = "pdpp-eyebrow border-border/70 border-b px-3 py-2 text-left text-muted-foreground";
const TD = "pdpp-caption border-border/70 border-b px-3 py-2";

export function StreamRecordsView({
  connectorId,
  streamName,
  page,
  streamManifest,
  trail,
  columnsParam,
  routes,
  showHealthLink,
}: {
  connectorId: string;
  streamName: string;
  page: RecordsPage;
  streamManifest: StreamManifest | null;
  trail: string[];
  columnsParam?: string;
  routes: Routes;
  /** Live dashboard exposes a "Stream health" deep dive; sandbox does not. */
  showHealthLink: boolean;
}) {
  const allColumns = deriveAllColumns(page.data);
  const defaultColumns = computeDefaultColumns(page.data, streamManifest);
  const { columns, mode } = resolveSelectedColumns(columnsParam, allColumns, defaultColumns);
  const streamPath = routes.stream(connectorId, streamName);
  const hrefFor = (next: string[]): string => {
    const parts: string[] = [];
    if (next.length) {
      parts.push(`cursors=${next.join(",")}`);
    }
    if (columnsParam) {
      parts.push(`columns=${encodeURIComponent(columnsParam)}`);
    }
    return parts.length ? `${streamPath}?${parts.join("&")}` : streamPath;
  };
  const prevHref = trail.length ? hrefFor(trail.slice(0, -1)) : null;
  const nextHref = page.next_cursor ? hrefFor([...trail, page.next_cursor]) : null;
  const recordHref = (id: string) => routes.record(connectorId, streamName, id);
  const connectorLabel = formatConnectorKeyForDisplay(connectorId);

  return (
    <>
      <PageHeader
        actions={
          <>
            {allColumns.length > 0 ? (
              <ColumnsMenu
                allColumns={allColumns}
                defaultColumns={defaultColumns}
                mode={mode}
                selectedColumns={columns}
              />
            ) : null}
            {showHealthLink ? (
              <Link
                className={buttonVariants({ variant: "outline", size: "sm" })}
                href={routes.streamHealth(connectorId, streamName)}
              >
                Stream health →
              </Link>
            ) : null}
          </>
        }
        breadcrumbs={[
          { label: "Connections", href: routes.section.records },
          { label: connectorLabel, href: routes.connector(connectorId) },
          { label: streamName },
        ]}
        count={`page ${trail.length + 1} · ${page.data.length} records`}
        title={<code className="font-mono">{streamName}</code>}
      />

      {page.data.length === 0 ? (
        <p className="pdpp-caption text-muted-foreground italic">No records.</p>
      ) : (
        <>
          <ul className="divide-y divide-border/70 border-border/70 border-y sm:hidden">
            {page.data.map((r) => (
              <li key={r.id}>
                <Link className="block px-3 py-3 hover:bg-muted/40" href={recordHref(r.id)}>
                  <RecordCard columns={columns} record={r} />
                </Link>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto rounded-md border border-border/70 sm:block">
            <table className="min-w-full">
              <thead className="bg-muted/40">
                <tr>
                  <th className={TH}>emitted_at</th>
                  <th className={TH}>id</th>
                  {columns.map((c) => (
                    <th className={TH} key={c}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.data.map((r) => (
                  <tr className="transition-colors hover:bg-muted/30" key={r.id}>
                    <td className={`${TD} whitespace-nowrap text-muted-foreground`}>
                      <Link className="block" href={recordHref(r.id)}>
                        <Timestamp value={r.emitted_at} />
                      </Link>
                    </td>
                    <td className={`${TD} whitespace-nowrap`}>
                      <Link
                        className="block font-mono text-foreground underline-offset-2 hover:underline"
                        href={recordHref(r.id)}
                      >
                        {truncate(r.id, 32)}
                      </Link>
                    </td>
                    {columns.map((c) => (
                      <td className={`${TD} align-top`} key={c}>
                        <Link className="block" href={recordHref(r.id)}>
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

      <Pager next={nextHref} prev={prevHref} />
    </>
  );
}

function RecordCard({ record, columns }: { record: StreamRecord; columns: string[] }) {
  return (
    <dl className="pdpp-caption grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      <dt className="text-muted-foreground">emitted_at</dt>
      <dd className="break-all text-muted-foreground">
        <Timestamp value={record.emitted_at} />
      </dd>
      <dt className="text-muted-foreground">id</dt>
      <dd className="break-all font-mono">{truncate(record.id, 48)}</dd>
      {columns.map((c) => {
        const v = stringifyCell(record.data?.[c]);
        if (!v) {
          return null;
        }
        return (
          <Fragment key={c}>
            <dt className="truncate text-muted-foreground">{c}</dt>
            <dd className="break-words">{truncate(v, 120)}</dd>
          </Fragment>
        );
      })}
    </dl>
  );
}
