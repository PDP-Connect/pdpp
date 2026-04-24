import type { Metadata } from "next";
import { OpenSpecBreadcrumbs } from "@/components/openspec/open-spec-breadcrumbs.tsx";
import { OpenSpecEmptyState } from "@/components/openspec/open-spec-empty-state.tsx";
import { OpenSpecNoteGroups } from "@/components/openspec/open-spec-note-groups.tsx";
import { OpenSpecShell } from "@/components/openspec/open-spec-shell.tsx";
import { buildOpenSpecSidebarSections } from "@/components/openspec/sidebar-sections.ts";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { listOpenSpecDesignNoteGroups, listOpenSpecDesignNotes } from "@/lib/openspec/index.ts";
import { OPENSPEC_IMPLEMENTATION_LABEL, PLANNING_LABEL, planningPath } from "@/lib/openspec/public.ts";

export const metadata: Metadata = {
  title: `Project notes — ${PLANNING_LABEL} — PDPP`,
  description:
    "Grouped change-local notes for the PDPP reference implementation: open questions, plans, audits, and research not yet promoted into canonical OpenSpec artifacts.",
};

export default async function OpenSpecDesignNotesPage() {
  const [groups, notes] = await Promise.all([listOpenSpecDesignNoteGroups(), listOpenSpecDesignNotes()]);
  const sections = buildOpenSpecSidebarSections({ kind: "notes" });
  const latestNote = notes[0]?.lastModified ?? null;
  const openQuestionCount = notes.filter((note) => note.noteKind === "open-question").length;

  return (
    <OpenSpecShell sections={sections}>
      <div className="flex flex-col gap-6">
        <OpenSpecBreadcrumbs crumbs={[{ label: PLANNING_LABEL, href: planningPath() }, { label: "Project notes" }]} />
        <header className="flex flex-col gap-3">
          <h1 className="font-semibold text-[clamp(1.6rem,2.8vw,2.05rem)] leading-tight tracking-tight">
            Project notes
          </h1>
          <p className="pdpp-body max-w-3xl text-muted-foreground">
            Change-local notes co-located under{" "}
            <code className="font-mono text-xs">
              {OPENSPEC_IMPLEMENTATION_LABEL.toLowerCase()}/changes/*/design-notes/
            </code>
            . This is where open questions, plans, audits, and research live before they are promoted into official
            change artifacts.
          </p>
        </header>

        <div className="rounded-[1.1rem] border border-border/60 bg-[color-mix(in_oklab,var(--muted)_35%,white)] px-5 py-4 md:px-6">
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <span className="pdpp-body text-muted-foreground">
              <span className="font-semibold text-foreground">{groups.length}</span> workstreams
            </span>
            <span className="pdpp-body text-muted-foreground">
              <span className="font-semibold text-foreground">{notes.length}</span> notes
            </span>
            <span className="pdpp-body text-muted-foreground">
              <span className="font-semibold text-foreground">{openQuestionCount}</span> open questions
            </span>
            {latestNote && (
              <span className="pdpp-body inline-flex items-baseline gap-1 text-muted-foreground">
                last updated <Timestamp className="font-semibold text-foreground" precision="date" value={latestNote} />
              </span>
            )}
          </div>
        </div>

        {groups.length === 0 ? (
          <OpenSpecEmptyState
            description="There are currently no markdown files under openspec/changes/*/design-notes/."
            title="No project notes found"
          />
        ) : (
          <OpenSpecNoteGroups groups={groups} showChangeLink />
        )}
      </div>
    </OpenSpecShell>
  );
}
