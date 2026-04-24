import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OpenSpecBreadcrumbs } from "@/components/openspec/open-spec-breadcrumbs.tsx";
import { OpenSpecMarkdownPage } from "@/components/openspec/open-spec-markdown-page.tsx";
import { OpenSpecProgressPill } from "@/components/openspec/open-spec-progress-pill.tsx";
import { OpenSpecShell } from "@/components/openspec/open-spec-shell.tsx";
import { OpenSpecSourceLink } from "@/components/openspec/open-spec-source-link.tsx";
import { buildOpenSpecSidebarSections } from "@/components/openspec/sidebar-sections.ts";
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
  const { change } = await params;
  const [artifact, summary] = await Promise.all([
    getOpenSpecChangeArtifact(change, "tasks"),
    getOpenSpecChange(change),
  ]);
  if (!(artifact && summary)) {
    notFound();
  }

  const sections = buildOpenSpecSidebarSections({
    kind: "change",
    changeName: change,
    artifact: "tasks",
  });

  return (
    <OpenSpecShell sections={sections}>
      <article className="flex flex-col gap-6">
        <OpenSpecBreadcrumbs
          crumbs={[
            { label: PLANNING_LABEL, href: planningPath() },
            { label: "Changes", href: planningPath("/changes") },
            { label: change, href: planningPath(`/changes/${change}`) },
            { label: "Tasks" },
          ]}
        />
        <header className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-semibold text-[clamp(1.6rem,2.8vw,2.05rem)] leading-tight tracking-tight">
              {artifact.title}
            </h1>
            <OpenSpecProgressPill completed={summary.completedTasks} total={summary.totalTasks} />
          </div>
          <OpenSpecSourceLink
            createdAt={artifact.createdAt}
            lastModified={artifact.lastModified}
            repoRelativePath={artifact.repoRelativePath}
          />
        </header>
        <OpenSpecMarkdownPage markdown={artifact.markdown} />
      </article>
    </OpenSpecShell>
  );
}
