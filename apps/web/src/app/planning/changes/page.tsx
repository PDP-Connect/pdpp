import type { Metadata } from "next";
import { ARTIFACT_LIFECYCLE_VOCABULARY, PageHeader, StatusBadge } from "@/app/dashboard/components/primitives.tsx";
import { ArtifactLink } from "@/components/docs/artifact-link.tsx";
import { DocsLayout } from "@/components/docs/docs-layout.tsx";
import { buildPlanningSidebarSections } from "@/components/planning/sidebar-sections.ts";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { listOpenSpecChanges } from "@/lib/openspec/index.ts";
import { PLANNING_LABEL, planningPath } from "@/lib/openspec/public.ts";

export const metadata: Metadata = {
  title: `Changes — ${PLANNING_LABEL} — PDPP`,
  description: "All discovered official change entries for the PDPP reference implementation.",
};

export default async function OpenSpecChangesPage() {
  const changes = await listOpenSpecChanges();
  // Use the overview scope and force the Changes item active — there's no specific change
  // selected on the index page, so the per-change subnav doesn't apply yet.
  const sections = buildPlanningSidebarSections({ kind: "overview" }).map((section) => ({
    ...section,
    items: section.items.map((item) => (item.href === planningPath("/changes") ? { ...item, active: true } : item)),
  }));

  return (
    <DocsLayout sections={sections}>
      <PageHeader
        breadcrumbs={[{ href: planningPath(), label: PLANNING_LABEL }, { label: "Changes" }]}
        description={
          <>
            All discovered entries under <code className="font-mono text-xs">openspec/changes/</code>. Sorted by status,
            then by most recently modified.
          </>
        }
        title="Changes"
      />

      {changes.length === 0 ? (
        <div className="flex flex-col items-start gap-1.5 py-2">
          <div className="font-medium text-foreground/80">No changes found</div>
          <div className="pdpp-body text-muted-foreground">There are currently no entries under openspec/changes/.</div>
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-border/60">
          {changes.map((c) => (
            <ArtifactLink
              excerpt={c.excerpt}
              eyebrow={c.name}
              footer={
                <>
                  <span className="font-mono">
                    {c.totalTasks > 0 ? `${c.completedTasks}/${c.totalTasks} tasks` : "no tasks"}
                  </span>
                  {c.affectedCapabilities.length > 0 && (
                    <span>
                      affects: <span className="font-mono">{c.affectedCapabilities.join(", ")}</span>
                    </span>
                  )}
                  {c.lastModified && (
                    <span className="inline-flex items-baseline gap-1">
                      updated <Timestamp precision="date" value={c.lastModified} valueKind="calendar-date" />
                    </span>
                  )}
                </>
              }
              href={planningPath(`/changes/${c.name}`)}
              key={c.name}
              meta={<StatusBadge status={c.status} vocabulary={ARTIFACT_LIFECYCLE_VOCABULARY} />}
              title={c.title}
            />
          ))}
        </div>
      )}
    </DocsLayout>
  );
}
