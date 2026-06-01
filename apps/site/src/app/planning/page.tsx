import {
  ARTIFACT_LIFECYCLE_VOCABULARY,
  DataList,
  MetaPill,
  PageHeader,
  Section,
  StatusBadge,
} from "@pdpp/operator-ui/components/primitives";
import type { Metadata } from "next";
import Link from "next/link";
import { ArtifactLink } from "@/components/docs/artifact-link.tsx";
import { DocsLayout } from "@/components/docs/docs-layout.tsx";
import { NoteGroups } from "@/components/planning/note-groups.tsx";
import { buildPlanningSidebarSections } from "@/components/planning/sidebar-sections.ts";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { getOpenSpecLandingSummary, listOpenSpecDesignNoteGroups } from "@/lib/openspec/index.ts";
import { PLANNING_LABEL, planningPath } from "@/lib/openspec/public.ts";

export const metadata: Metadata = {
  title: `${PLANNING_LABEL} — PDPP`,
  description: "Project planning, official change artifacts, and working notes for the PDPP reference implementation.",
};

export default async function PlanningLandingPage() {
  const [{ changes, specs, designNotes }, noteGroups] = await Promise.all([
    getOpenSpecLandingSummary(),
    listOpenSpecDesignNoteGroups(),
  ]);
  const sections = buildPlanningSidebarSections({ kind: "overview" });
  const latestChange = changes[0]?.lastModified ?? null;
  const latestNote = designNotes[0]?.lastModified ?? null;
  let lastTouched: string | null = latestChange ?? latestNote;
  if (latestChange && latestNote) {
    lastTouched = latestChange > latestNote ? latestChange : latestNote;
  }
  const openQuestionCount = designNotes.filter((note) => note.noteKind === "open-question").length;

  return (
    <DocsLayout sections={sections}>
      <PageHeader
        description="The internal project view for the PDPP reference implementation. Active changes, durable capability specs, and change-local working notes — rendered directly from the repository."
        meta={
          <>
            <MetaPill label="changes" value={changes.length} />
            <MetaPill label="specs" value={specs.length} />
            <MetaPill label="notes" value={designNotes.length} />
            {openQuestionCount > 0 && <MetaPill label="open questions" tone="protocol" value={openQuestionCount} />}
            {lastTouched && (
              <MetaPill
                label="updated"
                value={<Timestamp precision="date" value={lastTouched} valueKind="calendar-date" />}
              />
            )}
          </>
        }
        title={PLANNING_LABEL}
      />

      <Section description="Sorted by status, then most recently modified." title="Active changes">
        <DataList ariaLabel="Active changes">
          {changes.map((c) => (
            <li key={c.name}>
              <ArtifactLink
                excerpt={c.excerpt}
                eyebrow={c.name}
                footer={
                  <>
                    <span className="font-mono">
                      {c.totalTasks > 0 ? `${c.completedTasks}/${c.totalTasks} tasks` : "no tasks"}
                    </span>
                    {c.affectedCapabilities.length > 0 && (
                      <span>
                        affects: <span className="font-mono">{c.affectedCapabilities.join(", ")}</span>
                      </span>
                    )}
                    {c.lastModified && (
                      <span className="inline-flex items-baseline gap-1">
                        updated <Timestamp precision="date" value={c.lastModified} valueKind="calendar-date" />
                      </span>
                    )}
                  </>
                }
                href={planningPath(`/changes/${c.name}`)}
                meta={<StatusBadge status={c.status} vocabulary={ARTIFACT_LIFECYCLE_VOCABULARY} />}
                title={c.title}
              />
            </li>
          ))}
        </DataList>
      </Section>

      <div className="mt-10 grid gap-6 sm:grid-cols-2">
        <Link
          className="group flex flex-col gap-1 border-border/60 border-t pt-4 transition-colors hover:border-foreground/40"
          href={planningPath("/specs")}
        >
          <div className="pdpp-eyebrow text-muted-foreground">Capability specs</div>
          <div className="pdpp-title text-foreground">
            {specs.length} durable specification{specs.length === 1 ? "" : "s"}
            <span className="ml-1 text-muted-foreground transition-colors group-hover:text-foreground">→</span>
          </div>
          <p className="pdpp-caption text-muted-foreground">
            Protocol semantics: grants, queries, authorization metadata, and capability contracts.
          </p>
        </Link>
        <Link
          className="group flex flex-col gap-1 border-border/60 border-t pt-4 transition-colors hover:border-foreground/40"
          href={planningPath("/notes")}
        >
          <div className="pdpp-eyebrow text-muted-foreground">Project notes</div>
          <div className="pdpp-title text-foreground">
            {designNotes.length} working note{designNotes.length === 1 ? "" : "s"}
            <span className="ml-1 text-muted-foreground transition-colors group-hover:text-foreground">→</span>
          </div>
          <p className="pdpp-caption text-muted-foreground">
            Open questions, plans, audits, and research grouped by workstream.
          </p>
        </Link>
      </div>

      {noteGroups.length > 0 && (
        <Section
          action={
            <Link
              className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              href={planningPath("/notes")}
            >
              Open full notes index
            </Link>
          }
          className="mt-12"
          title="Recent notes"
        >
          <NoteGroups collapsible defaultOpenCount={1} groups={noteGroups} />
        </Section>
      )}
    </DocsLayout>
  );
}
