import { LivePoller } from "../components/live-poller.tsx";
import { Callout, PageHeader, Section } from "../components/primitives.tsx";
import { DashboardShell, EmptyState, ServerUnreachable } from "../components/shell.tsx";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import { type DeploymentDiagnostics, getDeploymentDiagnostics } from "../lib/ref-client.ts";

export const dynamic = "force-dynamic";

// Operator-facing diagnostics for the reference deployment. Not a PDPP
// protocol surface — this page consumes /_ref/deployment and renders the
// report the RS already redacted. The goal is "why isn't retrieval working"
// answered in one glance, without the operator reading logs or SSHing in.
//
// Spec: openspec/changes/make-semantic-retrieval-operational/
//       specs/reference-implementation-architecture/spec.md
export default async function DeploymentPage() {
  let report: DeploymentDiagnostics | null = null;
  let unreachable = false;
  try {
    report = await getDeploymentDiagnostics();
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      unreachable = true;
    } else {
      throw err;
    }
  }

  if (unreachable || !report) {
    return (
      <DashboardShell active="deployment">
        <ServerUnreachable />
      </DashboardShell>
    );
  }

  return (
    <DashboardShell active="deployment">
      <LivePoller enabled={isDeploymentIndexing(report)} />
      <PageHeader
        breadcrumbs={[{ href: "/dashboard", label: "Dashboard" }, { label: "Deployment" }]}
        description="Operator diagnostics for the reference retrieval surfaces. Read-only. Secret environment values are redacted before reaching this page."
        title="Deployment"
      />

      <WarningsSection warnings={report.warnings} />
      <LexicalSection report={report} />
      <SemanticSection report={report} />
      <ParticipationSection participation={report.semantic.participation} />
      <ManifestsSection manifests={report.manifests} />
      <DatabaseSection database={report.database} indexKind={report.semantic.index.kind} />
      <EnvironmentSection environment={report.environment} />
    </DashboardShell>
  );
}

function isDeploymentIndexing(report: DeploymentDiagnostics): boolean {
  return Boolean(
    report.lexical.index.backfill_progress ||
      report.semantic.index.backfill_progress ||
      report.semantic.index.state === "building"
  );
}

// ─── Warnings ──────────────────────────────────────────────────────────────

const WARNING_TITLES: Record<DeploymentDiagnostics["warnings"][number]["code"], string> = {
  zero_participation: "Zero semantic participation",
  lexical_building_index: "Lexical index is rebuilding",
  building_index: "Semantic index is rebuilding",
  stale_index: "Semantic index is stale",
  backend_unavailable: "Embedding backend unavailable",
  missing_model_cache: "Embedding model cache missing",
  download_disabled: "Model download disabled",
  vector_index_fallback: "Using blob-flat vector fallback",
};

function WarningsSection({ warnings }: { warnings: DeploymentDiagnostics["warnings"] }) {
  if (warnings.length === 0) {
    return (
      <Section title="Warnings">
        <p className="pdpp-body text-muted-foreground">No warnings. Retrieval looks operational.</p>
      </Section>
    );
  }
  return (
    <Section title={`Warnings (${warnings.length})`}>
      <div className="flex flex-col gap-3">
        {warnings.map((warning) => (
          <Callout
            description={warning.message}
            key={warning.code}
            surface="human"
            title={WARNING_TITLES[warning.code]}
          />
        ))}
      </div>
    </Section>
  );
}

// ─── Retrieval indexes ─────────────────────────────────────────────────────

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
  const streamLabel = progress.stream
    ? `${shortConnectorName(progress.connector_id)} / ${progress.stream}`
    : shortConnectorName(progress.connector_id);
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
        {indexedCount.toLocaleString()} {indexedLabel} · updated {formatTime(progress.updated_at)}
        {progress.active_jobs > 1 ? ` · ${progress.active_jobs} active jobs` : ""}
      </p>
    </div>
  );
}

// ─── Participation ─────────────────────────────────────────────────────────

function ParticipationSection({
  participation,
}: {
  participation: DeploymentDiagnostics["semantic"]["participation"];
}) {
  return (
    <Section
      description="Every (connector, stream, field) that contributes to semantic retrieval. Derived from loaded manifests — changing a manifest's semantic_fields updates this list after restart or reconciliation."
      title={`Participation (${participation.field_count} fields across ${participation.connector_count} connectors)`}
    >
      {participation.tuples.length === 0 ? (
        <EmptyState
          hint="No loaded manifest declares query.search.semantic_fields. Until at least one stream participates, semantic retrieval returns empty results even if the backend and index are ready."
          title="No participating fields"
        />
      ) : (
        <table className="w-full border-border/80 border-y text-left text-sm">
          <thead>
            <tr className="text-muted-foreground text-xs uppercase tracking-wide">
              <th className="px-2 py-2 font-medium">Connector</th>
              <th className="px-2 py-2 font-medium">Stream</th>
              <th className="px-2 py-2 font-medium">Field</th>
              <th className="px-2 py-2 font-medium">Provenance</th>
            </tr>
          </thead>
          <tbody>
            {participation.tuples.map((t) => (
              <tr className="border-border/60 border-t" key={`${t.connector_id}::${t.stream}::${t.field}`}>
                <td className="px-2 py-1.5 font-mono text-xs">{t.connector_id}</td>
                <td className="px-2 py-1.5">{t.stream}</td>
                <td className="px-2 py-1.5 font-mono text-xs">{t.field}</td>
                <td className="px-2 py-1.5 text-muted-foreground text-xs">{t.provenance}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

// ─── Manifests ─────────────────────────────────────────────────────────────

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
                <td className="px-2 py-1.5 font-mono text-xs">{m.connector_id}</td>
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

// ─── Database + vector index ───────────────────────────────────────────────

function DatabaseSection({
  database,
  indexKind,
}: {
  database: DeploymentDiagnostics["database"];
  indexKind: DeploymentDiagnostics["semantic"]["index"]["kind"];
}) {
  return (
    <Section title="Database">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        <Field label="Path" value={database.path} />
        <Field label="Vector index kind" value={indexKind ?? "—"} />
      </dl>
    </Section>
  );
}

// ─── Environment ───────────────────────────────────────────────────────────

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

// ─── Formatting helpers ────────────────────────────────────────────────────

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

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString();
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

function shortConnectorName(connectorId: string): string {
  try {
    const url = new URL(connectorId);
    return url.pathname.split("/").filter(Boolean).at(-1) ?? connectorId;
  } catch {
    return connectorId;
  }
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
