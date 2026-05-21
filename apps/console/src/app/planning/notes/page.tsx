import type { Metadata } from "next";
import { MetaPill, PageHeader } from "@/app/dashboard/components/primitives.tsx";
import { DocsLayout } from "@/components/docs/docs-layout.tsx";
import { NoteGroups } from "@/components/planning/note-groups.tsx";
import { buildPlanningSidebarSections } from "@/components/planning/sidebar-sections.ts";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { listOpenSpecDesignNoteGroups, listOpenSpecDesignNotes } from "@/lib/openspec/index.ts";
import { OPENSPEC_IMPLEMENTATION_LABEL, PLANNING_LABEL, planningPath } from "@/lib/openspec/public.ts";

export const metadata: Metadata = {
  title: `Project notes — ${PLANNING_LABEL} — PDPP`,
  description:
    "Grouped change-local notes for the PDPP reference implementation: open questions, plans, audits, and research not yet promoted into canonical change artifacts.",
};

export default async function OpenSpecDesignNotesPage() {
  const [groups, notes] = await Promise.all([listOpenSpecDesignNoteGroups(), listOpenSpecDesignNotes()]);
  const sections = buildPlanningSidebarSections({ kind: "notes" });
  const latestNote = notes[0]?.lastModified ?? null;
  const openQuestionCount = notes.filter((note) => note.noteKind === "open-question").length;

  return (
    <DocsLayout sections={sections}>
      <PageHeader
        breadcrumbs={[{ href: planningPath(), label: PLANNING_LABEL }, { label: "Project notes" }]}
        description={
          <>
            Change-local notes co-located under{" "}
            <code className="font-mono text-xs">
              {OPENSPEC_IMPLEMENTATION_LABEL.toLowerCase()}/changes/*/design-notes/
            </code>
            . This is where open questions, plans, audits, and research live before they are promoted into official
            change artifacts.
          </>
        }
        meta={
          <>
            <MetaPill label="workstreams" value={groups.length} />
            <MetaPill label="notes" value={notes.length} />
            {openQuestionCount > 0 && <MetaPill label="open questions" tone="protocol" value={openQuestionCount} />}
            {latestNote && (
              <MetaPill
                label="updated"
                value={<Timestamp precision="date" value={latestNote} valueKind="calendar-date" />}
              />
            )}
          </>
        }
        title="Project notes"
      />

      {groups.length === 0 ? (
        <div className="flex flex-col items-start gap-1.5 py-2">
          <div className="font-medium text-foreground/80">No project notes found</div>
          <div className="pdpp-body text-muted-foreground">
            There are currently no markdown files under openspec/changes/*/design-notes/.
          </div>
        </div>
      ) : (
        <NoteGroups groups={groups} showChangeLink />
      )}
    </DocsLayout>
  );
}
