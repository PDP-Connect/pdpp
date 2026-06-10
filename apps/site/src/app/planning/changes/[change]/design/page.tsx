import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocsLayout } from "@/components/docs/docs-layout.tsx";
import { ProsePage } from "@/components/docs/prose-page.tsx";
import { SourceLink } from "@/components/docs/source-link.tsx";
import { buildPlanningSidebarSections } from "@/components/planning/sidebar-sections.ts";
import { getOpenSpecChange, getOpenSpecChangeArtifact, listOpenSpecChanges } from "@/lib/openspec/index.ts";
import { PLANNING_LABEL, planningPath } from "@/lib/openspec/public.ts";

interface PageProps {
  params: Promise<{ change: string }>;
}

export async function generateStaticParams() {
  const changes = await listOpenSpecChanges();
  return changes.filter((c) => c.hasDesign).map((c) => ({ change: c.name }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { change } = await params;
  const summary = await getOpenSpecChange(change);
  if (!summary) {
    return { title: `Design not found — ${PLANNING_LABEL} — PDPP` };
  }
  return {
    title: `${summary.title} — Design — ${PLANNING_LABEL} — PDPP`,
    description: summary.designExcerpt ?? summary.excerpt ?? undefined,
  };
}

export default async function ChangeDesignPage({ params }: PageProps) {
  const { change: changeName } = await params;
  const [artifact, change] = await Promise.all([
    getOpenSpecChangeArtifact(changeName, "design"),
    getOpenSpecChange(changeName),
  ]);
  if (!(artifact && change)) {
    notFound();
  }
  const sections = buildPlanningSidebarSections({
    kind: "change",
    changeName,
    artifact: "design",
  });

  return (
    <DocsLayout sections={sections}>
      <PageHeader
        breadcrumbs={[
          { href: planningPath(), label: PLANNING_LABEL },
          { href: planningPath("/changes"), label: "Changes" },
          { href: planningPath(`/changes/${changeName}`), label: change.title },
          { label: "Design" },
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
