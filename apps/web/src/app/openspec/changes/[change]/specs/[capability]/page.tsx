import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buildOpenSpecSidebarSections } from "@/components/openspec/sidebar-sections.ts";
import { OpenSpecBreadcrumbs } from "@/components/openspec/OpenSpecBreadcrumbs.tsx";
import { OpenSpecMarkdownPage } from "@/components/openspec/OpenSpecMarkdownPage.tsx";
import { OpenSpecShell } from "@/components/openspec/OpenSpecShell.tsx";
import { OpenSpecSourceLink } from "@/components/openspec/OpenSpecSourceLink.tsx";
import { getOpenSpecChangeSpecDelta, listOpenSpecChangeSpecDeltas, listOpenSpecChanges } from "@/lib/openspec/index.ts";
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
  const { change, capability } = await params;
  const artifact = await getOpenSpecChangeSpecDelta(change, capability);
  if (!artifact) {
    notFound();
  }

  const sections = buildOpenSpecSidebarSections({
    kind: "change",
    changeName: change,
    artifact: "spec-deltas",
  });

  return (
    <OpenSpecShell sections={sections}>
      <article className="flex flex-col gap-6">
        <OpenSpecBreadcrumbs
          crumbs={[
            { label: PLANNING_LABEL, href: planningPath() },
            { label: "Changes", href: planningPath("/changes") },
            { label: change, href: planningPath(`/changes/${change}`) },
            { label: "Spec Deltas", href: planningPath(`/changes/${change}/specs`) },
            { label: capability },
          ]}
        />
        <header className="flex flex-col gap-2">
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
