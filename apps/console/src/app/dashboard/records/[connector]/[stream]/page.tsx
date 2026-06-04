import { PageHeader, Pager } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { buttonVariants } from "@/components/ui/button.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { DashboardShell, ServerUnreachable } from "../../../components/shell.tsx";
import { WarningsBanner } from "../../../components/warnings-banner.tsx";
import { ReferenceServerUnreachableError, ResourceServerHttpError } from "../../../lib/owner-token.ts";
import {
  computeDefaultColumns,
  deriveAllColumns,
  type ExpandCapability,
  listConnectorManifests,
  queryRecords,
  type RecordsPage,
  resolveSelectedColumns,
  type StreamManifest,
  type StreamRecord,
  stringifyCell,
  truncate,
} from "../../../lib/rs-client.ts";
import { connectorInstanceIdForConnection, resolveConnectionForRecordsRoute } from "../../connection-route.ts";
import { findParentBackLink, parentRelationsForChild } from "../../lib/relationships.ts";
import { ColumnsMenu } from "./columns-menu.tsx";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const TH = "pdpp-eyebrow border-border/70 border-b px-3 py-2 text-left text-muted-foreground";
const TD = "pdpp-caption border-border/70 border-b px-3 py-2";

const FILTER_PARAM_RE = /^filter\[(.+)\]$/;

// Extract `filter[field]=value` pairs from the raw search params. Relationship
// navigation links a parent record to its children via
// `?filter[<child_parent_key_field>]=<parent key>`; this is the receiving end.
function readExactFilters(searchParams: Record<string, string | string[] | undefined>): Record<string, string> {
  const filters: Record<string, string> = {};
  for (const [key, value] of Object.entries(searchParams)) {
    const match = FILTER_PARAM_RE.exec(key);
    if (!match) {
      continue;
    }
    const field = match[1];
    const raw = Array.isArray(value) ? value[0] : value;
    if (field && typeof raw === "string" && raw.length > 0) {
      filters[field] = raw;
    }
  }
  return filters;
}

export default async function StreamPage({
  params,
  searchParams,
}: {
  params: Promise<{ connector: string; stream: string }>;
  searchParams: Promise<{ cursors?: string; columns?: string } & Record<string, string | string[] | undefined>>;
}) {
  const { connector, stream } = await params;
  const resolvedSearchParams = await searchParams;
  const { cursors: cursorsParam, columns: columnsParam } = resolvedSearchParams;
  const exactFilters = readExactFilters(resolvedSearchParams);
  const routeId = decodeURIComponent(connector);
  const streamName = decodeURIComponent(stream);

  const trail = cursorsParam ? cursorsParam.split(",").filter(Boolean) : [];
  let connectorId = routeId;
  let connectionId = routeId;
  let connectorInstanceId: string | null = null;

  let page: RecordsPage;
  let streamManifest: StreamManifest | null = null;
  let parentRelations: Array<{ parentStream: string; capability: ExpandCapability }> = [];
  try {
    const connection = await resolveConnectionForRecordsRoute(routeId);
    if (!connection) {
      notFound();
    }
    connectorId = connection.connector_id;
    connectionId = connection.connection_id;
    connectorInstanceId = connectorInstanceIdForConnection(connection);
    const [pageResult, manifests] = await Promise.all([
      queryRecords(connectorId, streamName, {
        connectorInstanceId,
        limit: PAGE_SIZE,
        cursor: trail.at(-1),
        ...(Object.keys(exactFilters).length > 0 ? { filter: exactFilters } : {}),
      }),
      listConnectorManifests().catch(() => []),
    ]);
    page = pageResult;
    const connectorManifest = manifests.find((m) => m.connector_id === connectorId);
    const maybeStream = connectorManifest?.streams?.find((s: { name: string }) => s.name === streamName);
    streamManifest = (maybeStream ?? null) as StreamManifest | null;
    // Declared forward relations pointing AT this stream let a child-record field
    // link back to its parent (manifest-declared only, never payload-guessed).
    parentRelations = parentRelationsForChild(connectorManifest?.streams, streamName);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="records">
          <PageHeader title="Connections" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    if (err instanceof ResourceServerHttpError && (err.status === 404 || err.status === 410)) {
      // Stream is not (or no longer) advertised by this connector's manifest.
      // Owner-mode stream visibility is manifest-derived; once a stream is
      // dropped from the manifest, records-read returns 404. Render a bounded
      // honest state instead of crashing to the segment error boundary.
      return (
        <DashboardShell active="records">
          <PageHeader
            breadcrumbs={[
              { label: "Connections", href: "/dashboard/records" },
              { label: connectionId, href: `/dashboard/records/${encodeURIComponent(connectionId)}` },
              { label: streamName },
            ]}
            title={<code className="font-mono">{streamName}</code>}
          />
          <div className="rounded-md border border-border/70 bg-muted/30 p-4">
            <p className="pdpp-caption text-foreground">
              This stream is not available for <code className="font-mono">{connectionId}</code>.
            </p>
            <p className="pdpp-caption mt-2 text-muted-foreground">
              The connector no longer advertises a stream named <code className="font-mono">{streamName}</code>. It may
              have been renamed or retired in a newer manifest, or the stream list is showing a stale entry that has not
              yet been reconciled. Return to{" "}
              <Link
                className="underline underline-offset-2"
                href={`/dashboard/records/${encodeURIComponent(connectionId)}`}
              >
                the connection page
              </Link>{" "}
              to see currently available streams.
            </p>
          </div>
        </DashboardShell>
      );
    }
    throw err;
  }

  const allColumns = deriveAllColumns(page.data);
  const defaultColumns = computeDefaultColumns(page.data, streamManifest);
  const { columns, mode } = resolveSelectedColumns(columnsParam, allColumns, defaultColumns);
  const streamPath = `/dashboard/records/${encodeURIComponent(connectionId)}/${encodeURIComponent(streamName)}`;
  const prevHref = trail.length ? hrefFor(streamPath, trail.slice(0, -1), columnsParam) : null;
  const nextHref = page.next_cursor ? hrefFor(streamPath, [...trail, page.next_cursor], columnsParam) : null;
  const recordHref = (id: string) => `${streamPath}/${encodeURIComponent(id)}`;

  // Fields on this (child) stream that link back to a parent record. The set of
  // linkable fields comes only from declared forward relations; a field that
  // merely looks like a foreign key is never linked.
  const parentLinkFields = new Set(
    parentRelations
      .map(({ capability }) => capability.child_parent_key_field ?? capability.foreign_key)
      .filter((field): field is string => typeof field === "string")
  );
  const parentLinkForCell = (record: StreamRecord, column: string) =>
    parentLinkFields.has(column)
      ? findParentBackLink(streamName, record.data, parentRelations, { connectionId })
      : null;

  return (
    <DashboardShell active="records">
      <PageHeader
        actions={
          <>
            {allColumns.length > 0 && (
              <ColumnsMenu
                allColumns={allColumns}
                defaultColumns={defaultColumns}
                mode={mode}
                selectedColumns={columns}
              />
            )}
            <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={`${streamPath}/health`}>
              Stream health →
            </Link>
          </>
        }
        breadcrumbs={[
          { label: "Connections", href: "/dashboard/records" },
          { label: connectionId, href: `/dashboard/records/${encodeURIComponent(connectionId)}` },
          { label: streamName },
        ]}
        count={`page ${trail.length + 1} · ${page.data.length} records`}
        title={<code className="font-mono">{streamName}</code>}
      />

      <WarningsBanner warnings={page.warnings} />

      {page.data.length === 0 ? (
        <p className="pdpp-caption text-muted-foreground italic">No records.</p>
      ) : (
        <>
          {/* Mobile list */}
          <ul className="divide-y divide-border/70 border-border/70 border-y sm:hidden">
            {page.data.map((r) => (
              <li key={r.id}>
                <Link className="block px-3 py-3 hover:bg-muted/40" href={recordHref(r.id)}>
                  <RecordCard columns={columns} record={r} />
                </Link>
              </li>
            ))}
          </ul>

          {/* Desktop table */}
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
                    {columns.map((c) => {
                      const parentLink = parentLinkForCell(r, c);
                      if (parentLink) {
                        return (
                          <td className={`${TD} align-top`} key={c}>
                            <Link
                              className="block max-w-[24rem] truncate font-mono text-foreground underline underline-offset-2 hover:no-underline"
                              href={parentLink.href}
                              title={`${parentLink.parentStream} · ${stringifyCell(r.data?.[c])}`}
                            >
                              {stringifyCell(r.data?.[c])}
                            </Link>
                          </td>
                        );
                      }
                      return (
                        <td className={`${TD} align-top`} key={c}>
                          <Link className="block" href={recordHref(r.id)}>
                            <span className="block max-w-[24rem] truncate" title={stringifyCell(r.data?.[c])}>
                              {stringifyCell(r.data?.[c])}
                            </span>
                          </Link>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Pager next={nextHref} prev={prevHref} />
    </DashboardShell>
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

function hrefFor(base: string, trail: string[], columnsParam?: string): string {
  const parts: string[] = [];
  if (trail.length) {
    parts.push(`cursors=${trail.join(",")}`);
  }
  if (columnsParam) {
    parts.push(`columns=${encodeURIComponent(columnsParam)}`);
  }
  return parts.length ? `${base}?${parts.join("&")}` : base;
}
