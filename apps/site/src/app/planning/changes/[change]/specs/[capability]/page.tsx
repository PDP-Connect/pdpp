import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/app/dashboard/components/primitives.tsx";
import { DocsLayout } from "@/components/docs/docs-layout.tsx";
import { ProsePage } from "@/components/docs/prose-page.tsx";
import { SourceLink } from "@/components/docs/source-link.tsx";
import { buildPlanningSidebarSections } from "@/components/planning/sidebar-sections.ts";
import {
  getOpenSpecChange,
  getOpenSpecChangeSpecDelta,
  listOpenSpecChangeSpecDeltas,
  listOpenSpecChanges,
} from "@/lib/openspec/index.ts";
import { PLANNING_LABEL, planningPath } from "@/lib/openspec/public.ts";

interface PageProps {
  params: Promise<{ change: string; capability: string }>;
}

export async function generateStaticParams() {
  const changes = await listOpenSpecChanges();
  const params: Array<{ change: string; capability: string }> = [];
  await Promise.all(
    changes.map(async (c) => {
      const deltas = await listOpenSpecChangeSpecDeltas(c.name);
      for (const d of deltas) {
        params.push({ change: c.name, capability: d.capability });
      }
    })
  );
  return params;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { change, capability } = await params;
  const artifact = await getOpenSpecChangeSpecDelta(change, capability);
  if (!artifact) {
    return { title: `Spec delta not found — ${PLANNING_LABEL} — PDPP` };
  }
  return {
    title: `${artifact.title} — ${change} — ${PLANNING_LABEL} — PDPP`,
    description: artifact.excerpt ?? undefined,
  };
}

export default async function ChangeSpecDeltaPage({ params }: PageProps) {
  const { change: changeName, capability } = await params;
  const [artifact, change] = await Promise.all([
    getOpenSpecChangeSpecDelta(changeName, capability),
    getOpenSpecChange(changeName),
  ]);
  if (!(artifact && change)) {
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
          { href: planningPath(`/changes/${changeName}`), label: change.title },
          { href: planningPath(`/changes/${changeName}/specs`), label: "Spec Deltas" },
          { label: capability },
        ]}
        meta={
          <SourceLink
            createdAt={artifact.createdAt}
            lastModified={artifact.lastModified}
            repoRelativePath={artifact.repoRelativePath}
          />
        }
        title={artifact.title}
      />
      <ProsePage markdown={artifact.markdown} />
    </DocsLayout>
  );
}
