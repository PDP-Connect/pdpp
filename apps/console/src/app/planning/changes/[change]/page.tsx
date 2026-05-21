import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  ARTIFACT_LIFECYCLE_VOCABULARY,
  MetaPill,
  PageHeader,
  Section,
  StatusBadge,
} from "@/app/dashboard/components/primitives.tsx";
import { ArtifactLink } from "@/components/docs/artifact-link.tsx";
import { DocsLayout } from "@/components/docs/docs-layout.tsx";
import { SourceLink } from "@/components/docs/source-link.tsx";
import { NoteGroups } from "@/components/planning/note-groups.tsx";
import { buildPlanningSidebarSections } from "@/components/planning/sidebar-sections.ts";
import type { OpenSpecDesignNoteGroup } from "@/lib/openspec/index.ts";
import {
  getOpenSpecChange,
  listOpenSpecChangeDesignNotes,
  listOpenSpecChangeSpecDeltas,
  listOpenSpecChanges,
} from "@/lib/openspec/index.ts";
import { PLANNING_LABEL, planningPath } from "@/lib/openspec/public.ts";

interface PageProps {
  params: Promise<{ change: string }>;
}

export async function generateStaticParams() {
  const changes = await listOpenSpecChanges();
  return changes.map((c) => ({ change: c.name }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { change: changeName } = await params;
  const change = await getOpenSpecChange(changeName);
  if (!change) {
    return { title: `Change not found — ${PLANNING_LABEL} — PDPP` };
  }
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
  if (!change) {
    notFound();
  }

  const sections = buildPlanningSidebarSections({
    kind: "change",
    changeName,
    artifact: "overview",
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
              !note.createdAt || (earliest && earliest <= note.createdAt) ? earliest : note.createdAt,
            null
          ),
          lastModified: designNotes.reduce<string | null>(
            (latest, note) =>
              !note.lastModified || (latest && latest >= note.lastModified) ? latest : note.lastModified,
            null
          ),
          countsByKind: designNotes.reduce<OpenSpecDesignNoteGroup["countsByKind"]>((acc, note) => {
            acc[note.noteKind] = (acc[note.noteKind] ?? 0) + 1;
            return acc;
          }, {}),
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
      title: "Proposal",
      excerpt: change.proposalExcerpt,
      disabled: !change.hasProposal,
    },
    {
      href: `${basePath}/design`,
      title: "Design",
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
      title: deltas.length > 0 ? `Spec Deltas (${deltas.length})` : "Spec Deltas",
      excerpt: null,
      disabled: deltas.length === 0,
    },
  ];

  return (
    <DocsLayout sections={sections}>
      <PageHeader
        breadcrumbs={[
          { href: planningPath(), label: PLANNING_LABEL },
          { href: planningPath("/changes"), label: "Changes" },
          { label: change.name },
        ]}
        description={change.statusLabel ?? undefined}
        meta={
          <>
            <StatusBadge status={change.status} vocabulary={ARTIFACT_LIFECYCLE_VOCABULARY} />
            {change.totalTasks > 0 && (
              <MetaPill label="tasks" value={`${change.completedTasks}/${change.totalTasks}`} />
            )}
            <span className="pdpp-caption font-mono text-muted-foreground">{change.name}</span>
            <SourceLink repoRelativePath={`openspec/changes/${change.name}/`} />
          </>
        }
        title={change.title}
      />
      <div className="flex flex-col gap-6">
        <Section description="Official change artifacts tracked under openspec/." title="Artifacts">
          <div className="flex flex-col divide-y divide-border/60">
            {artifacts.map((a) =>
              a.disabled ? (
                <div className="flex flex-col gap-1.5 py-4 text-muted-foreground" key={a.title}>
                  <div className="font-medium text-foreground/75">{a.title}</div>
                  <div className="pdpp-body opacity-80">Not present for this change.</div>
                </div>
              ) : (
                <ArtifactLink excerpt={a.excerpt} href={a.href} key={a.title} title={a.title} />
              )
            )}
          </div>
        </Section>

        {change.affectedCapabilities.length > 0 && (
          <Section description="Capability specs this change proposes to modify." title="Affected capabilities">
            <div className="flex flex-col divide-y divide-border/60">
              {deltas.length === 0 ? (
                <div className="flex flex-col items-start gap-1.5 py-2">
                  <div className="font-medium text-foreground/80">No spec deltas found</div>
                  <div className="pdpp-body text-muted-foreground">
                    This change lists affected capabilities but has no spec delta files yet.
                  </div>
                </div>
              ) : (
                deltas.map((d) => (
                  <ArtifactLink
                    excerpt={d.excerpt}
                    eyebrow={d.capability}
                    href={`${basePath}/specs/${d.capability}`}
                    key={d.capability}
                    title={d.title}
                  />
                ))
              )}
            </div>
          </Section>
        )}

        {noteGroup && (
          <Section
            description="Change-local notes that support this workstream but have not been promoted into the official change artifacts."
            title="Project notes"
          >
            <NoteGroups groups={[noteGroup]} />
          </Section>
        )}
      </div>
    </DocsLayout>
  );
}
