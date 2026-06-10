import { Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import type { ConnectorCatalogEntry } from "../lib/connection-catalog.ts";
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

function SourceSetupCard({ entry }: { entry: ConnectorCatalogEntry }) {
  const status = sourceSetupStatus(entry);
  const action = sourceSetupAction(entry);
  return (
    <li
      className="grid gap-3 rounded-md border border-border/80 bg-card p-4 lg:grid-cols-[minmax(0,1fr)_auto]"
      data-testid={`source-setup-${entry.connectorKey}`}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="pdpp-title text-foreground">{entry.displayName}</h3>
          <span className={`pdpp-eyebrow rounded border px-1.5 py-0.5 ${status.tone}`}>{status.label}</span>
        </div>
        <p className="pdpp-caption mt-1 text-muted-foreground">{sourceSetupGuidance(entry)}</p>
      </div>
      <div className="flex items-start justify-end gap-2">
        {action ? (
          <Link className={buttonVariants({ variant: "default", size: "sm" })} href={action.href}>
            {action.label}
          </Link>
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
      description="Search every connector this build knows about. Each source shows one status and one next action; repeat the same setup to add another account."
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
