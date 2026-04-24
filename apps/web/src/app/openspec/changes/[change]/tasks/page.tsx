import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MetaPill, PageHeader } from "@/app/dashboard/components/primitives.tsx";
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
  return changes.filter((c) => c.hasTasks).map((c) => ({ change: c.name }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { change } = await params;
  const summary = await getOpenSpecChange(change);
  if (!summary) {
    return { title: `Tasks not found — ${PLANNING_LABEL} — PDPP` };
  }
  return {
    title: `${summary.title} — Tasks — ${PLANNING_LABEL} — PDPP`,
  };
}

export default async function ChangeTasksPage({ params }: PageProps) {
  const { change: changeName } = await params;
  const [artifact, summary] = await Promise.all([
    getOpenSpecChangeArtifact(changeName, "tasks"),
    getOpenSpecChange(changeName),
  ]);
  if (!(artifact && summary)) {
    notFound();
  }

  const sections = buildPlanningSidebarSections({
    kind: "change",
    changeName,
    artifact: "tasks",
  });

  return (
    <DocsLayout sections={sections}>
      <PageHeader
        breadcrumbs={[
          { href: planningPath(), label: PLANNING_LABEL },
          { href: planningPath("/changes"), label: "Changes" },
          { href: planningPath(`/changes/${changeName}`), label: summary.title },
          { label: "Tasks" },
        ]}
        meta={
          <>
            <MetaPill label="tasks" value={`${summary.completedTasks}/${summary.totalTasks}`} />
            <SourceLink
              createdAt={artifact.createdAt}
              lastModified={artifact.lastModified}
              repoRelativePath={artifact.repoRelativePath}
            />
          </>
        }
        title={artifact.title}
      />
      <ProsePage markdown={artifact.markdown} />
    </DocsLayout>
  );
}
