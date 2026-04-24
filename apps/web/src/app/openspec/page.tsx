import type { Metadata } from "next";
import Link from "next/link";
import { OpenSpecArtifactCard } from "@/components/openspec/open-spec-artifact-card.tsx";
import { OpenSpecEmptyState } from "@/components/openspec/open-spec-empty-state.tsx";
import { OpenSpecNoteGroups } from "@/components/openspec/open-spec-note-groups.tsx";
import { OpenSpecProgressPill } from "@/components/openspec/open-spec-progress-pill.tsx";
import { OpenSpecSectionCard } from "@/components/openspec/open-spec-section-card.tsx";
import { OpenSpecShell } from "@/components/openspec/open-spec-shell.tsx";
import { OpenSpecStatusPill } from "@/components/openspec/open-spec-status-pill.tsx";
import { buildOpenSpecSidebarSections } from "@/components/openspec/sidebar-sections.ts";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { getOpenSpecLandingSummary, listOpenSpecDesignNoteGroups } from "@/lib/openspec/index.ts";
import { OPENSPEC_IMPLEMENTATION_LABEL, PLANNING_LABEL, planningPath } from "@/lib/openspec/public.ts";

export const metadata: Metadata = {
  title: `${PLANNING_LABEL} — PDPP`,
  description: "Project planning, official change artifacts, and working notes for the PDPP reference implementation.",
};

export default async function OpenSpecLandingPage() {
  const [{ changes, specs, designNotes }, noteGroups] = await Promise.all([
    getOpenSpecLandingSummary(),
    listOpenSpecDesignNoteGroups(),
  ]);
  const sections = buildOpenSpecSidebarSections({ kind: "overview" });
  const latestChange = changes[0]?.lastModified ?? null;
  const latestNote = designNotes[0]?.lastModified ?? null;
  let lastTouched: string | null = latestChange ?? latestNote;
  if (latestChange && latestNote) {
    lastTouched = latestChange > latestNote ? latestChange : latestNote;
  }
  const openQuestionCount = designNotes.filter((note) => note.noteKind === "open-question").length;

  return (
    <OpenSpecShell sections={sections}>
      <div className="flex flex-col gap-8">
        <header className="flex flex-col gap-3">
          <h1 className="font-semibold text-[clamp(1.7rem,3vw,2.2rem)] leading-tight tracking-tight">
            Reference implementation planning
          </h1>
          <p className="pdpp-body max-w-3xl text-muted-foreground">
            {PLANNING_LABEL} is the internal project view for the PDPP reference implementation: official change
            artifacts, durable capability specs, and change-local working notes, rendered directly from the repository.
            The underlying structure comes from{" "}
            <code className="font-mono text-xs">{OPENSPEC_IMPLEMENTATION_LABEL.toLowerCase()}/</code>.
          </p>
        </header>

        <div className="rounded-[1.1rem] border border-border/60 bg-[color-mix(in_oklab,var(--muted)_35%,white)] px-5 py-4 md:px-6">
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <span className="pdpp-body text-muted-foreground">
              <span className="font-semibold text-foreground">{changes.length}</span> changes
            </span>
            <span className="pdpp-body text-muted-foreground">
              <span className="font-semibold text-foreground">{specs.length}</span> capability specs
            </span>
            <span className="pdpp-body text-muted-foreground">
              <span className="font-semibold text-foreground">{designNotes.length}</span> project notes
            </span>
            <span className="pdpp-body text-muted-foreground">
              <span className="font-semibold text-foreground">{openQuestionCount}</span> open questions
            </span>
            {lastTouched && (
              <span className="pdpp-body inline-flex items-baseline gap-1 text-muted-foreground">
                last updated{" "}
                <Timestamp className="font-semibold text-foreground" precision="date" value={lastTouched} />
              </span>
            )}
          </div>
        </div>

        <OpenSpecSectionCard title="How to read this surface">
          <ul className="grid gap-3 md:grid-cols-3">
            <li className="pdpp-body text-muted-foreground">
              <span className="font-medium text-foreground">Root specs</span> define protocol semantics such as grants,
              queries, and authorization metadata.
            </li>
            <li className="pdpp-body text-muted-foreground">
              <span className="font-medium text-foreground">Code and tests</span> define what the reference
              implementation actually does today.
            </li>
            <li className="pdpp-body text-muted-foreground">
              <span className="font-medium text-foreground">{PLANNING_LABEL}</span> captures active change planning,
              reference boundaries, and the work around unresolved questions.
            </li>
          </ul>
        </OpenSpecSectionCard>

        <OpenSpecSectionCard description="Sorted by status, then most recently modified." title="Active changes">
          {changes.length === 0 ? (
            <OpenSpecEmptyState
              description="There are currently no entries under openspec/changes/."
              title="No changes found"
            />
          ) : (
            <div className="flex flex-col divide-y divide-border/60">
              {changes.map((c) => (
                <OpenSpecArtifactCard
                  excerpt={c.excerpt}
                  eyebrow={c.name}
                  footer={
                    <>
                      <OpenSpecProgressPill completed={c.completedTasks} total={c.totalTasks} />
                      {c.affectedCapabilities.length > 0 && (
                        <span>
                          affects: <span className="font-mono">{c.affectedCapabilities.join(", ")}</span>
                        </span>
                      )}
                      {c.lastModified && (
                        <span className="inline-flex items-baseline gap-1">
                          updated <Timestamp precision="date" value={c.lastModified} />
                        </span>
                      )}
                    </>
                  }
                  href={planningPath(`/changes/${c.name}`)}
                  key={c.name}
                  meta={<OpenSpecStatusPill status={c.status} />}
                  title={c.title}
                />
              ))}
            </div>
          )}
        </OpenSpecSectionCard>

        <OpenSpecSectionCard description="Durable specifications under openspec/specs/." title="Capability specs">
          {specs.length === 0 ? (
            <OpenSpecEmptyState
              description="There are currently no entries under openspec/specs/."
              title="No specs found"
            />
          ) : (
            <div className="flex flex-col divide-y divide-border/60">
              {specs.map((s) => (
                <OpenSpecArtifactCard
                  excerpt={s.excerpt}
                  eyebrow={s.capability}
                  footer={
                    <>
                      {s.relatedChanges.length > 0 && (
                        <span>
                          related changes: <span className="font-mono">{s.relatedChanges.join(", ")}</span>
                        </span>
                      )}
                      {s.lastModified && (
                        <span className="inline-flex items-baseline gap-1">
                          updated <Timestamp precision="date" value={s.lastModified} />
                        </span>
                      )}
                    </>
                  }
                  href={planningPath(`/specs/${s.capability}`)}
                  key={s.capability}
                  title={s.title}
                />
              ))}
            </div>
          )}
        </OpenSpecSectionCard>

        <OpenSpecSectionCard
          action={
            <Link
              className="pdpp-caption text-muted-foreground transition-colors hover:text-foreground"
              href={planningPath("/notes")}
            >
              Open full notes index
            </Link>
          }
          description="All change-local notes, grouped by workstream. Use this for open questions, implementation plans, audits, and working research that have not been promoted into canonical change artifacts."
          title="Project notes"
        >
          {noteGroups.length === 0 ? (
            <OpenSpecEmptyState
              description="There are currently no markdown files under openspec/changes/*/design-notes/."
              title="No project notes found"
            />
          ) : (
            <OpenSpecNoteGroups collapsible defaultOpenCount={1} groups={noteGroups} />
          )}
        </OpenSpecSectionCard>
      </div>
    </OpenSpecShell>
  );
}
