import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  OpenSpecArtifactCard,
  OpenSpecBreadcrumbs,
  OpenSpecChangeHeader,
  OpenSpecEmptyState,
  OpenSpecSectionCard,
  OpenSpecShell,
  OpenSpecSourceLink,
  buildOpenSpecSidebarSections,
} from '@/components/openspec';
import {
  getOpenSpecChange,
  listOpenSpecChangeSpecDeltas,
  listOpenSpecChanges,
} from '@/lib/openspec';

type PageProps = {
  params: Promise<{ change: string }>;
};

export async function generateStaticParams() {
  const changes = await listOpenSpecChanges();
  return changes.map((c) => ({ change: c.name }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { change: changeName } = await params;
  const change = await getOpenSpecChange(changeName);
  if (!change) return { title: 'Change not found — OpenSpec — PDPP' };
  return {
    title: `${change.title} — OpenSpec — PDPP`,
    description: change.excerpt ?? undefined,
  };
}

export default async function ChangeOverviewPage({ params }: PageProps) {
  const { change: changeName } = await params;
  const [change, deltas] = await Promise.all([
    getOpenSpecChange(changeName),
    listOpenSpecChangeSpecDeltas(changeName),
  ]);
  if (!change) notFound();

  const sections = buildOpenSpecSidebarSections({
    kind: 'change',
    changeName,
    artifact: 'overview',
  });

  const basePath = `/openspec/changes/${changeName}`;

  const artifacts: Array<{
    href: string;
    title: string;
    excerpt: string | null;
    disabled?: boolean;
  }> = [
    {
      href: `${basePath}/proposal`,
      title: 'Proposal',
      excerpt: change.proposalExcerpt,
      disabled: !change.hasProposal,
    },
    {
      href: `${basePath}/design`,
      title: 'Design',
      excerpt: change.designExcerpt,
      disabled: !change.hasDesign,
    },
    {
      href: `${basePath}/tasks`,
      title: `Tasks (${change.completedTasks}/${change.totalTasks})`,
      excerpt: null,
      disabled: !change.hasTasks,
    },
    {
      href: `${basePath}/specs`,
      title:
        deltas.length > 0
          ? `Spec Deltas (${deltas.length})`
          : 'Spec Deltas',
      excerpt: null,
      disabled: deltas.length === 0,
    },
  ];

  return (
    <OpenSpecShell sections={sections}>
      <div className="flex flex-col gap-6">
        <OpenSpecBreadcrumbs
          crumbs={[
            { label: 'OpenSpec', href: '/openspec' },
            { label: 'Changes', href: '/openspec/changes' },
            { label: change.name },
          ]}
        />
        <OpenSpecChangeHeader change={change} />
        <OpenSpecSourceLink
          repoRelativePath={`openspec/changes/${change.name}/`}
        />

        <OpenSpecSectionCard title="Artifacts" description="Official OpenSpec artifacts for this change.">
          <div className="flex flex-col divide-y divide-border/60">
            {artifacts.map((a) =>
              a.disabled ? (
                <div
                  key={a.title}
                  className="flex flex-col gap-1.5 py-4 text-muted-foreground"
                >
                  <div className="font-medium text-foreground/75">{a.title}</div>
                  <div className="pdpp-body opacity-80">Not present for this change.</div>
                </div>
              ) : (
                <OpenSpecArtifactCard
                  key={a.title}
                  href={a.href}
                  title={a.title}
                  excerpt={a.excerpt}
                />
              ),
            )}
          </div>
        </OpenSpecSectionCard>

        {change.affectedCapabilities.length > 0 && (
          <OpenSpecSectionCard
            title="Affected capabilities"
            description="Capability specs this change proposes to modify."
          >
            <div className="flex flex-col divide-y divide-border/60">
              {deltas.length === 0 ? (
                <OpenSpecEmptyState
                  title="No spec deltas found"
                  description="This change lists affected capabilities but has no spec delta files yet."
                />
              ) : (
                deltas.map((d) => (
                  <OpenSpecArtifactCard
                    key={d.capability}
                    href={`${basePath}/specs/${d.capability}`}
                    eyebrow={d.capability}
                    title={d.title}
                    excerpt={d.excerpt}
                  />
                ))
              )}
            </div>
          </OpenSpecSectionCard>
        )}
      </div>
    </OpenSpecShell>
  );
}
