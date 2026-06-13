import { Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import type { ConnectorAcquisitionPath, ConnectorCatalogEntry } from "../lib/connection-catalog.ts";
import {
  sourceSetupAction,
  sourceSetupGuidance,
  sourceSetupRank,
  sourceSetupStatus,
} from "../lib/source-setup-presentation.ts";

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
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700";
  }
  if (path.posture === "advanced") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700";
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

function SourceSetupCard({ entry }: { entry: ConnectorCatalogEntry }) {
  const status = sourceSetupStatus(entry);
  const action = sourceSetupAction(entry);
  const guidance = sourceSetupGuidance(entry);
  return (
    <li
      className="grid gap-3 rounded-md border border-border/80 bg-card p-4 lg:grid-cols-[minmax(0,1fr)_auto]"
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
        {/* Low-noise path to detail: the support reasoning stays one disclosure away. */}
        <details className="group mt-1">
          <summary className="pdpp-caption cursor-pointer list-none text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground">
            Why this, and what to expect
          </summary>
          <p className="pdpp-caption mt-1 text-muted-foreground">{guidance}</p>
        </details>
        <SourceAcquisitionPaths paths={entry.acquisitionPaths} />
      </div>
      <div className="flex flex-col items-end justify-start gap-1">
        {action ? (
          <>
            <span className="pdpp-eyebrow text-muted-foreground">Recommended next</span>
            <Link className={buttonVariants({ variant: "default", size: "sm" })} href={action.href}>
              {action.label}
            </Link>
          </>
        ) : (
          <span className="pdpp-caption rounded-md border border-border/70 bg-muted/20 px-2.5 py-1 text-muted-foreground">
            No setup action yet
          </span>
        )}
      </div>
    </li>
  );
}

export function SourceSetupCatalog({
  action,
  catalog,
  query,
}: {
  action: string;
  catalog: readonly ConnectorCatalogEntry[];
  query: string;
}) {
  const filtered = filterSourceCatalog(catalog, query);
  return (
    <Section
      description="Search every source this build knows about. Each card is a source journey: the source name, its recommended next action, the current support fact, and a low-noise path to the details. Repeat the same setup to add another account."
      title="Add data sources"
    >
      <form action={action} className="mb-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <label className="sr-only" htmlFor="source_q">
          Search data sources
        </label>
        <Input defaultValue={query} id="source_q" name="source_q" placeholder="Search source name or connector key" />
        <Button size="sm" type="submit" variant="outline">
          Search
        </Button>
      </form>
      {filtered.length > 0 ? (
        <ul className="grid gap-3">
          {filtered.map((entry) => (
            <SourceSetupCard entry={entry} key={entry.connectorKey} />
          ))}
        </ul>
      ) : (
        <p className="pdpp-caption rounded-md border border-border/80 border-dashed p-4 text-muted-foreground">
          No connector matched <span className="font-medium text-foreground">{query}</span>. Try the source name or
          connector key.
        </p>
      )}
    </Section>
  );
}
