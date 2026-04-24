import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  buildOpenSpecSidebarSections,
  OpenSpecBreadcrumbs,
  OpenSpecMarkdownPage,
  OpenSpecShell,
  OpenSpecSourceLink,
} from "@/components/openspec/index.ts";
import { getOpenSpecDesignNote, listOpenSpecDesignNotes } from "@/lib/openspec/index.ts";
import { PLANNING_LABEL, planningPath } from "@/lib/openspec/public.ts";

type PageProps = {
  params: Promise<{ change: string; note: string }>;
};

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

  const sections = buildOpenSpecSidebarSections({
    kind: "notes",
    changeName: change,
    noteSlug: note,
  });

  return (
    <OpenSpecShell sections={sections}>
      <article className="flex flex-col gap-6">
        <OpenSpecBreadcrumbs
          crumbs={[
            { label: PLANNING_LABEL, href: planningPath() },
            { label: "Project notes", href: planningPath("/notes") },
            { label: change, href: planningPath(`/changes/${change}`) },
            { label: designNote.title },
          ]}
        />
        <header className="flex flex-col gap-3">
          <h1 className="font-semibold text-[clamp(1.6rem,2.8vw,2.05rem)] leading-tight tracking-tight">
            {designNote.title}
          </h1>
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
          <OpenSpecSourceLink
            repoRelativePath={designNote.repoRelativePath}
            createdAt={designNote.createdAt}
            lastModified={designNote.lastModified}
          />
        </header>
        <OpenSpecMarkdownPage markdown={designNote.markdown} />
      </article>
    </OpenSpecShell>
  );
}
