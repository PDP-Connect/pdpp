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
  getOpenSpecChange,
  getOpenSpecChangeArtifact,
  listOpenSpecChanges,
} from '@/lib/openspec';

type PageProps = { params: Promise<{ change: string }> };

export async function generateStaticParams() {
  const changes = await listOpenSpecChanges();
  return changes.filter((c) => c.hasDesign).map((c) => ({ change: c.name }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { change } = await params;
  const summary = await getOpenSpecChange(change);
  if (!summary) return { title: 'Design not found — OpenSpec — PDPP' };
  return {
    title: `${summary.title} — Design — OpenSpec — PDPP`,
    description: summary.designExcerpt ?? summary.excerpt ?? undefined,
  };
}

export default async function ChangeDesignPage({ params }: PageProps) {
  const { change } = await params;
  const artifact = await getOpenSpecChangeArtifact(change, 'design');
  if (!artifact) notFound();
  const sections = buildOpenSpecSidebarSections({
    kind: 'change',
    changeName: change,
    artifact: 'design',
  });

  return (
    <OpenSpecShell sections={sections}>
      <article className="flex flex-col gap-6">
        <OpenSpecBreadcrumbs
          crumbs={[
            { label: 'OpenSpec', href: '/openspec' },
            { label: 'Changes', href: '/openspec/changes' },
            { label: change, href: `/openspec/changes/${change}` },
            { label: 'Design' },
          ]}
        />
        <header className="flex flex-col gap-3">
          <h1 className="text-[clamp(1.6rem,2.8vw,2.05rem)] font-semibold tracking-tight leading-tight">
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
