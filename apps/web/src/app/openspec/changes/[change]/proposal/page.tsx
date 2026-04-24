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
  return changes.filter((c) => c.hasProposal).map((c) => ({ change: c.name }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { change } = await params;
  const summary = await getOpenSpecChange(change);
  if (!summary) {
    return { title: `Proposal not found — ${PLANNING_LABEL} — PDPP` };
  }
  return {
    title: `${summary.title} — Proposal — ${PLANNING_LABEL} — PDPP`,
    description: summary.proposalExcerpt ?? summary.excerpt ?? undefined,
  };
}

export default async function ChangeProposalPage({ params }: PageProps) {
  const { change } = await params;
  const artifact = await getOpenSpecChangeArtifact(change, "proposal");
  if (!artifact) {
    notFound();
  }
  const sections = buildOpenSpecSidebarSections({
    kind: "change",
    changeName: change,
    artifact: "proposal",
  });

  return (
    <OpenSpecShell sections={sections}>
      <article className="flex flex-col gap-6">
        <OpenSpecBreadcrumbs
          crumbs={[
            { label: PLANNING_LABEL, href: planningPath() },
            { label: "Changes", href: planningPath("/changes") },
            { label: change, href: planningPath(`/changes/${change}`) },
            { label: "Proposal" },
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
