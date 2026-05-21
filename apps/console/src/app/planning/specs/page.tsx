import type { Metadata } from "next";
import { PageHeader } from "@/app/dashboard/components/primitives.tsx";
import { ArtifactLink } from "@/components/docs/artifact-link.tsx";
import { DocsLayout } from "@/components/docs/docs-layout.tsx";
import { buildPlanningSidebarSections } from "@/components/planning/sidebar-sections.ts";
import { listOpenSpecSpecs } from "@/lib/openspec/index.ts";
import { PLANNING_LABEL, planningPath } from "@/lib/openspec/public.ts";

export const metadata: Metadata = {
  title: `Capability specs — ${PLANNING_LABEL} — PDPP`,
  description: "All capability specifications under openspec/specs/.",
};

export default async function OpenSpecSpecsPage() {
  const specs = await listOpenSpecSpecs();
  const sections = buildPlanningSidebarSections({ kind: "specs" });

  return (
    <DocsLayout sections={sections}>
      <PageHeader
        breadcrumbs={[{ href: planningPath(), label: PLANNING_LABEL }, { label: "Specs" }]}
        description={
          <>
            Durable capability specifications under <code className="font-mono text-xs">openspec/specs/</code>.
          </>
        }
        title="Capability specs"
      />

      {specs.length === 0 ? (
        <div className="flex flex-col items-start gap-1.5 py-2">
          <div className="font-medium text-foreground/80">No specs found</div>
          <div className="pdpp-body text-muted-foreground">There are currently no entries under openspec/specs/.</div>
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-border/60">
          {specs.map((s) => (
            <ArtifactLink
              excerpt={s.excerpt}
              eyebrow={s.capability}
              footer={
                s.relatedChanges.length > 0 ? (
                  <span>
                    active in: <span className="font-mono">{s.relatedChanges.join(", ")}</span>
                  </span>
                ) : (
                  <span className="opacity-70">no active changes</span>
                )
              }
              href={planningPath(`/specs/${s.capability}`)}
              key={s.capability}
              title={s.title}
            />
          ))}
        </div>
      )}
    </DocsLayout>
  );
}
