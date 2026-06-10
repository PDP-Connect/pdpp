import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArtifactLink } from "@/components/docs/artifact-link.tsx";
import { DocsLayout } from "@/components/docs/docs-layout.tsx";
import { buildPlanningSidebarSections } from "@/components/planning/sidebar-sections.ts";
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
  const { change: changeName } = await params;
  const [summary, deltas] = await Promise.all([
    getOpenSpecChange(changeName),
    listOpenSpecChangeSpecDeltas(changeName),
  ]);
  if (!summary) {
    notFound();
  }

  const sections = buildPlanningSidebarSections({
    kind: "change",
    changeName,
    artifact: "spec-deltas",
  });

  return (
    <DocsLayout sections={sections}>
      <PageHeader
        breadcrumbs={[
          { href: planningPath(), label: PLANNING_LABEL },
          { href: planningPath("/changes"), label: "Changes" },
          { href: planningPath(`/changes/${changeName}`), label: summary.title },
          { label: "Spec Deltas" },
        ]}
        description={
          <>
            Per-capability spec changes proposed by <span className="font-mono">{changeName}</span>.
          </>
        }
        title="Spec deltas"
      />

      {deltas.length === 0 ? (
        <p className="pdpp-body text-muted-foreground">
          This change does not propose modifications to any capability spec.
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-border/60">
          {deltas.map((d) => (
            <ArtifactLink
              excerpt={d.excerpt}
              eyebrow={d.capability}
              href={planningPath(`/changes/${changeName}/specs/${d.capability}`)}
              key={d.capability}
              title={d.title}
            />
          ))}
        </div>
      )}
    </DocsLayout>
  );
}
