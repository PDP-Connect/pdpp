import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  OpenSpecArtifactCard,
  OpenSpecBreadcrumbs,
  OpenSpecChangeHeader,
  OpenSpecEmptyState,
  OpenSpecNoteGroups,
  OpenSpecSectionCard,
  OpenSpecShell,
  OpenSpecSourceLink,
  buildOpenSpecSidebarSections,
} from '@/components/openspec';
import {
  getOpenSpecChange,
  listOpenSpecChangeDesignNotes,
  listOpenSpecChangeSpecDeltas,
  listOpenSpecChanges,
} from '@/lib/openspec';
import type { OpenSpecDesignNoteGroup } from '@/lib/openspec';
import { PLANNING_LABEL, planningPath } from '@/lib/openspec/public';

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
  if (!change) return { title: `Change not found — ${PLANNING_LABEL} — PDPP` };
  return {
    title: `${change.title} — ${PLANNING_LABEL} — PDPP`,
    description: change.excerpt ?? undefined,
  };
}

export default async function ChangeOverviewPage({ params }: PageProps) {
  const { change: changeName } = await params;
  const [change, deltas, designNotes] = await Promise.all([
    getOpenSpecChange(changeName),
    listOpenSpecChangeSpecDeltas(changeName),
    listOpenSpecChangeDesignNotes(changeName),
  ]);
  if (!change) notFound();

  const sections = buildOpenSpecSidebarSections({
    kind: 'change',
    changeName,
    artifact: 'overview',
  });

  const basePath = planningPath(`/changes/${changeName}`);
  const noteGroup: OpenSpecDesignNoteGroup | null =
    designNotes.length > 0
      ? {
          changeName,
          changeTitle: change.title,
          noteCount: designNotes.length,
          createdAt: designNotes.reduce<string | null>(
            (earliest, note) =>
              !note.createdAt || (earliest && earliest <= note.createdAt)
                ? earliest
                : note.createdAt,
            null,
          ),
          lastModified: designNotes.reduce<string | null>(
            (latest, note) =>
              !note.lastModified || (latest && latest >= note.lastModified)
                ? latest
                : note.lastModified,
            null,
          ),
          countsByKind: designNotes.reduce<OpenSpecDesignNoteGroup['countsByKind']>(
            (acc, note) => {
              acc[note.noteKind] = (acc[note.noteKind] ?? 0) + 1;
              return acc;
            },
            {},
          ),
          notes: designNotes,
        }
      : null;

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
            { label: PLANNING_LABEL, href: planningPath() },
            { label: 'Changes', href: planningPath('/changes') },
            { label: change.name },
          ]}
        />
        <OpenSpecChangeHeader change={change} />
        <OpenSpecSourceLink
          repoRelativePath={`openspec/changes/${change.name}/`}
        />

        <OpenSpecSectionCard title="Artifacts" description="Official change artifacts tracked in the canonical OpenSpec structure.">
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

        {noteGroup && (
          <OpenSpecSectionCard
            title="Project notes"
            description="Change-local notes that support this workstream but have not been promoted into the official change artifacts."
          >
            <OpenSpecNoteGroups groups={[noteGroup]} />
          </OpenSpecSectionCard>
        )}
      </div>
    </OpenSpecShell>
  );
}
