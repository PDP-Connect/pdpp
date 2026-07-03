import { buttonVariants, IcButton, IcInput } from "@pdpp/brand-react";
import { Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import type { ConnectorAcquisitionPath, ConnectorCatalogEntry } from "../lib/connection-catalog.ts";
import {
  sourceSetupAction,
  sourceSetupAvailability,
  sourceSetupGuidance,
  sourceSetupRank,
  sourceSetupStatus,
} from "../lib/source-setup-presentation.ts";

export interface ExistingSourceSetupLink {
  connectionId: string;
  displayName: string;
  latestImportFile: string | null;
  latestImportStatus: string | null;
  status: string | null;
  totalRecords: number;
}

function sortSourceCatalog(catalog: readonly ConnectorCatalogEntry[]): ConnectorCatalogEntry[] {
  return [...catalog].sort((a, b) => {
    const rank = sourceSetupRank(a) - sourceSetupRank(b);
    return rank === 0 ? a.displayName.localeCompare(b.displayName) : rank;
  });
}

function filterSourceCatalog(catalog: readonly ConnectorCatalogEntry[], query: string): ConnectorCatalogEntry[] {
  const needle = query.trim().toLowerCase();
  const sorted = sortSourceCatalog(catalog);
  if (!needle) {
    return sorted;
  }
  return sorted.filter((entry) =>
    [entry.displayName, entry.connectorKey, entry.disposition, entry.setupModality, entry.supportState]
      .join(" ")
      .toLowerCase()
      .includes(needle)
  );
}

function pathTone(path: ConnectorAcquisitionPath): string {
  if (path.posture === "primary") {
    return "border-[color:var(--success)]/30 bg-status-success-bg text-status-success-fg";
  }
  if (path.posture === "advanced") {
    return "border-[color:var(--warning)]/30 bg-status-warning-bg text-status-warning-fg";
  }
  return "border-border bg-muted/30 text-muted-foreground";
}

function SourceAcquisitionPathRow({ path }: { path: ConnectorAcquisitionPath }) {
  return (
    <li
      className="grid gap-1 rounded-md border border-border/70 bg-background/60 p-2"
      data-testid="source-acquisition-path"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="pdpp-caption font-medium text-foreground">{path.label}</span>
        <span className={`pdpp-eyebrow rounded border px-1.5 py-0.5 ${pathTone(path)}`}>{path.posture}</span>
        {path.platform ? <span className="pdpp-caption text-muted-foreground">{path.platform}</span> : null}
      </div>
      {path.detail ? <p className="pdpp-caption text-muted-foreground">{path.detail}</p> : null}
      {path.helpUrl ? (
        <Link className="pdpp-caption text-foreground underline underline-offset-4" href={path.helpUrl}>
          Open source instructions
        </Link>
      ) : null}
    </li>
  );
}

function SourceAcquisitionPaths({ paths }: { paths: readonly ConnectorAcquisitionPath[] }) {
  if (!paths.length) {
    return null;
  }
  const primary = paths.filter((path) => path.posture === "primary");
  const visible = primary.length > 0 ? primary : paths.slice(0, 1);
  const visibleLabels = new Set(visible.map((path) => path.label));
  const secondary = paths.filter((path) => !visibleLabels.has(path.label));
  return (
    <div className="mt-3" data-testid="source-acquisition-paths">
      <p className="pdpp-eyebrow mb-1 text-muted-foreground">Acquisition paths</p>
      <ul className="grid gap-2">
        {visible.map((path) => (
          <SourceAcquisitionPathRow key={`${path.posture}:${path.label}`} path={path} />
        ))}
      </ul>
      {secondary.length > 0 ? (
        <details className="group mt-2">
          <summary className="pdpp-caption cursor-pointer list-none text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground">
            Other ways to add coverage
          </summary>
          <ul className="mt-2 grid gap-2">
            {secondary.map((path) => (
              <SourceAcquisitionPathRow key={`${path.posture}:${path.label}`} path={path} />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function sourceMethodLine(entry: ConnectorCatalogEntry, existingSourceCount: number): string {
  switch (entry.disposition) {
    case "local_collector_enroll":
      return "Local collector on the machine that has this data.";
    case "static_secret_connect":
      return "Provider credential captured by this instance.";
    case "manual_upload_connect":
      return existingSourceCount > 0
        ? `${existingSourceCount} existing ${existingSourceCount === 1 ? "source" : "sources"} can receive another export; choose on the import page.`
        : "Owner-exported file import.";
    case "provider_auth_deployment_blocked":
      return "Server provider settings are required before account setup.";
    case "browser_collector_manual":
    case "browser_bound_runbook":
      return "Browser-backed setup is not packaged in this dashboard yet.";
    default:
      return "No owner-usable setup path in this build.";
  }
}

function sourceDetailHref(connectorKey: string, connectionId: string): string {
  const params = new URLSearchParams({ connection_id: connectionId });
  return `/sources/${encodeURIComponent(connectorKey)}?${params.toString()}`;
}

function sourceRecordsHref(connectionId: string): string {
  const params = new URLSearchParams({ connection: connectionId });
  return `/explore?${params.toString()}`;
}

function ExistingSourceLinks({
  connectorKey,
  sources,
}: {
  connectorKey: string;
  sources: readonly ExistingSourceSetupLink[];
}) {
  if (sources.length === 0) {
    return null;
  }
  return (
    <div
      className="mt-3 grid gap-2 rounded-md border border-border/70 bg-muted/20 p-3"
      data-testid="existing-source-links"
    >
      <p className="pdpp-eyebrow text-muted-foreground">Existing accounts</p>
      <ul className="grid gap-2">
        {sources.map((source) => {
          const latestFact = source.latestImportStatus ?? source.status ?? null;
          return (
            <li
              className="grid gap-2 rounded-sm border border-border/60 bg-background/70 p-2 sm:grid-cols-[minmax(0,1fr)_auto]"
              key={source.connectionId}
            >
              <div className="min-w-0">
                <p className="pdpp-caption font-medium text-foreground">{source.displayName}</p>
                <p className="pdpp-caption text-muted-foreground">
                  {source.totalRecords.toLocaleString()} records
                  {latestFact ? ` · ${latestFact}` : ""}
                </p>
                {source.latestImportFile ? (
                  <p className="pdpp-caption truncate text-muted-foreground">{source.latestImportFile}</p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                <Link
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                  href={sourceRecordsHref(source.connectionId)}
                >
                  Open in Explore
                </Link>
                <Link
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                  href={sourceDetailHref(connectorKey, source.connectionId)}
                >
                  Source details
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SourceSetupDetails({ entry }: { entry: ConnectorCatalogEntry }) {
  const guidance = sourceSetupGuidance(entry);
  const hasRichImportDetail = entry.disposition === "manual_upload_connect" && entry.acquisitionPaths.length > 0;

  if (!hasRichImportDetail) {
    return null;
  }

  return (
    <details className="group mt-2" data-testid="source-setup-details">
      <summary className="pdpp-caption cursor-pointer list-none text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground">
        Show import options
      </summary>
      <div className="mt-2 grid gap-2">
        <p className="pdpp-caption text-muted-foreground">{guidance}</p>
        <SourceAcquisitionPaths paths={entry.acquisitionPaths} />
      </div>
    </details>
  );
}

function SourceSetupCard({
  entry,
  existingSources,
  unavailable,
}: {
  entry: ConnectorCatalogEntry;
  existingSources: readonly ExistingSourceSetupLink[];
  unavailable?: boolean;
}) {
  const status = sourceSetupStatus(entry);
  const action = sourceSetupAction(entry);
  return (
    <li
      className="grid gap-3 rounded-sm border border-border/80 bg-card px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto]"
      data-testid={`source-setup-${entry.connectorKey}`}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="pdpp-title text-foreground">{entry.displayName}</h3>
          {/* Current support / blocked fact, kept distinct from the next action. */}
          <span
            className={`pdpp-eyebrow rounded border px-1.5 py-0.5 ${status.tone}`}
            data-testid="source-support-fact"
          >
            {status.label}
          </span>
        </div>
        <p className="pdpp-caption mt-1 text-muted-foreground">{sourceMethodLine(entry, existingSources.length)}</p>
        <ExistingSourceLinks connectorKey={entry.connectorKey} sources={existingSources} />
        <SourceSetupDetails entry={entry} />
      </div>
      <div className="flex flex-col items-end justify-start gap-1">
        {action ? (
          <>
            <span className="pdpp-eyebrow text-muted-foreground">Next</span>
            <Link className={buttonVariants({ variant: "default", size: "sm" })} href={action.href}>
              {action.label}
            </Link>
          </>
        ) : (
          <span
            className="pdpp-caption rounded-md border border-border/70 bg-muted/20 px-2.5 py-1 text-muted-foreground"
            data-testid="source-unavailable-fact"
          >
            {unavailable ? "Not available from this page" : "No primary action"}
          </span>
        )}
      </div>
    </li>
  );
}

function ServerSetupSummary({ entries }: { entries: readonly ConnectorCatalogEntry[] }) {
  if (entries.length === 0) {
    return null;
  }
  return (
    <details className="rounded-sm border border-border/80 bg-muted/20 p-3" data-testid="server-setup-summary">
      <summary className="pdpp-caption cursor-pointer text-muted-foreground">
        Server settings needed before setup ({entries.length})
      </summary>
      <div className="mt-3 grid gap-3">
        <p className="pdpp-caption text-muted-foreground">
          These sources need provider app settings on this instance before an account can be added.
        </p>
        <ul className="grid gap-2">
          {entries.map((entry) => (
            <li className="flex flex-wrap items-center justify-between gap-2" key={entry.connectorKey}>
              <div className="min-w-0">
                <p className="pdpp-caption font-medium text-foreground">{entry.displayName}</p>
                <p className="pdpp-caption text-muted-foreground">{sourceMethodLine(entry, 0)}</p>
              </div>
              <Link className={buttonVariants({ variant: "ghost", size: "sm" })} href="/deployment">
                Open server settings
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

function UnavailableSourceSummary({ entries }: { entries: readonly ConnectorCatalogEntry[] }) {
  if (entries.length === 0) {
    return null;
  }
  return (
    <ul className="mt-3 grid gap-2" data-testid="unavailable-source-summary">
      {entries.map((entry) => {
        const status = sourceSetupStatus(entry);
        return (
          <li className="flex flex-wrap items-center justify-between gap-2" key={entry.connectorKey}>
            <div className="min-w-0">
              <p className="pdpp-caption font-medium text-foreground">{entry.displayName}</p>
              <p className="pdpp-caption text-muted-foreground">{sourceMethodLine(entry, 0)}</p>
            </div>
            <span className={`pdpp-eyebrow rounded border px-1.5 py-0.5 ${status.tone}`}>{status.label}</span>
          </li>
        );
      })}
    </ul>
  );
}

function SourceSetupCardList({
  entries,
  existingSourcesByConnector,
  unavailable,
}: {
  entries: readonly ConnectorCatalogEntry[];
  existingSourcesByConnector?: Readonly<Record<string, readonly ExistingSourceSetupLink[]>>;
  unavailable?: boolean;
}) {
  return (
    <ul className="grid gap-3">
      {entries.map((entry) => (
        <SourceSetupCard
          entry={entry}
          existingSources={existingSourcesByConnector?.[entry.connectorKey] ?? []}
          key={entry.connectorKey}
          unavailable={unavailable}
        />
      ))}
    </ul>
  );
}

export function SourceSetupCatalog({
  action,
  catalog,
  existingSourcesByConnector,
  query,
}: {
  action: string;
  catalog: readonly ConnectorCatalogEntry[];
  existingSourcesByConnector?: Readonly<Record<string, readonly ExistingSourceSetupLink[]>>;
  query: string;
}) {
  const filtered = filterSourceCatalog(catalog, query);
  const available = filtered.filter((entry) => sourceSetupAvailability(entry) === "available_now");
  const serverSetup = filtered.filter((entry) => sourceSetupAvailability(entry) === "requires_server_setup");
  const unavailable = filtered.filter((entry) => sourceSetupAvailability(entry) === "not_available_here");
  const hasQuery = query.trim().length > 0;
  return (
    <Section
      description="Start with sources this dashboard can add now. Other connector entries are separated so they do not look like available setup paths."
      title="Add data"
    >
      <form action={action} className="mb-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <label className="sr-only" htmlFor="source_q">
          Search data sources
        </label>
        <IcInput defaultValue={query} id="source_q" name="source_q" placeholder="Search source name or connector key" />
        <IcButton size="sm" type="submit" variant="ghost">
          Search
        </IcButton>
      </form>
      {filtered.length > 0 ? (
        <div className="grid gap-5">
          {available.length > 0 ? (
            <SourceSetupCardList entries={available} existingSourcesByConnector={existingSourcesByConnector} />
          ) : (
            <p className="pdpp-caption rounded-md border border-border/80 border-dashed p-4 text-muted-foreground">
              No add-now sources match <span className="font-medium text-foreground">{query}</span>.
            </p>
          )}

          <ServerSetupSummary entries={serverSetup} />

          {unavailable.length > 0 ? (
            <details className="rounded-md border border-border/80 bg-muted/20 p-3" open={hasQuery}>
              <summary className="pdpp-caption cursor-pointer text-muted-foreground">
                Sources not available from this page ({unavailable.length})
              </summary>
              <UnavailableSourceSummary entries={unavailable} />
            </details>
          ) : null}
        </div>
      ) : (
        <p className="pdpp-caption rounded-md border border-border/80 border-dashed p-4 text-muted-foreground">
          No connector matched <span className="font-medium text-foreground">{query}</span>. Try the source name or
          connector key.
        </p>
      )}
    </Section>
  );
}
