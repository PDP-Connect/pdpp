import type { Metadata } from "next";
import {
  buildOpenSpecSidebarSections,
  OpenSpecArtifactCard,
  OpenSpecBreadcrumbs,
  OpenSpecEmptyState,
  OpenSpecProgressPill,
  OpenSpecShell,
  OpenSpecStatusPill,
} from "@/components/openspec/index.ts";
import { listOpenSpecChanges } from "@/lib/openspec/index.ts";
import { PLANNING_LABEL, planningPath } from "@/lib/openspec/public.ts";

export const metadata: Metadata = {
  title: `Changes — ${PLANNING_LABEL} — PDPP`,
  description: "All discovered official change entries for the PDPP reference implementation.",
};

function formatLastModified(iso: string | null): string | null {
  if (!iso) {
    return null;
  }
  return new Date(iso).toISOString().slice(0, 10);
}

export default async function OpenSpecChangesPage() {
  const changes = await listOpenSpecChanges();
  // Use the overview scope and force the Changes item active — there's no specific change
  // selected on the index page, so the per-change subnav doesn't apply yet.
  const sections = buildOpenSpecSidebarSections({ kind: "overview" }).map((section) => ({
    ...section,
    items: section.items.map((item) => (item.href === planningPath("/changes") ? { ...item, active: true } : item)),
  }));

  return (
    <OpenSpecShell sections={sections}>
      <div className="flex flex-col gap-6">
        <OpenSpecBreadcrumbs crumbs={[{ label: PLANNING_LABEL, href: planningPath() }, { label: "Changes" }]} />
        <header className="flex flex-col gap-2">
          <h1 className="font-semibold text-[clamp(1.6rem,2.8vw,2.05rem)] leading-tight tracking-tight">Changes</h1>
          <p className="pdpp-body max-w-3xl text-muted-foreground">
            All discovered entries under <code className="font-mono text-xs">openspec/changes/</code>. Sorted by status,
            then by most recently modified.
          </p>
        </header>

        {changes.length === 0 ? (
          <OpenSpecEmptyState
            title="No changes found"
            description="There are currently no entries under openspec/changes/."
          />
        ) : (
          <div className="flex flex-col divide-y divide-border/60">
            {changes.map((c) => {
              const last = formatLastModified(c.lastModified);
              return (
                <OpenSpecArtifactCard
                  key={c.name}
                  href={planningPath(`/changes/${c.name}`)}
                  eyebrow={c.name}
                  title={c.title}
                  excerpt={c.excerpt}
                  meta={<OpenSpecStatusPill status={c.status} />}
                  footer={
                    <>
                      <OpenSpecProgressPill completed={c.completedTasks} total={c.totalTasks} />
                      {c.affectedCapabilities.length > 0 && (
                        <span>
                          affects: <span className="font-mono">{c.affectedCapabilities.join(", ")}</span>
                        </span>
                      )}
                      {last && <span>updated {last}</span>}
                    </>
                  }
                />
              );
            })}
          </div>
        )}
      </div>
    </OpenSpecShell>
  );
}
