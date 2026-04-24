import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  buildOpenSpecSidebarSections,
  OpenSpecBreadcrumbs,
  OpenSpecMarkdownPage,
  OpenSpecShell,
  OpenSpecSourceLink,
} from "@/components/openspec/index.ts";
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
  const { change } = await params;
  const artifact = await getOpenSpecChangeArtifact(change, "design");
  if (!artifact) {
    notFound();
  }
  const sections = buildOpenSpecSidebarSections({
    kind: "change",
    changeName: change,
    artifact: "design",
  });

  return (
    <OpenSpecShell sections={sections}>
      <article className="flex flex-col gap-6">
        <OpenSpecBreadcrumbs
          crumbs={[
            { label: PLANNING_LABEL, href: planningPath() },
            { label: "Changes", href: planningPath("/changes") },
            { label: change, href: planningPath(`/changes/${change}`) },
            { label: "Design" },
          ]}
        />
        <header className="flex flex-col gap-3">
          <h1 className="font-semibold text-[clamp(1.6rem,2.8vw,2.05rem)] leading-tight tracking-tight">
            {artifact.title}
          </h1>
          <OpenSpecSourceLink
            repoRelativePath={artifact.repoRelativePath}
            createdAt={artifact.createdAt}
            lastModified={artifact.lastModified}
          />
        </header>
        <OpenSpecMarkdownPage markdown={artifact.markdown} />
      </article>
    </OpenSpecShell>
  );
}
