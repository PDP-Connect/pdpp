import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/app/dashboard/components/primitives.tsx";
import { DocsLayout } from "@/components/docs/docs-layout.tsx";
import { ProsePage } from "@/components/docs/prose-page.tsx";
import { SourceLink } from "@/components/docs/source-link.tsx";
import { buildPlanningSidebarSections } from "@/components/planning/sidebar-sections.ts";
import { getOpenSpecDesignNote, listOpenSpecDesignNotes } from "@/lib/openspec/index.ts";
import { PLANNING_LABEL, planningPath } from "@/lib/openspec/public.ts";

interface PageProps {
  params: Promise<{ change: string; note: string }>;
}

export async function generateStaticParams() {
  const notes = await listOpenSpecDesignNotes();
  return notes.map((note) => ({ change: note.changeName, note: note.noteSlug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { change, note } = await params;
  const designNote = await getOpenSpecDesignNote(change, note);
  if (!designNote) {
    return { title: `Project note not found — ${PLANNING_LABEL} — PDPP` };
  }
  return {
    title: `${designNote.title} — Project note — ${PLANNING_LABEL} — PDPP`,
    description: designNote.excerpt ?? undefined,
  };
}

export default async function OpenSpecDesignNotePage({ params }: PageProps) {
  const { change, note } = await params;
  const designNote = await getOpenSpecDesignNote(change, note);
  if (!designNote) {
    notFound();
  }

  const sections = buildPlanningSidebarSections({
    kind: "notes",
    changeName: change,
    noteSlug: note,
  });

  return (
    <DocsLayout sections={sections}>
      <article className="flex flex-col gap-6">
        <PageHeader
          breadcrumbs={[
            { href: planningPath(), label: PLANNING_LABEL },
            { href: planningPath("/notes"), label: "Project notes" },
            { href: planningPath(`/changes/${change}`), label: change },
            { label: designNote.title },
          ]}
          meta={
            <>
              <div className="pdpp-caption flex flex-wrap items-center gap-2 text-muted-foreground">
                <span className="font-mono">{change}</span>
                <span aria-hidden="true" className="text-muted-foreground/50">
                  ·
                </span>
                <span>Project note</span>
                <span aria-hidden="true" className="text-muted-foreground/50">
                  ·
                </span>
                <span>{designNote.noteKindLabel}</span>
              </div>
              <SourceLink
                createdAt={designNote.createdAt}
                lastModified={designNote.lastModified}
                repoRelativePath={designNote.repoRelativePath}
              />
            </>
          }
          title={designNote.title}
        />
        <ProsePage markdown={designNote.markdown} />
      </article>
    </DocsLayout>
  );
}
