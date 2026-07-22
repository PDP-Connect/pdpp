// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants, IcTimestamp } from "@pdpp/brand-react";
import { DataList, PageHeader, Pager, Section } from "@pdpp/operator-ui/components/primitives";
import { RecordIdentity } from "@pdpp/operator-ui/components/record-identity";
import { buildBlobAffordance, type ExplorerFieldCapability } from "@pdpp/operator-ui/components/views/explorer-utils";
import { declaredRolesFromCapabilities } from "@pdpp/operator-ui/explore/explore-data-assembler";
import { deriveDeclaredFieldTypes, formatDeclaredAmount } from "@pdpp/operator-ui/lib/record-field-format";
import { classifyRecordKind, type DeclaredFieldTypes } from "@pdpp/operator-ui/lib/record-kind";
import { buildRecordPreview, type RecordPreview } from "@pdpp/operator-ui/lib/record-preview";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../../../components/shell.tsx";
import { WarningsBanner } from "../../../components/warnings-banner.tsx";
import { formatStreamCollectionFacts, type StreamCollectionFacts } from "../../../lib/collection-report.ts";
import { ReferenceServerUnreachableError, ResourceServerHttpError } from "../../../lib/owner-token.ts";
import { pickSemanticTimestamp, primaryTimestamp } from "../../../lib/record-timestamps.ts";
import type { RefCollectionReportEntry, RefConnectorRunSummary } from "../../../lib/ref-client.ts";
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
  type StreamMetadata,
  type StreamRecord,
  stringifyCell,
  truncate,
} from "../../../lib/rs-client.ts";
import {
  connectorInstanceIdForConnection,
  resolveConnectionForRecordsRoute,
  sourceLabelForConnection,
} from "../../connection-route.ts";
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

function formatStreamPageCount(input: {
  filtered: boolean;
  hasMore: boolean;
  matchingCount: number | null;
  pageNumber: number;
  shown: number;
  totalHeld: number | null;
}): string {
  const pagePrefix = `page ${input.pageNumber} · ${input.shown} shown`;
  if (input.filtered) {
    if (input.matchingCount !== null) {
      const matchingNoun = input.matchingCount === 1 ? "matching record" : "matching records";
      const matchingPrefix = `${pagePrefix} of ${input.matchingCount.toLocaleString()} ${matchingNoun}`;
      return input.totalHeld === null
        ? matchingPrefix
        : `${matchingPrefix} · ${input.totalHeld.toLocaleString()} total held`;
    }
    const filteredPrefix = `${pagePrefix} for current filters`;
    return input.totalHeld === null
      ? `${filteredPrefix}${input.hasMore ? " · more available" : ""}`
      : `${filteredPrefix} · ${input.totalHeld.toLocaleString()} total held`;
  }
  return input.totalHeld === null
    ? `${pagePrefix}${input.hasMore ? " · more available" : ""}`
    : `${pagePrefix} of ${input.totalHeld.toLocaleString()} total`;
}

function exactCountFromPage(page: RecordsPage): number | null {
  const count = page.meta?.count;
  return count?.kind === "exact" && typeof count.value === "number" && Number.isFinite(count.value)
    ? Math.max(0, Math.floor(count.value))
    : null;
}

function hasExactFilters(filters: Record<string, string>): boolean {
  return Object.keys(filters).length > 0;
}

function countModeForFilters(filtered: boolean): "exact" | "none" {
  return filtered ? "exact" : "none";
}

function filterParamForQuery(filtered: boolean, filters: Record<string, string>): Record<string, string> | undefined {
  return filtered ? filters : undefined;
}

function matchingCountForHeader(filtered: boolean, page: RecordsPage): number | null {
  return filtered ? exactCountFromPage(page) : null;
}

function readRecordOrder(value: string | string[] | undefined): "asc" | "desc" | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "asc" || raw === "desc" ? raw : undefined;
}

function collectionFactsForStream(
  report: readonly RefCollectionReportEntry[] | null | undefined,
  streamName: string
): StreamCollectionFacts | null {
  const entry = (report ?? []).find((row) => row.stream === streamName) ?? null;
  return entry ? formatStreamCollectionFacts(entry) : null;
}

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
    const [, field] = match;
    const raw = Array.isArray(value) ? value[0] : value;
    if (field && typeof raw === "string" && raw.length > 0) {
      filters[field] = raw;
    }
  }
  return filters;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: StreamPage composes route data, table rendering, and relationship links; this lane keeps the RecordIdentity port scoped.
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
  const filtered = hasExactFilters(exactFilters);
  const order = readRecordOrder(resolvedSearchParams.order);
  const routeId = decodeURIComponent(connector);
  const streamName = decodeURIComponent(stream);

  const trail = cursorsParam ? cursorsParam.split(",").filter(Boolean) : [];
  let connectorId = routeId;
  let connectionId = routeId;
  let sourceLabel = routeId;
  let connectorInstanceId: string | null = null;

  let page: RecordsPage;
  let streamManifest: StreamManifest | null = null;
  let streamRecordTotal: number | null = null;
  let latestSourceRun: RefConnectorRunSummary | null = null;
  let streamCollectionFacts: StreamCollectionFacts | null = null;
  let declaredFieldTypes: DeclaredFieldTypes = {};
  // Declared presentation CAPABILITIES for this stream's fields (granted/role/type),
  // sourced from streamMetadata.field_capabilities — already fetched, so the shared
  // RecordIdentity preview is a pure transform on data in hand (no new request). The
  // role map drives the honest declared-or-generic identity; the blob capability is
  // the reliable, surface-supplied image signal RecordIdentity renders the mark from.
  let fieldCapabilities: ExplorerFieldCapability[] = [];
  let listStreamMetadata: ListStreamMetadata = null;
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
    sourceLabel = sourceLabelForConnection(connection);
    connectorInstanceId = connectorInstanceIdForConnection(connection);
    latestSourceRun = connection.last_run;
    streamCollectionFacts = collectionFactsForStream(connection.collection_report, streamName);
    const sourceStreamRecordTotal =
      connection.stream_records?.find((row) => row.stream === streamName)?.record_count ?? null;
    // The parent-metadata reads depend only on the connector manifests (to
    // enumerate which parent streams declare an expand into this child) — not on
    // the records query or this stream's own metadata. Chaining them onto the
    // manifests promise and folding the result into the same `Promise.all`,
    // rather than awaiting a second batch after the first settles, lets the
    // parent reads start the moment manifests resolve and overlap the still-
    // in-flight records query. Same fetches, same inputs, same soft-failure
    // handling (`.catch(() => null)`); only the composition changes, so the
    // rendered result is identical.
    const manifestsPromise = listConnectorManifests().catch(
      () => [] as Awaited<ReturnType<typeof listConnectorManifests>>
    );
    const [pageResult, manifests, streamMetadata, parentMetadata] = await Promise.all([
      queryRecords(connectorId, streamName, {
        connectionId,
        connectorInstanceId,
        count: countModeForFilters(filtered),
        cursor: trail.at(-1),
        filter: filterParamForQuery(filtered, exactFilters),
        limit: PAGE_SIZE,
        order,
      }),
      manifestsPromise,
      // Declared presentation types for THIS stream's fields, so currency
      // minor-unit cells render as money (chase `amount` → `$30.00`). Soft:
      // a metadata read failure leaves cells on plain stringification.
      getStreamMetadata(connectorId, streamName, { connectionId, connectorInstanceId }).catch(() => null),
      // The manifest is used only to prune parent metadata reads. Link semantics
      // come from the parent streams' live `expand_capabilities`, never from
      // payload-shaped guesses or fabricated manifest fields.
      manifestsPromise.then((resolvedManifests) => {
        const manifest = findManifestForConnectorId(resolvedManifests, connectorId);
        return Promise.all(
          candidateParentStreamsForChild(manifest?.streams, streamName).map(async (parentStream) => {
            const metadata = await getStreamMetadata(connectorId, parentStream, {
              connectionId,
              connectorInstanceId,
            }).catch(() => null);
            return {
              expandCapabilities: Array.isArray(metadata?.expand_capabilities) ? metadata.expand_capabilities : [],
              parentStream,
            };
          })
        );
      }),
    ]);
    page = pageResult;
    declaredFieldTypes = deriveDeclaredFieldTypes(streamMetadata);
    // Same projection the detail page builds (page.tsx:141) — carry granted/role/type
    // so the shared identity preview uses declared roles (honest title) and the
    // declared blob field (the reliable image signal), never a field-name guess.
    fieldCapabilities = Object.entries(streamMetadata?.field_capabilities ?? {}).map(([name, capability]) => ({
      granted: capability.granted !== false,
      name,
      role: typeof capability.role === "string" ? capability.role : undefined,
      type: typeof capability.type === "string" ? capability.type : undefined,
    }));
    listStreamMetadata = listStreamMetadataFrom(streamMetadata);
    const connectorManifest = findManifestForConnectorId(manifests, connectorId);
    connectorStreams = (connectorManifest?.streams ?? []) as ManifestStream[];
    const maybeStream = connectorStreams.find((s) => s.name === streamName);
    streamManifest = (maybeStream ?? null) as StreamManifest | null;
    streamRecordTotal =
      typeof streamMetadata?.record_count === "number" && Number.isFinite(streamMetadata.record_count)
        ? Math.max(0, Math.floor(streamMetadata.record_count))
        : sourceStreamRecordTotal;
    parentRelations = parentRelationsForChild(parentMetadata, streamName);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <PageHeader title="Sources" />
          <ServerUnreachable />
        </RecordroomShellWithPalette>
      );
    }
    if (err instanceof ResourceServerHttpError && (err.status === 404 || err.status === 410)) {
      // Stream is not (or no longer) advertised by this connector's manifest.
      // Owner-mode stream visibility is manifest-derived; once a stream is
      // dropped from the manifest, records-read returns 404. Render a bounded
      // honest state instead of crashing to the segment error boundary.
      return (
        <RecordroomShellWithPalette>
          <PageHeader
            breadcrumbs={[
              { href: "/sources", label: "Sources" },
              { href: `/sources/${encodeURIComponent(connectionId)}`, label: sourceLabel },
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
              <Link className="underline underline-offset-2" href={`/sources/${encodeURIComponent(connectionId)}`}>
                the connection page
              </Link>{" "}
              to see currently available streams.
            </p>
          </div>
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }

  const allColumns = deriveAllColumns(page.data);
  const defaultColumns = computeDefaultColumns(page.data, streamManifest);
  const { columns, mode } = resolveSelectedColumns(columnsParam, allColumns, defaultColumns);
  const streamPath = `/sources/${encodeURIComponent(connectionId)}/${encodeURIComponent(streamName)}`;
  const hrefState = { columnsParam, exactFilters, order };
  const prevHref = trail.length ? hrefFor(streamPath, trail.slice(0, -1), hrefState) : null;
  const nextHref = page.next_cursor ? hrefFor(streamPath, [...trail, page.next_cursor], hrefState) : null;
  const recordHref = (id: string) => `${streamPath}/${encodeURIComponent(id)}`;
  const headerCount = formatStreamPageCount({
    filtered,
    hasMore: page.has_more,
    matchingCount: matchingCountForHeader(filtered, page),
    pageNumber: trail.length + 1,
    shown: page.data.length,
    totalHeld: streamRecordTotal,
  });

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

  // The declared role map for this stream (constant per page) — the ONE seam that
  // makes the shared RecordIdentity render the honest declared title here exactly as
  // the feed/peek/detail do, instead of the table's old raw `id`-mono lead. Computed
  // once from the field_capabilities already in hand.
  const declaredRoles = declaredRolesFromCapabilities(fieldCapabilities);
  // The shared identity props for one row: the SAME canonical RecordPreview the feed
  // and detail build, plus the reliable surface-supplied image signal (the declared
  // blob field decorated with a usable fetch_url). No new fetch, no field-name guess.
  const recordIdentityFor = (record: StreamRecord) => {
    const data = record.data ?? {};
    const { kind } = classifyRecordKind(streamName, data, declaredFieldTypes, undefined, declaredRoles);
    const preview = buildRecordPreview(kind, data, declaredFieldTypes, declaredRoles);
    const hasImage = buildBlobAffordance(data, fieldCapabilities)?.state === "available";
    return { hasImage, preview };
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
          parentRecordKey: record.id,
          parentStream: streamName,
        })
      : [];

  return (
    <RecordroomShellWithPalette>
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
            <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href={`${streamPath}/health`}>
              Stream health →
            </Link>
          </>
        }
        breadcrumbs={[
          { href: "/sources", label: "Sources" },
          { href: `/sources/${encodeURIComponent(connectionId)}`, label: sourceLabel },
          { label: streamName },
        ]}
        count={headerCount}
        description={
          <>
            Source <span className="text-foreground">{sourceLabel}</span>
          </>
        }
        title={<code className="font-mono">{streamName}</code>}
      />

      <StreamEvidenceSection
        filtered={filtered}
        filters={exactFilters}
        hasMore={page.has_more}
        latestSourceRun={latestSourceRun}
        pageNumber={trail.length + 1}
        shown={page.data.length}
        sourceHref={`/sources/${encodeURIComponent(connectionId)}`}
        sourceLabel={sourceLabel}
        streamCollectionFacts={streamCollectionFacts}
        streamName={streamName}
        syncsHref={`/syncs?connection_id=${encodeURIComponent(connectionId)}`}
        totalHeld={streamRecordTotal}
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
              const identity = recordIdentityFor(r);
              return (
                <li key={r.id}>
                  <Link className="block px-3 pt-3 hover:bg-muted/40" href={recordHref(r.id)}>
                    <RecordCard
                      columns={columns}
                      declaredFieldTypes={declaredFieldTypes}
                      hasImage={identity.hasImage}
                      preview={identity.preview}
                      record={r}
                      streamMetadata={listStreamMetadata}
                    />
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
                  <th className={TH}>date</th>
                  {/* The leading identity column is the SHARED RecordIdentity cell — the
                      same declared-or-honest-generic title the feed/peek/detail lead with,
                      NOT the old raw `id`-mono lead (THE-LENS Gate 3: one record, one
                      identity everywhere). The record key stays reachable as the cell's
                      quiet mono token + the row link. */}
                  <th className={TH}>record</th>
                  {columns.map((c) => (
                    <th className={TH} key={c}>
                      {c}
                    </th>
                  ))}
                  {hasReverseChildEdges && <th className={TH}>related</th>}
                </tr>
              </thead>
              <tbody>
                {page.data.map((r) => {
                  const identity = recordIdentityFor(r);
                  return (
                    <tr className="transition-colors hover:bg-muted/30" key={r.id}>
                      <td className={`${TD} whitespace-nowrap text-muted-foreground`}>
                        <Link className="block" href={recordHref(r.id)}>
                          <RecordDateLabel
                            emittedAt={r.emitted_at}
                            recordData={r.data}
                            streamMetadata={listStreamMetadata}
                          />
                        </Link>
                      </td>
                      <td className={`${TD} align-top`}>
                        <Link className="block" href={recordHref(r.id)}>
                          <RecordIdentity
                            hasImage={identity.hasImage}
                            preview={identity.preview}
                            recordKey={r.id}
                            showKey
                            variant="table-cell"
                          />
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
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Pager next={nextHref} prev={prevHref} />
    </RecordroomShellWithPalette>
  );
}

function StreamEvidenceSection({
  filtered,
  filters,
  hasMore,
  latestSourceRun,
  pageNumber,
  shown,
  sourceHref,
  sourceLabel,
  streamCollectionFacts,
  streamName,
  syncsHref,
  totalHeld,
}: {
  filtered: boolean;
  filters: Record<string, string>;
  hasMore: boolean;
  latestSourceRun: RefConnectorRunSummary | null;
  pageNumber: number;
  shown: number;
  sourceHref: string;
  sourceLabel: string;
  streamCollectionFacts: StreamCollectionFacts | null;
  streamName: string;
  syncsHref: string;
  totalHeld: number | null;
}) {
  const latestStreamRun = latestStreamRunEvidence(streamCollectionFacts, latestSourceRun);
  return (
    <Section
      description="This is a paginated saved-record view for one stream, not a bounded sample. It also shows the latest stream-level collection fact when the runtime reported one."
      title="Stream evidence"
    >
      <DataList ariaLabel="Stream evidence">
        <StreamEvidenceRow
          detail={`Source ${sourceLabel} · stream ${streamName}`}
          href={sourceHref}
          label="Scope"
          value="Open source"
        />
        <StreamEvidenceRow
          detail={streamTotalEvidenceLabel(totalHeld)}
          label="Record total"
          value={totalHeld === null ? "not counted yet" : `${totalHeld.toLocaleString()} saved`}
        />
        <StreamEvidenceRow
          detail={`${shown.toLocaleString()} record${shown === 1 ? "" : "s"} shown on page ${pageNumber}${hasMore ? " · more pages available" : ""}`}
          label="Current page"
          value={`page ${pageNumber}`}
        />
        <StreamEvidenceRow
          detail={latestStreamRun.detail}
          href={latestStreamRun.href}
          label="Latest stream run"
          value={latestStreamRun.value}
        />
        <StreamEvidenceRow
          detail={filtered ? exactFilterEvidenceLabel(filters) : "No exact filters are applied."}
          label="Filters"
          value={filtered ? `${Object.keys(filters).length.toLocaleString()} exact` : "none"}
        />
        <StreamEvidenceRow
          detail="Filters Syncs to this exact source, not every source of the same connector type."
          href={syncsHref}
          label="Run history"
          value="Open source-scoped Syncs"
        />
      </DataList>
    </Section>
  );
}

function latestStreamRunEvidence(
  facts: StreamCollectionFacts | null,
  latestRun: RefConnectorRunSummary | null
): { detail: string; href: string | null; value: string } {
  const href = latestRun ? `/syncs/${encodeURIComponent(latestRun.run_id)}` : null;
  if (!facts) {
    return {
      detail: latestRun
        ? "The latest source run did not include stream-level collection facts for this stream."
        : "No attributed source run has reached this dashboard yet.",
      href,
      value: latestRun ? "stream report unavailable" : "not seen yet",
    };
  }
  const detailParts = [
    latestRun ? `run ${latestRun.run_id}` : null,
    `coverage ${facts.coverage.value}`,
    facts.disposition ? `next run: ${facts.disposition.label}` : null,
    facts.pendingDetailGapsLabel,
    facts.skipLabel,
  ].filter((part): part is string => part !== null);
  return {
    detail: detailParts.join(" · "),
    href,
    value: facts.countsLabel ?? facts.coverage.label,
  };
}

function StreamEvidenceRow({
  detail,
  href,
  label,
  value,
}: {
  detail: string;
  href?: string | null;
  label: string;
  value: string;
}) {
  return (
    <li className="flex flex-col gap-1 px-3 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <p className="pdpp-caption text-muted-foreground">{label}</p>
        {href ? (
          <Link
            className="pdpp-body font-medium text-foreground underline underline-offset-2 hover:no-underline"
            href={href}
          >
            {value}
          </Link>
        ) : (
          <p className="pdpp-body font-medium text-foreground">{value}</p>
        )}
      </div>
      <p className="pdpp-caption max-w-xl break-words text-muted-foreground sm:text-right">{detail}</p>
    </li>
  );
}

function streamTotalEvidenceLabel(totalHeld: number | null): string {
  if (totalHeld === null) {
    return "The retained total is not available yet; the page still shows the current saved records it received.";
  }
  return "Basis: retained records for this stream from stream metadata or the source summary.";
}

function exactFilterEvidenceLabel(filters: Record<string, string>): string {
  return Object.entries(filters)
    .map(([key, value]) => `${key}=${truncate(value, 48)}`)
    .join(" · ");
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

type ListStreamMetadata = { consent_time_field?: string | null; cursor_field?: string | null } | null;

/**
 * StreamMetadata has `[k: string]: unknown`, so narrow the manifest-declared
 * consent_time_field / cursor_field to `string | null` for the timestamp helper.
 */
function listStreamMetadataFrom(metadata: StreamMetadata | null | undefined): ListStreamMetadata {
  if (!metadata) {
    return null;
  }
  return {
    consent_time_field: typeof metadata.consent_time_field === "string" ? metadata.consent_time_field : null,
    cursor_field: typeof metadata.cursor_field === "string" ? metadata.cursor_field : null,
  };
}

/**
 * The record's semantic/authored date (from the manifest-declared
 * consent_time_field / cursor_field), labeled with its field name. Falls back
 * to emitted_at labeled "ingested" when the stream declares no semantic field.
 * Inline (no secondary) variant for the dense desktop table row.
 */
function RecordDateLabel({
  emittedAt,
  recordData,
  streamMetadata,
}: {
  emittedAt: string;
  recordData: Record<string, unknown> | null | undefined;
  streamMetadata: ListStreamMetadata;
}) {
  const ts = primaryTimestamp(pickSemanticTimestamp(streamMetadata, recordData), emittedAt);
  return (
    <>
      <span className="pdpp-eyebrow text-muted-foreground">{ts.label}</span> <IcTimestamp value={ts.value} />
    </>
  );
}

function RecordCard({
  record,
  columns,
  declaredFieldTypes,
  hasImage,
  preview,
  streamMetadata,
}: {
  record: StreamRecord;
  columns: string[];
  declaredFieldTypes: DeclaredFieldTypes;
  /** Surface-supplied reliable image signal (declared blob field with a usable fetch_url). */
  hasImage: boolean;
  /** Canonical record model — the SAME one the feed/table/detail build. */
  preview: RecordPreview | null;
  streamMetadata: ListStreamMetadata;
}) {
  const cardTs = primaryTimestamp(pickSemanticTimestamp(streamMetadata, record.data), record.emitted_at);
  return (
    <div className="pb-3">
      {/* The card HEADER is the SHARED RecordIdentity cell — the same kind glyph +
          declared-or-honest-generic title the feed row a phone shows in Explore leads
          with, NOT the old field-name `<dl>`. The record key rides as the cell's quiet
          mono token (showKey default for `card`), so the redundant `id` <dl> row is gone. */}
      <RecordIdentity hasImage={hasImage} preview={preview} recordKey={record.id} variant="card" />
      <dl className="pdpp-caption mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">{cardTs.label}</dt>
        <dd className="break-all text-muted-foreground">
          <IcTimestamp value={cardTs.value} />
        </dd>
        {cardTs.secondary ? (
          <>
            <dt className="text-muted-foreground">{cardTs.secondary.label}</dt>
            <dd className="break-all text-muted-foreground">{cardTs.secondary.value}</dd>
          </>
        ) : null}
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
    </div>
  );
}

function hrefFor(
  base: string,
  trail: string[],
  state: {
    columnsParam?: string;
    exactFilters?: Record<string, string>;
    order?: "asc" | "desc";
  } = {}
): string {
  const parts: string[] = [];
  if (trail.length) {
    parts.push(`cursors=${trail.join(",")}`);
  }
  if (state.columnsParam) {
    parts.push(`columns=${encodeURIComponent(state.columnsParam)}`);
  }
  for (const [field, value] of Object.entries(state.exactFilters ?? {})) {
    parts.push(`filter[${encodeURIComponent(field)}]=${encodeURIComponent(value)}`);
  }
  if (state.order) {
    parts.push(`order=${state.order}`);
  }
  return parts.length ? `${base}?${parts.join("&")}` : base;
}
