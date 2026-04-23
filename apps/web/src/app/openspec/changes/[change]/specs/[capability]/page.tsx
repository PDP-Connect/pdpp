import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  OpenSpecBreadcrumbs,
  OpenSpecMarkdownPage,
  OpenSpecShell,
  OpenSpecSourceLink,
  buildOpenSpecSidebarSections,
} from '@/components/openspec';
import {
  getOpenSpecChangeSpecDelta,
  listOpenSpecChangeSpecDeltas,
  listOpenSpecChanges,
} from '@/lib/openspec';

type PageProps = { params: Promise<{ change: string; capability: string }> };

export async function generateStaticParams() {
  const changes = await listOpenSpecChanges();
  const params: Array<{ change: string; capability: string }> = [];
  await Promise.all(
    changes.map(async (c) => {
      const deltas = await listOpenSpecChangeSpecDeltas(c.name);
      for (const d of deltas) params.push({ change: c.name, capability: d.capability });
    }),
  );
  return params;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { change, capability } = await params;
  const artifact = await getOpenSpecChangeSpecDelta(change, capability);
  if (!artifact) return { title: 'Spec delta not found — OpenSpec — PDPP' };
  return {
    title: `${artifact.title} — ${change} — OpenSpec — PDPP`,
    description: artifact.excerpt ?? undefined,
  };
}

export default async function ChangeSpecDeltaPage({ params }: PageProps) {
  const { change, capability } = await params;
  const artifact = await getOpenSpecChangeSpecDelta(change, capability);
  if (!artifact) notFound();

  const sections = buildOpenSpecSidebarSections({
    kind: 'change',
    changeName: change,
    artifact: 'spec-deltas',
  });

  return (
    <OpenSpecShell sections={sections}>
      <article className="flex flex-col gap-6">
        <OpenSpecBreadcrumbs
          crumbs={[
            { label: 'OpenSpec', href: '/openspec' },
            { label: 'Changes', href: '/openspec/changes' },
            { label: change, href: `/openspec/changes/${change}` },
            { label: 'Spec Deltas', href: `/openspec/changes/${change}/specs` },
            { label: capability },
          ]}
        />
        <header className="flex flex-col gap-2">
          <h1 className="text-[clamp(1.6rem,2.8vw,2.05rem)] font-semibold tracking-tight leading-tight">
            {artifact.title}
          </h1>
          <OpenSpecSourceLink repoRelativePath={artifact.repoRelativePath} />
        </header>
        <OpenSpecMarkdownPage markdown={artifact.markdown} />
      </article>
    </OpenSpecShell>
  );
}
