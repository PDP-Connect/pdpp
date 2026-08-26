// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatConnectorKeyForDisplay } from "@pdpp/display";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  buildDatasetStreamSizeModel,
  buildDatasetTopModel,
  buildStreamConnectionLabels,
  type DatasetStreamSizeInput,
  type DatasetTopRowInput,
} from "../../lib/dataset-grains.ts";
import type { DatasetSummaryProjectionMetadata, DeploymentDiagnostics } from "../../lib/ref-client.ts";
import { buildSourceStorageModel, type SourceStorageInput } from "../../lib/source-storage.ts";
import { buildDatasetSummaryProjectionStatusModel, buildStorageFootprintModel } from "../../lib/storage-footprint.ts";
import { Button } from "../../ui/button.tsx";
import { Timestamp } from "../../ui/timestamp.tsx";
import { EmptyState } from "../empty-state.tsx";
import { Callout, PageHeader, Section } from "../primitives.tsx";

interface DeploymentDiagnosticsViewProps {
  actions?: ReactNode;
  afterDiagnostics?: ReactNode;
  beforeDiagnostics?: ReactNode;
  breadcrumbs?: { href?: string; label: string }[];
  description: string;
  // The dataset-summary projection metadata (`/_ref/dataset/summary`'s
  // `projection` field). Optional: when omitted, the storage section
  // renders the retained-payload comparison with no status/recovery
  // affordance, same as before this field existed. Used to tell the
  // operator WHY `retainedBytes` is unknown when it is, and to offer the
  // manual-rebuild recovery action when the projection is not `fresh`.
  projection?: DatasetSummaryProjectionMetadata | null;
  // Server-action result banners for the rebuild action below, threaded in
  // as plain strings (from a redirect query param) rather than client
  // state — this is a server-rendered page, not a client form.
  projectionActionError?: string | null;
  projectionActionNotice?: string | null;
  // Server action bound to a `<form action={...}>` that calls
  // `POST /_ref/dataset/summary/rebuild`. Optional: when omitted, the
  // projection status line renders with no action button (e.g. a host that
  // hasn't wired the action yet).
  rebuildDatasetSummaryAction?: () => Promise<void>;
  report: DeploymentDiagnostics;
  // The logical retained payload (`total_retained_bytes` from
  // `/_ref/dataset/summary`), rendered beside the physical footprint as a
  // labeled comparison. Optional: when omitted the comparison line is hidden
  // rather than guessed. Never combined with the physical size.
  retainedBytes?: number | null;
  // Connector-summary rows (`GET /_ref/connectors`) used only for the
  // per-source storage table. Optional: when omitted — or when the list read
  // fails — the table is hidden rather than rendered empty, exactly as the
  // physical footprint hides rather than guessing. These per-source totals are
  // LOGICAL and are never summed with, or compared against, the physical
  // on-disk size in the same section.
  sources?: readonly SourceStorageInput[];
  // True when `sources` is one bounded page and the server reported more
  // beyond it. The table then says so explicitly rather than presenting a
  // truncated list as the whole fleet.
  sourcesTruncated?: boolean;
  // Stream-grain retained bytes (`GET /_ref/dataset/size?grain=stream`) — one
  // level finer than the per-source table above. Optional: hidden when
  // omitted or the read failed, same posture as `sources`.
  streamSizes?: readonly DatasetStreamSizeInput[];
  title?: string;
  // Record/blob top-N leaderboards (`GET /_ref/dataset/top`), already
  // server-bounded to 25 rows each (`MAX_TOP_LIMIT`). Never paginate or
  // re-sort these client-side — render exactly what the server returned.
  topBlobs?: readonly DatasetTopRowInput[];
  topRecords?: readonly DatasetTopRowInput[];
}

// ─── Section group divider ──────────────────────────────────────────────────
// Visual separator + label that steps up above the pdpp-title Section headers.
// Uses pdpp-heading (20px/600) so section groups read clearly above their
// constituent sections (pdpp-title = 14px/600).

function SectionGroupDivider({ label }: { label: string }) {
  return (
    <div className="mt-2 mb-5 border-border/60 border-t pt-5">
      <h2 className="pdpp-heading text-foreground">{label}</h2>
    </div>
  );
}

// ─── Section nav ────────────────────────────────────────────────────────────
// Sticky in-page jump strip. One link per major section group so the operator
// can reach any area of this long page without scrolling.

const SECTION_NAV_ITEMS = [
  { id: "readiness", label: "Readiness" },
  { id: "warnings", label: "Warnings" },
  { id: "retrieval", label: "Retrieval" },
  { id: "storage", label: "Storage" },
  { id: "diagnostics", label: "Diagnostics" },
] as const;

function DeploymentSectionNav() {
  return (
    <nav
      aria-label="Page sections"
      className="sticky top-0 z-10 -mx-6 mb-6 flex flex-wrap gap-x-0.5 border-border/80 border-b bg-background px-6 py-2 sm:-mx-8 sm:px-8 md:-mx-10 md:px-10"
    >
      {SECTION_NAV_ITEMS.map((item) => (
        <Link
          className="pdpp-caption rounded px-2.5 py-1 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          href={`#${item.id}`}
          key={item.id}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

export function DeploymentDiagnosticsView({
  actions,
  afterDiagnostics,
  beforeDiagnostics,
  breadcrumbs,
  description,
  projection,
  projectionActionError,
  projectionActionNotice,
  rebuildDatasetSummaryAction,
  report,
  retainedBytes,
  sources,
  sourcesTruncated,
  streamSizes,
  title = "Deployment",
  topBlobs,
  topRecords,
}: DeploymentDiagnosticsViewProps) {
  return (
    <>
      <PageHeader actions={actions} breadcrumbs={breadcrumbs} description={description} title={title} />
      <DeploymentSectionNav />

      <div className="scroll-mt-16" id="readiness">
        {beforeDiagnostics}
      </div>
      <WarningsSection warnings={report.warnings} />
      <div className="scroll-mt-16" id="retrieval">
        <SectionGroupDivider label="Retrieval" />
        <RuntimeCapabilitiesSection capabilities={report.runtime_capabilities} />
        <LexicalSection report={report} />
        <SemanticSection report={report} />
        <ParticipationSection participation={report.semantic.participation} />
        <ManifestsSection manifests={report.manifests} />
      </div>
      <div className="scroll-mt-16" id="storage">
        <SectionGroupDivider label="Storage & Readiness" />
        <DatabaseSection
          database={report.database}
          indexKind={report.semantic.index.kind}
          projection={projection}
          projectionActionError={projectionActionError}
          projectionActionNotice={projectionActionNotice}
          rebuildDatasetSummaryAction={rebuildDatasetSummaryAction}
          retainedBytes={retainedBytes}
        />
        <SourceStorageSection sources={sources} truncated={sourcesTruncated} />
        <StreamSizeSection connections={sources} rows={streamSizes} />
        <TopRecordsAndBlobsSection topBlobs={topBlobs} topRecords={topRecords} />
      </div>
      <div className="scroll-mt-16" id="diagnostics">
        <SectionGroupDivider label="Diagnostics" />
        <EnvironmentSection environment={report.environment} />
      </div>
      {afterDiagnostics}
    </>
  );
}

export function isDeploymentIndexing(report: DeploymentDiagnostics): boolean {
  const warmStatus = report.semantic.backend.warm_status;
  return Boolean(
    report.lexical.index.backfill_progress ||
      report.semantic.index.backfill_progress ||
      report.semantic.index.state === "building" ||
      warmStatus?.status === "downloading" ||
      warmStatus?.status === "not_started"
  );
}

const WARNING_TITLES: Record<DeploymentDiagnostics["warnings"][number]["code"], string> = {
  backend_unavailable: "Embedding backend unavailable",
  browser_connectors_need_collector: "Browser-backed connectors need a local collector",
  building_index: "Semantic index is rebuilding",
  collector_protocol_outdated: "Local collector protocol is outdated",
  download_disabled: "Model download disabled",
  lexical_building_index: "Lexical index is rebuilding",
  low_disk_headroom: "Disk headroom is low",
  missing_model_cache: "Embedding model cache missing",
  stale_index: "Semantic index is stale",
  vector_index_fallback: "Using blob-flat vector fallback",
  zero_participation: "Zero semantic participation",
};

function WarningsSection({ warnings }: { warnings: DeploymentDiagnostics["warnings"] }) {
  if (warnings.length === 0) {
    return (
      <Section id="warnings" title="Warnings">
        <p className="pdpp-body text-muted-foreground">No warnings. Retrieval looks operational.</p>
      </Section>
    );
  }
  return (
    <Section id="warnings" title={`Warnings (${warnings.length})`}>
      <div className="flex flex-col gap-3">
        {warnings.map((warning) => (
          <Callout
            description={warning.message}
            key={warning.code}
            title={WARNING_TITLES[warning.code]}
            tone="warning"
          />
        ))}
      </div>
    </Section>
  );
}

function RuntimeCapabilitiesSection({ capabilities }: { capabilities: DeploymentDiagnostics["runtime_capabilities"] }) {
  const pairing = capabilities.collector_pairing;
  const acceptedLabel =
    capabilities.accepted_collector_protocol_versions.length > 0
      ? capabilities.accepted_collector_protocol_versions.join(", ")
      : "—";
  const observedProtocolLabel = (() => {
    if (!pairing) {
      return "—";
    }
    if (pairing.protocol_version === "legacy_unknown") {
      return "unknown (pre-header)";
    }
    return pairing.protocol_version ?? "—";
  })();
  const connectorVersions = pairing ? Object.entries(pairing.connector_versions) : [];
  return (
    <Section
      description="Bindings the provider/control-plane runtime advertises. Connectors requiring a binding the runtime does not advertise must run in a paired local collector runtime."
      title="Runtime capabilities"
    >
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        <Field label="In container" value={yesNo(capabilities.in_container)} />
        <Field label="Collector paired" value={yesNo(capabilities.collector_paired)} />
        <Field label="Network binding" value={yesNo(capabilities.bindings.network)} />
        <Field label="Filesystem binding" value={yesNo(capabilities.bindings.filesystem)} />
        <Field label="Browser binding" value={yesNo(capabilities.bindings.browser)} />
        <Field label="Local-device binding" value={yesNo(capabilities.bindings.local_device)} />
        <Field label="Accepted collector protocol versions" value={acceptedLabel} />
        <Field label="Paired collector protocol version" value={observedProtocolLabel} />
        <Field label="Paired runner version" value={pairing?.runner_version ?? "—"} />
        <Field
          label="Bundled connector versions"
          value={
            connectorVersions.length === 0
              ? "—"
              : connectorVersions.map(([id, v]) => `${formatConnectorKeyForDisplay(id)}@${v}`).join(", ")
          }
        />
      </dl>
    </Section>
  );
}

function LexicalSection({ report }: { report: DeploymentDiagnostics }) {
  const { index } = report.lexical;
  return (
    <Section title="Lexical index">
      {index.backfill_progress ? (
        <BackfillProgress
          indexedCount={index.backfill_progress.indexed_rows}
          indexedLabel="FTS rows written"
          progress={index.backfill_progress}
        />
      ) : null}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        <Field label="Index state" value={index.state} />
      </dl>
    </Section>
  );
}

function SemanticSection({ report }: { report: DeploymentDiagnostics }) {
  const { backend, index } = report.semantic;
  const warmStatus = backend.warm_status ?? null;
  return (
    <Section title="Semantic backend">
      {renderSemanticBackfillProgress(index)}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        <Field label="Model preparation" value={warmStatus ? `${warmStatus.status} (${warmStatus.mode})` : "—"} />
        <Field
          label="Observed model cache"
          value={warmStatus ? `${warmStatus.cache_bytes} bytes across ${warmStatus.cache_files} files` : "—"}
        />
        <Field label="Preparation started" value={warmStatus?.started_at ?? "—"} />
        <Field label="Last cache progress" value={warmStatus?.last_progress_at ?? "—"} />
        <Field label="Last observed" value={warmStatus ? warmStatus.last_observed_at : "—"} />
        <Field label="Preparation ready" value={warmStatus?.ready_at ?? "—"} />
        <Field
          label="Preparation failure"
          value={
            warmStatus?.failed_at ? `${warmStatus.failed_at}${warmStatus.error ? ` · ${warmStatus.error}` : ""}` : "—"
          }
        />
        <Field label="Configured" value={yesNo(backend.configured)} />
        <Field label="Available" value={yesNo(backend.available)} />
        <Field label="Profile" value={backend.profile_id ?? "—"} />
        <Field label="Model" value={backend.model ?? "—"} />
        <Field label="Dtype" value={backend.dtype ?? "—"} />
        <Field label="Dimensions" value={backend.dimensions === null ? "—" : String(backend.dimensions)} />
        <Field label="Distance metric" value={backend.distance_metric ?? "—"} />
        <Field label="Language bias" value={formatLanguageBias(backend.language_bias)} />
        <Field label="Model cache path" value={backend.model_cache_path ?? "—"} />
        <Field
          label="Model cached"
          value={backend.model_cache_present === null ? "—" : yesNo(backend.model_cache_present)}
        />
        <Field
          label="Download allowed"
          value={backend.download_allowed === null ? "—" : yesNo(backend.download_allowed)}
        />
        <Field label="Vector index kind" value={index.kind ?? "—"} />
        <Field label="Index state" value={index.state ?? "—"} />
      </dl>
    </Section>
  );
}

function renderSemanticBackfillProgress(index: DeploymentDiagnostics["semantic"]["index"]) {
  if (index.backfill_progress) {
    return (
      <BackfillProgress
        indexedCount={index.backfill_progress.indexed_vectors}
        indexedLabel="vectors indexed"
        progress={index.backfill_progress}
      />
    );
  }
  if (index.state === "building") {
    return <IndexingWithoutProgress />;
  }
  return null;
}

function IndexingWithoutProgress() {
  return (
    <div className="mb-4 rounded border border-amber-400/50 bg-amber-50/70 px-3 py-3 text-sm dark:bg-amber-950/30">
      <div className="font-medium">Backfill progress unavailable</div>
      <p className="mt-1 text-muted-foreground text-xs">
        The semantic index is marked as building, but the active worker has not published a progress snapshot yet. This
        page refreshes automatically while indexing is active.
      </p>
    </div>
  );
}

function BackfillProgress({
  indexedCount,
  indexedLabel,
  progress,
}: {
  indexedCount: number;
  indexedLabel: string;
  progress:
    | NonNullable<DeploymentDiagnostics["semantic"]["index"]["backfill_progress"]>
    | NonNullable<DeploymentDiagnostics["lexical"]["index"]["backfill_progress"]>;
}) {
  const percent =
    progress.records_total && progress.records_total > 0
      ? Math.min(100, Math.round((progress.records_scanned / progress.records_total) * 100))
      : null;
  const connectorKey = formatConnectorKeyForDisplay(progress.connector_id);
  const streamLabel = progress.stream ? `${connectorKey} / ${progress.stream}` : connectorKey;
  const rate = recordsPerSecond(progress);

  return (
    <div className="mb-4 rounded border border-amber-400/50 bg-amber-50/70 px-3 py-3 text-sm dark:bg-amber-950/30">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <div>
          <div className="font-medium">Backfill progress</div>
          <p className="mt-1 text-muted-foreground">
            {progress.phase} · {streamLabel}
          </p>
        </div>
        <div className="text-muted-foreground text-xs tabular-nums">
          {progress.manifest_streams_checked}/{progress.manifest_streams_total} streams checked
        </div>
      </div>
      {percent === null ? (
        <p className="mt-2 text-muted-foreground text-xs">Scanning has not started for the current stream yet.</p>
      ) : (
        <div className="mt-3">
          <div className="h-2 overflow-hidden rounded bg-background/80">
            <div className="h-full bg-amber-500 transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          <div className="mt-1 flex flex-wrap justify-between gap-x-4 gap-y-1 text-muted-foreground text-xs">
            <span>
              {progress.records_scanned.toLocaleString()} / {progress.records_total?.toLocaleString()} records scanned
              {rate ? ` · ${rate} records/s` : ""}
            </span>
            <span>{percent}%</span>
          </div>
        </div>
      )}
      <p className="mt-1 text-muted-foreground text-xs">
        {indexedCount.toLocaleString()} {indexedLabel} · updated <Timestamp value={progress.updated_at} />
        {progress.active_jobs > 1 ? ` · ${progress.active_jobs} active jobs` : ""}
      </p>
    </div>
  );
}

function ParticipationSection({
  participation,
}: {
  participation: DeploymentDiagnostics["semantic"]["participation"];
}) {
  const summary =
    participation.field_count > 0
      ? `${participation.field_count} field${participation.field_count === 1 ? "" : "s"} across ${participation.connector_count} connector${participation.connector_count === 1 ? "" : "s"}`
      : "No participating fields";
  return (
    <Section
      description="Every (connector, stream, field) that contributes to semantic retrieval. Derived from loaded manifests."
      title="Participation"
    >
      {participation.tuples.length === 0 ? (
        <EmptyState
          hint="No loaded manifest declares query.search.semantic_fields. Until at least one stream participates, semantic retrieval returns empty results even if the backend and index are ready."
          title="No participating fields"
        />
      ) : (
        <details className="group">
          <summary className="pdpp-caption flex cursor-pointer select-none list-none items-center gap-2 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
            <span className="inline-flex size-4 items-center justify-center rounded text-xs transition-transform group-open:rotate-90">
              ▶
            </span>
            <span>
              {summary} — <span className="underline-offset-2 hover:underline">expand to browse</span>
            </span>
          </summary>
          <div className="mt-3">
            <table className="w-full border-border/80 border-y text-left text-sm">
              <thead>
                <tr className="text-muted-foreground text-xs uppercase tracking-wide">
                  <th className="px-2 py-2 font-semibold">Connector</th>
                  <th className="px-2 py-2 font-semibold">Stream</th>
                  <th className="px-2 py-2 font-semibold">Field</th>
                  <th className="px-2 py-2 font-semibold">Provenance</th>
                </tr>
              </thead>
              <tbody>
                {participation.tuples.map((t) => (
                  <tr className="border-border/60 border-t" key={`${t.connector_id}::${t.stream}::${t.field}`}>
                    <td className="px-2 py-1.5 font-mono text-xs">{formatConnectorKeyForDisplay(t.connector_id)}</td>
                    <td className="px-2 py-1.5">{t.stream}</td>
                    <td className="px-2 py-1.5 font-mono text-xs">{t.field}</td>
                    <td className="px-2 py-1.5 text-muted-foreground text-xs">{t.provenance}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </Section>
  );
}

function ManifestsSection({ manifests }: { manifests: DeploymentDiagnostics["manifests"] }) {
  return (
    <Section
      description="Manifests currently loaded by the reference server."
      title={`Manifests (${manifests.length})`}
    >
      {manifests.length === 0 ? (
        <EmptyState title="No connectors registered" />
      ) : (
        <table className="w-full border-border/80 border-y text-left text-sm">
          <thead>
            <tr className="text-muted-foreground text-xs uppercase tracking-wide">
              <th className="px-2 py-2 font-medium">Connector</th>
              <th className="px-2 py-2 font-medium">Name</th>
              <th className="px-2 py-2 font-medium">Provenance</th>
              <th className="px-2 py-2 font-medium">Semantic streams</th>
            </tr>
          </thead>
          <tbody>
            {manifests.map((m) => (
              <tr className="border-border/60 border-t" key={m.connector_id}>
                <td className="px-2 py-1.5 font-mono text-xs">{formatConnectorKeyForDisplay(m.connector_id)}</td>
                <td className="px-2 py-1.5">{m.display_name ?? "—"}</td>
                <td className="px-2 py-1.5 text-muted-foreground text-xs">{m.provenance}</td>
                <td className="px-2 py-1.5 tabular-nums">{m.semantic_stream_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function DatabaseSection({
  database,
  indexKind,
  projection,
  projectionActionError,
  projectionActionNotice,
  rebuildDatasetSummaryAction,
  retainedBytes,
}: {
  database: DeploymentDiagnostics["database"];
  indexKind: DeploymentDiagnostics["semantic"]["index"]["kind"];
  // Forwarded verbatim into buildDatasetSummaryProjectionStatusModel, whose
  // own parameter is already declared `| undefined`.
  projection?: DatasetSummaryProjectionMetadata | null | undefined;
  // Forwarded verbatim from the view's own same-shaped optional prop and
  // read only via truthiness below (`projectionActionError ? ... : null`).
  projectionActionError?: string | null | undefined;
  // Forwarded verbatim into DatasetSummaryProjectionStatus's `notice`, which
  // is already declared `| undefined`.
  projectionActionNotice?: string | null | undefined;
  // Forwarded verbatim into DatasetSummaryProjectionStatus's `rebuildAction`,
  // which is already declared `| undefined`.
  rebuildDatasetSummaryAction?: (() => Promise<void>) | undefined;
  // Forwarded verbatim into buildStorageFootprintModel, whose own parameter
  // is already declared `| undefined`.
  retainedBytes?: number | null | undefined;
}) {
  const footprint = buildStorageFootprintModel(database, retainedBytes);
  const projectionStatus = buildDatasetSummaryProjectionStatusModel(projection);
  return (
    <Section
      description="On-disk database size is operator diagnostics. It is a different measurement from the retained payload (the JSON/blob byte length of records, history, and blobs) and is never summed with it: the physical size also includes index storage, the event log, TOAST, page bloat, and free space."
      title="Database"
    >
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        <Field label="Path" value={database.path} />
        <Field label="Vector index kind" value={indexKind ?? "—"} />
        <Field label="On disk (physical)" value={footprint.physicalLabel} />
        <Field label="Retained payload (logical)" value={footprint.retainedLabel ?? "—"} />
      </dl>

      {footprint.measured ? (
        <DatabaseRelations relations={footprint.relations} />
      ) : (
        <Callout
          className="mt-4"
          description={footprint.unmeasuredNote ?? ""}
          surface="neutral"
          title="On-disk size unmeasured"
        />
      )}

      <DatasetSummaryProjectionStatus
        notice={projectionActionNotice}
        rebuildAction={rebuildDatasetSummaryAction}
        status={projectionStatus}
      />
      {projectionActionError ? (
        <Callout className="mt-3" description={projectionActionError} title="Rebuild failed" tone="warning" />
      ) : null}
    </Section>
  );
}

// Status line + recovery action for the dataset-summary projection. Kept
// deliberately small — one line and one button, not a new page or panel —
// per the "give the owner a visible path" requirement: today a failed
// projection is invisible (no boot hook, scheduler, or UI affordance calls
// its one rebuild route) and unrecoverable short of an API client. This
// renders nothing when the projection is already fresh, so a healthy
// deployment sees no change.
function DatasetSummaryProjectionStatus({
  notice,
  rebuildAction,
  status,
}: {
  // Forwarded verbatim from the view's own projectionActionNotice /
  // rebuildDatasetSummaryAction props (also plain optionals, no
  // re-defaulting) and read only via truthiness below (`notice ? ... :
  // null`, `rebuildAction ? ... : undefined`), so "absent" and "present but
  // undefined" are already the same one level up.
  notice?: string | null | undefined;
  rebuildAction?: (() => Promise<void>) | undefined;
  status: ReturnType<typeof buildDatasetSummaryProjectionStatusModel>;
}) {
  if (!status.needsAttention) {
    return notice ? <Callout className="mt-3" description={notice} title="Dataset summary" tone="info" /> : null;
  }
  return (
    <Callout
      action={
        rebuildAction ? (
          <form action={rebuildAction}>
            <Button size="sm" type="submit" variant="outline">
              Recompute now
            </Button>
          </form>
        ) : undefined
      }
      className="mt-3"
      description={status.statusLine}
      title="Dataset summary needs attention"
      tone="warning"
    />
  );
}

function DatabaseRelations({ relations }: { relations: ReturnType<typeof buildStorageFootprintModel>["relations"] }) {
  if (relations.length === 0) {
    return null;
  }
  return (
    <div className="mt-4">
      <p className="pdpp-eyebrow text-muted-foreground">
        Largest relations (approximate — does not sum to the on-disk total)
      </p>
      <table className="mt-2 w-full border-border/80 border-y text-left text-sm">
        <thead>
          <tr className="text-muted-foreground text-xs uppercase tracking-wide">
            <th className="px-2 py-2 font-medium">Relation</th>
            <th className="px-2 py-2 text-right font-medium">Size</th>
          </tr>
        </thead>
        <tbody>
          {relations.map((relation) => (
            <tr className="border-border/60 border-t" key={relation.name}>
              <td className="px-2 py-1.5 font-mono text-xs">{relation.name}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{relation.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Per-source retained payload. The Database section above answers "how big is
// the database" and "which tables"; this answers "which SOURCE" — the question
// an operator actually asks before pruning. Deliberately a separate Section
// from the physical footprint so the two measurements are never read as one:
// these totals are logical and do not reconcile against pg_database_size.
function SourceStorageSection({
  sources,
  truncated,
}: {
  // Forwarded verbatim from the view's own `sources`/`sourcesTruncated`
  // props (also plain optionals) and read only via `!sources ||
  // sources.length === 0` / truthiness below, so "absent" and "present but
  // undefined" are already the same one level up.
  sources?: readonly SourceStorageInput[] | undefined;
  truncated?: boolean | undefined;
}) {
  if (!sources || sources.length === 0) {
    return null;
  }
  const model = buildSourceStorageModel(sources);
  if (model.rows.length === 0) {
    return null;
  }
  // One bounded page may not hold every configured source. When the server
  // reported more, the title and description say so — a truncated list must
  // never read as the whole fleet.
  const title = truncated ? `Retained payload by source (first ${model.rows.length})` : "Retained payload by source";
  const description = truncated
    ? `${model.logicalNote} This is the first page of ${model.rows.length} sources, ordered by retained payload within that page — the deployment holds more sources than are listed here. Open Sources for the full list.`
    : model.logicalNote;
  return (
    <Section description={description} title={title}>
      <table className="w-full border-border/80 border-y text-left text-sm">
        <thead>
          <tr className="text-muted-foreground text-xs uppercase tracking-wide">
            <th className="px-2 py-2 font-medium">Source</th>
            <th className="px-2 py-2 text-right font-medium">Records</th>
            <th className="px-2 py-2 text-right font-medium">Retained (logical)</th>
          </tr>
        </thead>
        <tbody>
          {model.rows.map((row) => (
            <tr className="border-border/60 border-t align-top" key={row.connectionId}>
              <td className="px-2 py-1.5">
                <span className="text-foreground">{row.label}</span>
                {row.breakdownLabel ? (
                  <span className="block text-muted-foreground/70 text-xs" data-testid="retained-bytes-breakdown">
                    {row.breakdownLabel}
                  </span>
                ) : null}
              </td>
              <td
                className={`px-2 py-1.5 text-right tabular-nums ${row.recordsMeasured ? "" : "text-muted-foreground"}`}
              >
                {row.recordsLabel}
              </td>
              <td className={`px-2 py-1.5 text-right tabular-nums ${row.sizeMeasured ? "" : "text-muted-foreground"}`}>
                {row.sizeLabel}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {model.someMeasured ? null : (
        <Callout
          className="mt-4"
          description="No source reported a retained-payload size. Sizes appear once the retained-size projection has been observed for each connection."
          surface="neutral"
          title="Per-source sizes unmeasured"
        />
      )}
    </Section>
  );
}

// Stream-grain retained payload — one level finer than "which source" above.
// Already computed and exposed at `GET /_ref/dataset/size?grain=stream`; this
// wires it into the console for the first time. Compact by design (the owner
// does not need every stream surfaced everywhere, just somewhere reachable).
function StreamSizeSection({
  connections,
  rows,
}: {
  // Forwarded verbatim from the view's own `sources`/`streamSizes` props
  // (also plain optionals) and read only via `connections ?? []` / `!rows ||
  // rows.length === 0` below, so "absent" and "present but undefined" are
  // already the same one level up.
  connections?: readonly SourceStorageInput[] | undefined;
  rows?: readonly DatasetStreamSizeInput[] | undefined;
}) {
  if (!rows || rows.length === 0) {
    return null;
  }
  // Disambiguates rows that would otherwise share an identical
  // `connector / stream` label (e.g. three ChatGPT connections). Built from
  // the same connector-summary list the per-source table above already
  // fetched — no new endpoint or query.
  const connectionLabels = buildStreamConnectionLabels(connections ?? []);
  const model = buildDatasetStreamSizeModel(rows, connectionLabels);
  if (model.rows.length === 0) {
    return null;
  }
  return (
    <Section
      description="Retained payload per stream (connector / stream) — a finer grain than the per-source table above. Logical bytes, same as above; does not sum to the on-disk database size."
      title="Retained payload by stream"
    >
      <table className="w-full border-border/80 border-y text-left text-sm">
        <thead>
          <tr className="text-muted-foreground text-xs uppercase tracking-wide">
            <th className="px-2 py-2 font-medium">Stream</th>
            <th className="px-2 py-2 text-right font-medium">Retained (logical)</th>
          </tr>
        </thead>
        <tbody>
          {model.rows.map((row) => (
            <tr className="border-border/60 border-t" key={row.key}>
              <td className="px-2 py-1.5 font-mono text-xs">{row.label}</td>
              <td className={`px-2 py-1.5 text-right tabular-nums ${row.sizeMeasured ? "" : "text-muted-foreground"}`}>
                {row.sizeLabel}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

// Record/blob top-N heavy-hitter leaderboards — already bounded server-side
// to 25 rows each (`MAX_TOP_LIMIT`, `retained-size-read-model.ts:129`).
// Rendered as two compact side-by-side lists rather than a drill-down UI —
// the owner explicitly said these do not all need to be surfaced, just
// reachable. Never paginated further: what the server returns is the whole
// leaderboard.
function TopRecordsAndBlobsSection({
  topRecords,
  topBlobs,
}: {
  // Forwarded verbatim from the view's own `topRecords`/`topBlobs` props
  // (also plain optionals) and read only via truthiness below
  // (`topRecords ? ... : null`), so "absent" and "present but undefined" are
  // already the same one level up.
  topRecords?: readonly DatasetTopRowInput[] | undefined;
  topBlobs?: readonly DatasetTopRowInput[] | undefined;
}) {
  const recordsModel = topRecords ? buildDatasetTopModel(topRecords, "record", "total_retained_bytes") : null;
  const blobsModel = topBlobs ? buildDatasetTopModel(topBlobs, "blob", "blob_bytes") : null;
  const hasRecords = recordsModel && recordsModel.rows.length > 0;
  const hasBlobs = blobsModel && blobsModel.rows.length > 0;
  if (!(hasRecords || hasBlobs)) {
    return null;
  }
  return (
    <Section
      description="The largest individual records and blobs across the deployment (top 25 by retained bytes). Logical bytes; a record's own size is separate from any blob it references — see that record's detail page for the split."
      title="Largest records and blobs"
    >
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {hasRecords ? <TopList rows={recordsModel.rows} title="Largest records" /> : null}
        {hasBlobs ? <TopList rows={blobsModel.rows} title="Largest blobs" /> : null}
      </div>
    </Section>
  );
}

function TopList({ title, rows }: { title: string; rows: ReturnType<typeof buildDatasetTopModel>["rows"] }) {
  return (
    <div>
      <p className="pdpp-eyebrow text-muted-foreground">{title}</p>
      <table className="mt-2 w-full border-border/80 border-y text-left text-sm">
        <thead>
          <tr className="text-muted-foreground text-xs uppercase tracking-wide">
            <th className="px-2 py-2 font-medium">Item</th>
            <th className="px-2 py-2 text-right font-medium">Size</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className="border-border/60 border-t" key={row.key}>
              <td className="truncate px-2 py-1.5 font-mono text-xs" title={row.label}>
                {row.label}
              </td>
              <td className={`px-2 py-1.5 text-right tabular-nums ${row.sizeMeasured ? "" : "text-muted-foreground"}`}>
                {row.sizeLabel}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EnvironmentSection({ environment }: { environment: DeploymentDiagnostics["environment"] }) {
  return (
    <Section
      description="Relevant environment variables shaping reference behavior. Secrets are redacted by the server and never reach this page."
      title="Environment"
    >
      <table className="w-full border-border/80 border-y text-left text-sm">
        <thead>
          <tr className="text-muted-foreground text-xs uppercase tracking-wide">
            <th className="px-2 py-2 font-medium">Name</th>
            <th className="px-2 py-2 font-medium">Value</th>
            <th className="px-2 py-2 font-medium">Provenance</th>
          </tr>
        </thead>
        <tbody>
          {environment.map((entry) => (
            <tr className="border-border/60 border-t" key={entry.name}>
              <td className="px-2 py-1.5 font-mono text-xs">{entry.name}</td>
              <td className="px-2 py-1.5 font-mono text-xs">{formatEnvValue(entry)}</td>
              <td className="px-2 py-1.5 text-muted-foreground text-xs">{entry.provenance}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="pdpp-eyebrow text-muted-foreground">{label}</dt>
      <dd className="pdpp-body break-words">{value}</dd>
    </div>
  );
}

function recordsPerSecond(
  progress:
    | NonNullable<DeploymentDiagnostics["semantic"]["index"]["backfill_progress"]>
    | NonNullable<DeploymentDiagnostics["lexical"]["index"]["backfill_progress"]>
): string | null {
  const started = Date.parse(progress.started_at);
  const updated = Date.parse(progress.updated_at);
  if (!(Number.isFinite(started) && Number.isFinite(updated)) || updated <= started || progress.records_scanned <= 0) {
    return null;
  }
  return (progress.records_scanned / ((updated - started) / 1000)).toFixed(1);
}

function yesNo(v: boolean): string {
  return v ? "yes" : "no";
}

function formatLanguageBias(bias: DeploymentDiagnostics["semantic"]["backend"]["language_bias"]): string {
  if (!bias) {
    return "—";
  }
  return bias.note ? `${bias.primary} (${bias.note})` : bias.primary;
}

function formatEnvValue(entry: DeploymentDiagnostics["environment"][number]): string {
  if (entry.provenance === "redacted") {
    return "••• redacted •••";
  }
  if (entry.provenance === "absent") {
    return "—";
  }
  return entry.value ?? "—";
}
