// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants, IcButton, IcInput } from "@pdpp/brand-react";
import { Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import type { ConnectorAcquisitionPath, ConnectorCatalogEntry } from "../lib/connection-catalog.ts";
import type { RefCountState } from "../lib/ref-client.ts";
import {
  sourceSetupAction,
  sourceSetupAvailability,
  sourceSetupContext,
  sourceSetupGuidance,
  isRunnableAddOffer,
  sourceSetupRank,
  sourceSetupSecondaryAction,
  sourceSetupStatus,
} from "../lib/source-setup-presentation.ts";
import { formatTotalRecordsLabel } from "../lib/total-records-label.ts";

export interface ExistingSourceSetupLink {
  connectionId: string;
  displayName: string;
  latestImportFile: string | null;
  latestImportStatus: string | null;
  status: string | null;
  totalRecords: number;
  /**
   * Orthogonal state for `totalRecords` (Sol fourth-verdict P1.3).
   * `undefined` for a reference predating this field, preserving the exact
   * prior always-numeric rendering below.
   */
  totalRecordsState?: RefCountState;
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
      <p className="pdpp-eyebrow mb-1 text-muted-foreground">Ways to add data</p>
      <ul className="grid gap-2">
        {visible.map((path) => (
          <SourceAcquisitionPathRow key={`${path.posture}:${path.label}`} path={path} />
        ))}
      </ul>
      {secondary.length > 0 ? (
        <details className="group mt-2">
          <summary className="pdpp-caption cursor-pointer list-none text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground">
            Other ways to add data
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
  if (sourceSetupAvailability(entry) === "not_available_here") {
    return "No proven setup path is available in this dashboard.";
  }
  if (entry.modality === "browser_bound" && entry.setupModality === "static_secret") {
    return "Connect in a secure browser; interactive sign-in is valid, with optional saved details for repair.";
  }
  switch (entry.disposition) {
    case "local_collector_enroll":
      return "Run the local collector on the machine that has this data.";
    case "static_secret_connect":
      return "Enter the provider credential for this account.";
    case "static_secret_experimental":
      return "Enter the provider credential for this account. Preview: not yet live-validated.";
    case "provider_auth_connect":
      return "Authorize this account through the provider.";
    case "manual_upload_connect":
      return existingSourceCount > 0
        ? `${existingSourceCount} existing ${existingSourceCount === 1 ? "source" : "sources"} can receive another export; choose on the import page.`
        : "Owner-exported file import.";
    case "provider_auth_deployment_blocked":
      return "This source needs provider authorization. Configure provider settings before adding an account.";
    case "browser_collector_manual":
    case "browser_bound_runbook":
      return entry.disposition === "browser_collector_manual"
        ? "Connect account from a secure browser session."
        : "Browser setup is not available in this dashboard yet.";
    default:
      return "No setup path is available in this dashboard.";
  }
}

function SourceSetupContext({ entry }: { entry: ConnectorCatalogEntry }) {
  const context = sourceSetupContext(entry);
  if (!context) {
    return null;
  }
  return (
    <p
      className="pdpp-caption mt-2 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 text-muted-foreground"
      data-testid="source-setup-context"
    >
      {context}
    </p>
  );
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
                  {formatTotalRecordsLabel(source.totalRecords, source.totalRecordsState, "records")}
                  {latestFact ? ` · ${latestFact}` : ""}
                </p>
                {source.latestImportFile ? (
                  <p className="pdpp-caption truncate text-muted-foreground">{source.latestImportFile}</p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                <Link
                  className={buttonVariants({ size: "sm", variant: "ghost" })}
                  href={sourceRecordsHref(source.connectionId)}
                >
                  Open in Explore
                </Link>
                <Link
                  className={buttonVariants({ size: "sm", variant: "ghost" })}
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

function SourceExternalDocs({ entry }: { entry: ConnectorCatalogEntry }) {
  if (entry.externalDocs.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      <span className="pdpp-caption text-muted-foreground">Provider documentation:</span>
      {entry.externalDocs.map((doc) => (
        <a
          className="pdpp-caption text-foreground underline underline-offset-4"
          href={doc.url}
          key={`${entry.connectorKey}:${doc.url}`}
          rel="noreferrer"
          target="_blank"
          title="Opens in a new tab"
        >
          {doc.label} (opens in a new tab)
        </a>
      ))}
    </div>
  );
}

function SourceSetupDetails({ entry }: { entry: ConnectorCatalogEntry }) {
  const guidance = sourceSetupGuidance(entry);
  const hasRichImportDetail = entry.disposition === "manual_upload_connect" && entry.acquisitionPaths.length > 0;

  if (!hasRichImportDetail && entry.externalDocs.length === 0) {
    return null;
  }

  return (
    <details className="group mt-2" data-testid="source-setup-details">
      <summary className="pdpp-caption cursor-pointer list-none text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground">
        {hasRichImportDetail ? "Show import options" : "Provider documentation"}
      </summary>
      <div className="mt-2 grid gap-2">
        {hasRichImportDetail ? (
          <>
            <p className="pdpp-caption text-muted-foreground">{guidance}</p>
            <SourceAcquisitionPaths paths={entry.acquisitionPaths} />
          </>
        ) : null}
        <SourceExternalDocs entry={entry} />
      </div>
    </details>
  );
}

function SourceSetupCard({
  entry,
  existingSources,
}: {
  entry: ConnectorCatalogEntry;
  existingSources: readonly ExistingSourceSetupLink[];
}) {
  const status = sourceSetupStatus(entry);
  const action = sourceSetupAction(entry);
  const secondaryAction = sourceSetupSecondaryAction(entry);
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
        <SourceSetupContext entry={entry} />
        <ExistingSourceLinks connectorKey={entry.connectorKey} sources={existingSources} />
        <SourceSetupDetails entry={entry} />
      </div>
      <div className="flex flex-col items-end justify-start gap-1">
        {action ? (
          <>
            <span className="pdpp-eyebrow text-muted-foreground">Next step</span>
            <Link className={buttonVariants({ size: "sm", variant: "default" })} href={action.href}>
              {action.label}
            </Link>
            {secondaryAction ? (
              <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href={secondaryAction.href}>
                {secondaryAction.label}
              </Link>
            ) : null}
          </>
        ) : null}
      </div>
    </li>
  );
}

function ExperimentalSetupSummary({
  entries,
  existingSourcesByConnector,
}: {
  entries: readonly ConnectorCatalogEntry[];
  existingSourcesByConnector?: Readonly<Record<string, readonly ExistingSourceSetupLink[]>>;
}) {
  if (entries.length === 0) {
    return null;
  }
  return (
    <details className="rounded-sm border border-border/80 bg-muted/20 p-3" data-testid="experimental-setup-summary">
      <summary className="pdpp-caption cursor-pointer text-muted-foreground">Preview ({entries.length})</summary>
      <div className="mt-3 grid gap-3">
        <p className="pdpp-caption text-muted-foreground">
          These setup paths are implemented but have not completed live validation. Test them with non-critical data.
        </p>
        <SourceSetupCardList entries={entries} existingSourcesByConnector={existingSourcesByConnector} />
      </div>
    </details>
  );
}

function SourceSetupCardList({
  entries,
  existingSourcesByConnector,
}: {
  entries: readonly ConnectorCatalogEntry[];
  existingSourcesByConnector?: Readonly<Record<string, readonly ExistingSourceSetupLink[]>>;
}) {
  return (
    <ul className="grid gap-3">
      {entries.map((entry) => (
        <SourceSetupCard
          entry={entry}
          existingSources={existingSourcesByConnector?.[entry.connectorKey] ?? []}
          key={entry.connectorKey}
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
  /**
   * Built from `listConnectionsByConnector` (one exact `GET
   * /_ref/connections?connector_id=` call per catalog entry) — the full
   * owner-scoped set for each connector, never a fleet page filtered
   * client-side. There is no "incomplete" state to render here: each
   * connector's existing-sources list is exact by construction.
   */
  existingSourcesByConnector?: Readonly<Record<string, readonly ExistingSourceSetupLink[]>>;
  query: string;
}) {
  const filtered = filterSourceCatalog(catalog, query);
  const available = filtered.filter((entry) => entry.publicTier === "supported" && isRunnableAddOffer(entry));
  const experimental = filtered.filter((entry) => entry.publicTier === "preview" && isRunnableAddOffer(entry));
  const actionable = [...available, ...experimental];
  return (
    <Section description="Add sources this dashboard can set up now." title="Add data">
      <form action={action} className="mb-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <label className="sr-only" htmlFor="source_q">
          Search data sources
        </label>
        <IcInput defaultValue={query} id="source_q" name="source_q" placeholder="Search source name or connector key" />
        <IcButton size="sm" type="submit" variant="ghost">
          Search
        </IcButton>
      </form>
      {actionable.length > 0 ? (
        <div className="grid gap-5">
          {available.length > 0 ? (
            <SourceSetupCardList entries={available} existingSourcesByConnector={existingSourcesByConnector} />
          ) : (
            <p className="pdpp-caption rounded-md border border-border/80 border-dashed p-4 text-muted-foreground">
              No add-now sources match <span className="font-medium text-foreground">{query}</span>.
            </p>
          )}

          <ExperimentalSetupSummary entries={experimental} existingSourcesByConnector={existingSourcesByConnector} />
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
