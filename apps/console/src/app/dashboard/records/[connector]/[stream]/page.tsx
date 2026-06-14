import { buttonVariants, IcTimestamp, RecordroomShell } from "@pdpp/brand-react";
import { PageHeader, Pager } from "@pdpp/operator-ui/components/primitives";
import { deriveDeclaredFieldTypes, formatDeclaredAmount } from "@pdpp/operator-ui/lib/record-field-format";
import type { DeclaredFieldTypes } from "@pdpp/operator-ui/lib/record-kind";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { ServerUnreachable } from "../../../components/shell.tsx";
import { WarningsBanner } from "../../../components/warnings-banner.tsx";
import { ReferenceServerUnreachableError, ResourceServerHttpError } from "../../../lib/owner-token.ts";
import {
  computeDefaultColumns,
  deriveAllColumns,
  type ExpandCapability,
  getStreamMetadata,
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
import {
  candidateParentStreamsForChild,
  childHasOneBackLinkForField,
  childHasOneLinkFields,
  findManifestForConnectorId,
  findParentBackLink,
  parentRelationsForChild,
  type ReverseChildListLink,
  reverseChildListEdgesFromManifest,
  reverseChildListLinksFromManifest,
} from "../../lib/relationships.ts";
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
  let declaredFieldTypes: DeclaredFieldTypes = {};
  let parentRelations: Array<{ parentStream: string; capability: ExpandCapability }> = [];
  // All streams in this connector's manifest — used to enumerate child streams
  // whose declared `has_one` points back at the displayed (parent) stream, for
  // per-row reverse parent → filtered-child-list links.
  interface ManifestStream {
    name: string;
    relationships?: Array<{ name: string; stream?: string; foreign_key?: string; cardinality?: string }>;
  }
  let connectorStreams: ManifestStream[] = [];
  try {
    const connection = await resolveConnectionForRecordsRoute(routeId);
    if (!connection) {
      notFound();
    }
    connectorId = connection.connector_id;
    connectionId = connection.connection_id;
    connectorInstanceId = connectorInstanceIdForConnection(connection);
    const [pageResult, manifests, streamMetadata] = await Promise.all([
      queryRecords(connectorId, streamName, {
        connectorInstanceId,
        limit: PAGE_SIZE,
        cursor: trail.at(-1),
        ...(Object.keys(exactFilters).length > 0 ? { filter: exactFilters } : {}),
      }),
      listConnectorManifests().catch(() => []),
      // Declared presentation types for THIS stream's fields, so currency
      // minor-unit cells render as money (chase `amount` → `$30.00`). Soft:
      // a metadata read failure leaves cells on plain stringification.
      getStreamMetadata(connectorId, streamName, { connectorInstanceId }).catch(() => null),
    ]);
    page = pageResult;
    declaredFieldTypes = deriveDeclaredFieldTypes(streamMetadata);
    const connectorManifest = findManifestForConnectorId(manifests, connectorId);
    connectorStreams = (connectorManifest?.streams ?? []) as ManifestStream[];
    const maybeStream = connectorStreams.find((s) => s.name === streamName);
    streamManifest = (maybeStream ?? null) as StreamManifest | null;
    // The manifest is used only to prune parent metadata reads. Link semantics
    // come from the parent streams' live `expand_capabilities`, never from
    // payload-shaped guesses or fabricated manifest fields.
    const parentMetadata = await Promise.all(
      candidateParentStreamsForChild(connectorManifest?.streams, streamName).map(async (parentStream) => {
        const metadata = await getStreamMetadata(connectorId, parentStream, { connectorInstanceId }).catch(() => null);
        return {
          parentStream,
          expandCapabilities: Array.isArray(metadata?.expand_capabilities) ? metadata.expand_capabilities : [],
        };
      })
    );
    parentRelations = parentRelationsForChild(parentMetadata, streamName);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShell>
          <PageHeader title="Sources" />
          <ServerUnreachable />
        </RecordroomShell>
      );
    }
    if (err instanceof ResourceServerHttpError && (err.status === 404 || err.status === 410)) {
      // Stream is not (or no longer) advertised by this connector's manifest.
      // Owner-mode stream visibility is manifest-derived; once a stream is
      // dropped from the manifest, records-read returns 404. Render a bounded
      // honest state instead of crashing to the segment error boundary.
      return (
        <RecordroomShell>
          <PageHeader
            breadcrumbs={[
              { label: "Sources", href: "/dashboard/records" },
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
        </RecordroomShell>
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

  // Fields on this (child) stream that link a cell back to its parent record.
  // The linkable set is taken only from declared relations — never from a field
  // that merely looks like a foreign key — and from two manifest sources, the
  // same two the record detail page renders:
  //   1. a parent stream's `expand_capabilities` (`findParentBackLink`); and
  //   2. this child stream's own declared `has_one` relationships
  //      (`childHasOneBackLinksFromManifest`), which is the only source for the
  //      belongs-to edges (Chase/USAA/YNAB transactions → accounts, Slack
  //      messages → channels/users, …) that the parent-side `expand_capabilities`
  //      path does not surface.
  // Without source 2 the list page rendered those foreign-key cells as plain
  // text even though the same field on the record detail page is a link.
  const childManifestStream = streamManifest as {
    name: string;
    relationships?: Array<{ name: string; stream?: string; foreign_key?: string; cardinality?: string }>;
  } | null;
  const expandCapabilityLinkFields = new Set(
    parentRelations
      .map(({ capability }) => capability.child_parent_key_field ?? capability.foreign_key)
      .filter((field): field is string => typeof field === "string")
  );
  const childDeclaredLinkFields = childHasOneLinkFields(childManifestStream ?? undefined);
  // Resolve a cell to its parent back-link, preferring the `expand_capabilities`
  // source so a field declared by both sources collapses to one edge exactly as
  // `mergeParentBackLinks` does on the detail page.
  const parentLinkForCell = (record: StreamRecord, column: string) => {
    if (expandCapabilityLinkFields.has(column)) {
      return findParentBackLink(streamName, record.data, parentRelations, {
        childParentKeyField: column,
        connectionId,
      });
    }
    if (childDeclaredLinkFields.has(column)) {
      return childHasOneBackLinkForField(childManifestStream ?? undefined, record.data, column, { connectionId });
    }
    return null;
  };

  // Format a non-linked cell, preferring declared-currency formatting (chase
  // `amount` → `$30.00`) over plain stringification. Returns "" for absent
  // values, matching `stringifyCell` so the existing empty-cell handling holds.
  const cellText = (record: StreamRecord, column: string): string => {
    const value = record.data?.[column];
    const amount = formatDeclaredAmount(value, declaredFieldTypes[column]);
    return amount ? amount.text : stringifyCell(value);
  };

  // Reverse parent → filtered-child-list links, rendered per row. The displayed
  // stream is the same for every row, so the set of child streams that declare a
  // `has_one` back to it is constant per page and computed once here; each row
  // then substitutes its own record key as the filter value. When no child
  // declares a `has_one` against this stream the set is empty and no per-row
  // reverse work is done. This is the list-page counterpart to the parent detail
  // page's reverse links, and the inverse of the per-cell child → parent links
  // above; it loads no child records (href construction only) and reuses the
  // detail page's link semantics via `reverseChildListLinksFromManifest`.
  const hasReverseChildEdges = reverseChildListEdgesFromManifest(connectorStreams, streamName).length > 0;
  const reverseChildListLinksForRow = (record: StreamRecord): ReverseChildListLink[] =>
    hasReverseChildEdges
      ? reverseChildListLinksFromManifest(connectorStreams, {
          connectionId,
          parentStream: streamName,
          parentRecordKey: record.id,
        })
      : [];

  return (
    <RecordroomShell>
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
            <Link className={buttonVariants({ variant: "ghost", size: "sm" })} href={`${streamPath}/health`}>
              Stream health →
            </Link>
          </>
        }
        breadcrumbs={[
          { label: "Sources", href: "/dashboard/records" },
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
            {page.data.map((r) => {
              const reverseLinks = reverseChildListLinksForRow(r);
              return (
                <li key={r.id}>
                  <Link className="block px-3 pt-3 hover:bg-muted/40" href={recordHref(r.id)}>
                    <RecordCard columns={columns} declaredFieldTypes={declaredFieldTypes} record={r} />
                  </Link>
                  {reverseLinks.length > 0 && (
                    <div className="px-3 pt-1 pb-3">
                      <ReverseChildLinks links={reverseLinks} />
                    </div>
                  )}
                </li>
              );
            })}
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
                  {hasReverseChildEdges && <th className={TH}>related</th>}
                </tr>
              </thead>
              <tbody>
                {page.data.map((r) => (
                  <tr className="transition-colors hover:bg-muted/30" key={r.id}>
                    <td className={`${TD} whitespace-nowrap text-muted-foreground`}>
                      <Link className="block" href={recordHref(r.id)}>
                        <IcTimestamp value={r.emitted_at} />
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
                      const display = cellText(r, c);
                      return (
                        <td className={`${TD} align-top`} key={c}>
                          <Link className="block" href={recordHref(r.id)}>
                            <span className="block max-w-[24rem] truncate" title={display}>
                              {display}
                            </span>
                          </Link>
                        </td>
                      );
                    })}
                    {hasReverseChildEdges && (
                      <td className={`${TD} whitespace-nowrap align-top`}>
                        <ReverseChildLinks links={reverseChildListLinksForRow(r)} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Pager next={nextHref} prev={prevHref} />
    </RecordroomShell>
  );
}

// Per-row reverse parent → filtered-child-list links. Each link points at a
// child stream's record-list page filtered by this row's record key — never an
// inline child load and never a child record-detail URL. Renders nothing when a
// row has no reverse child edges (it always has at least one when the page-level
// `hasReverseChildEdges` gate is true, but guard anyway for the mobile caller).
function ReverseChildLinks({ links }: { links: ReverseChildListLink[] }) {
  if (links.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {links.map((link) => (
        <Link
          className="pdpp-caption font-mono text-foreground underline underline-offset-2 hover:no-underline"
          href={link.href}
          key={`reverse:${link.childStream}:${link.foreignKey}`}
        >
          {link.childStream} (has_many) →
        </Link>
      ))}
    </div>
  );
}

function RecordCard({
  record,
  columns,
  declaredFieldTypes,
}: {
  record: StreamRecord;
  columns: string[];
  declaredFieldTypes: DeclaredFieldTypes;
}) {
  return (
    <dl className="pdpp-caption grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      <dt className="text-muted-foreground">emitted_at</dt>
      <dd className="break-all text-muted-foreground">
        <IcTimestamp value={record.emitted_at} />
      </dd>
      <dt className="text-muted-foreground">id</dt>
      <dd className="break-all font-mono">{truncate(record.id, 48)}</dd>
      {columns.map((c) => {
        const amount = formatDeclaredAmount(record.data?.[c], declaredFieldTypes[c]);
        const v = amount ? amount.text : stringifyCell(record.data?.[c]);
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
