import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  OpenSpecBreadcrumbs,
  OpenSpecMarkdownPage,
  OpenSpecProgressPill,
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
  return changes.filter((c) => c.hasTasks).map((c) => ({ change: c.name }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { change } = await params;
  const summary = await getOpenSpecChange(change);
  if (!summary) return { title: 'Tasks not found — OpenSpec — PDPP' };
  return {
    title: `${summary.title} — Tasks — OpenSpec — PDPP`,
  };
}

export default async function ChangeTasksPage({ params }: PageProps) {
  const { change } = await params;
  const [artifact, summary] = await Promise.all([
    getOpenSpecChangeArtifact(change, 'tasks'),
    getOpenSpecChange(change),
  ]);
  if (!artifact || !summary) notFound();

  const sections = buildOpenSpecSidebarSections({
    kind: 'change',
    changeName: change,
    artifact: 'tasks',
  });

  return (
    <OpenSpecShell sections={sections}>
      <article className="flex flex-col gap-6">
        <OpenSpecBreadcrumbs
          crumbs={[
            { label: 'OpenSpec', href: '/openspec' },
            { label: 'Changes', href: '/openspec/changes' },
            { label: change, href: `/openspec/changes/${change}` },
            { label: 'Tasks' },
          ]}
        />
        <header className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[clamp(1.6rem,2.8vw,2.05rem)] font-semibold tracking-tight leading-tight">
              {artifact.title}
            </h1>
            <OpenSpecProgressPill
              completed={summary.completedTasks}
              total={summary.totalTasks}
            />
          </div>
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
