import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buildOpenSpecSidebarSections } from "@/components/openspec/sidebar-sections.ts";
import { OpenSpecArtifactCard } from "@/components/openspec/OpenSpecArtifactCard.tsx";
import { OpenSpecBreadcrumbs } from "@/components/openspec/OpenSpecBreadcrumbs.tsx";
import { OpenSpecEmptyState } from "@/components/openspec/OpenSpecEmptyState.tsx";
import { OpenSpecShell } from "@/components/openspec/OpenSpecShell.tsx";
import { getOpenSpecChange, listOpenSpecChangeSpecDeltas, listOpenSpecChanges } from "@/lib/openspec/index.ts";
import { PLANNING_LABEL, planningPath } from "@/lib/openspec/public.ts";

interface PageProps {
  params: Promise<{ change: string }>;
}

export async function generateStaticParams() {
  const changes = await listOpenSpecChanges();
  return changes.map((c) => ({ change: c.name }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { change } = await params;
  const summary = await getOpenSpecChange(change);
  if (!summary) {
    return { title: `Spec deltas not found — ${PLANNING_LABEL} — PDPP` };
  }
  return { title: `${summary.title} — Spec Deltas — ${PLANNING_LABEL} — PDPP` };
}

export default async function ChangeSpecDeltasPage({ params }: PageProps) {
  const { change } = await params;
  const [summary, deltas] = await Promise.all([getOpenSpecChange(change), listOpenSpecChangeSpecDeltas(change)]);
  if (!summary) {
    notFound();
  }

  const sections = buildOpenSpecSidebarSections({
    kind: "change",
    changeName: change,
    artifact: "spec-deltas",
  });

  return (
    <OpenSpecShell sections={sections}>
      <div className="flex flex-col gap-6">
        <OpenSpecBreadcrumbs
          crumbs={[
            { label: PLANNING_LABEL, href: planningPath() },
            { label: "Changes", href: planningPath("/changes") },
            { label: change, href: planningPath(`/changes/${change}`) },
            { label: "Spec Deltas" },
          ]}
        />
        <header className="flex flex-col gap-2">
          <h1 className="font-semibold text-[clamp(1.6rem,2.8vw,2.05rem)] leading-tight tracking-tight">Spec deltas</h1>
          <p className="pdpp-body max-w-3xl text-muted-foreground">
            Per-capability spec changes proposed by <span className="font-mono">{change}</span>.
          </p>
        </header>

        {deltas.length === 0 ? (
          <OpenSpecEmptyState
            title="No spec deltas in this change"
            description="This change does not propose modifications to any capability spec."
          />
        ) : (
          <div className="flex flex-col divide-y divide-border/60">
            {deltas.map((d) => (
              <OpenSpecArtifactCard
                key={d.capability}
                href={planningPath(`/changes/${change}/specs/${d.capability}`)}
                eyebrow={d.capability}
                title={d.title}
                excerpt={d.excerpt}
              />
            ))}
          </div>
        )}
      </div>
    </OpenSpecShell>
  );
}
