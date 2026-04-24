import type { Metadata } from "next";
import { buildOpenSpecSidebarSections } from "@/components/openspec/sidebar-sections.ts";
import { OpenSpecArtifactCard } from "@/components/openspec/OpenSpecArtifactCard.tsx";
import { OpenSpecBreadcrumbs } from "@/components/openspec/OpenSpecBreadcrumbs.tsx";
import { OpenSpecEmptyState } from "@/components/openspec/OpenSpecEmptyState.tsx";
import { OpenSpecShell } from "@/components/openspec/OpenSpecShell.tsx";
import { listOpenSpecSpecs } from "@/lib/openspec/index.ts";
import { PLANNING_LABEL, planningPath } from "@/lib/openspec/public.ts";

export const metadata: Metadata = {
  title: `Capability specs — ${PLANNING_LABEL} — PDPP`,
  description: "All capability specifications under openspec/specs/.",
};

export default async function OpenSpecSpecsPage() {
  const specs = await listOpenSpecSpecs();
  const sections = buildOpenSpecSidebarSections({ kind: "specs" });

  return (
    <OpenSpecShell sections={sections}>
      <div className="flex flex-col gap-6">
        <OpenSpecBreadcrumbs crumbs={[{ label: PLANNING_LABEL, href: planningPath() }, { label: "Specs" }]} />
        <header className="flex flex-col gap-2">
          <h1 className="font-semibold text-[clamp(1.6rem,2.8vw,2.05rem)] leading-tight tracking-tight">
            Capability specs
          </h1>
          <p className="pdpp-body max-w-3xl text-muted-foreground">
            Durable capability specifications under <code className="font-mono text-xs">openspec/specs/</code>.
          </p>
        </header>

        {specs.length === 0 ? (
          <OpenSpecEmptyState
            title="No specs found"
            description="There are currently no entries under openspec/specs/."
          />
        ) : (
          <div className="flex flex-col divide-y divide-border/60">
            {specs.map((s) => (
              <OpenSpecArtifactCard
                key={s.capability}
                href={planningPath(`/specs/${s.capability}`)}
                eyebrow={s.capability}
                title={s.title}
                excerpt={s.excerpt}
                footer={
                  s.relatedChanges.length > 0 ? (
                    <span>
                      active in: <span className="font-mono">{s.relatedChanges.join(", ")}</span>
                    </span>
                  ) : (
                    <span className="opacity-70">no active changes</span>
                  )
                }
              />
            ))}
          </div>
        )}
      </div>
    </OpenSpecShell>
  );
}
