import Link from "next/link";
import type { ReactNode } from "react";
import { formatConnectorKeyForDisplay } from "../../lib/connector-display.ts";
import type { DeploymentDiagnostics } from "../../lib/ref-client.ts";
import { buildStorageFootprintModel } from "../../lib/storage-footprint.ts";
import { Timestamp } from "../../ui/timestamp.tsx";
import { EmptyState } from "../empty-state.tsx";
import { Callout, PageHeader, Section } from "../primitives.tsx";

interface DeploymentDiagnosticsViewProps {
  actions?: ReactNode;
  afterDiagnostics?: ReactNode;
  beforeDiagnostics?: ReactNode;
  breadcrumbs?: { href?: string; label: string }[];
  description: string;
  report: DeploymentDiagnostics;
  // The logical retained payload (`total_retained_bytes` from
  // `/_ref/dataset/summary`), rendered beside the physical footprint as a
  // labeled comparison. Optional: when omitted the comparison line is hidden
  // rather than guessed. Never combined with the physical size.
  retainedBytes?: number | null;
  title?: string;
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
  report,
  retainedBytes,
  title = "Deployment",
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
          retainedBytes={retainedBytes}
        />
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
  return Boolean(
    report.lexical.index.backfill_progress ||
      report.semantic.index.backfill_progress ||
      report.semantic.index.state === "building"
  );
}

const WARNING_TITLES: Record<DeploymentDiagnostics["warnings"][number]["code"], string> = {
  zero_participation: "Zero semantic participation",
  lexical_building_index: "Lexical index is rebuilding",
  building_index: "Semantic index is rebuilding",
  stale_index: "Semantic index is stale",
  backend_unavailable: "Embedding backend unavailable",
  missing_model_cache: "Embedding model cache missing",
  download_disabled: "Model download disabled",
  vector_index_fallback: "Using blob-flat vector fallback",
  browser_connectors_need_collector: "Browser-backed connectors need a local collector",
  collector_protocol_outdated: "Local collector protocol is outdated",
  low_disk_headroom: "Disk headroom is low",
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
  return (
    <Section title="Semantic backend">
      {renderSemanticBackfillProgress(index)}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
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
  retainedBytes,
}: {
  database: DeploymentDiagnostics["database"];
  indexKind: DeploymentDiagnostics["semantic"]["index"]["kind"];
  retainedBytes?: number | null;
}) {
  const footprint = buildStorageFootprintModel(database, retainedBytes);
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
    </Section>
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
