import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  OpenSpecBreadcrumbs,
  OpenSpecMarkdownPage,
  OpenSpecShell,
  OpenSpecSourceLink,
  buildOpenSpecSidebarSections,
} from '@/components/openspec';
import { getOpenSpecDesignNote, listOpenSpecDesignNotes } from '@/lib/openspec';

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
  if (!designNote) return { title: 'Design note not found — OpenSpec — PDPP' };
  return {
    title: `${designNote.title} — Design Note — OpenSpec — PDPP`,
    description: designNote.excerpt ?? undefined,
  };
}

export default async function OpenSpecDesignNotePage({ params }: PageProps) {
  const { change, note } = await params;
  const designNote = await getOpenSpecDesignNote(change, note);
  if (!designNote) notFound();

  const sections = buildOpenSpecSidebarSections({
    kind: 'notes',
    changeName: change,
    noteSlug: note,
  });

  return (
    <OpenSpecShell sections={sections}>
      <article className="flex flex-col gap-6">
        <OpenSpecBreadcrumbs
          crumbs={[
            { label: 'OpenSpec', href: '/openspec' },
            { label: 'Design Notes', href: '/openspec/notes' },
            { label: change, href: `/openspec/changes/${change}` },
            { label: designNote.title },
          ]}
        />
        <header className="flex flex-col gap-3">
          <h1 className="text-[clamp(1.6rem,2.8vw,2.05rem)] font-semibold tracking-tight leading-tight">
            {designNote.title}
          </h1>
          <div className="pdpp-caption flex flex-wrap items-center gap-2 text-muted-foreground">
            <span className="font-mono">{change}</span>
            <span aria-hidden="true" className="text-muted-foreground/50">·</span>
            <span>Design note</span>
          </div>
          <OpenSpecSourceLink repoRelativePath={designNote.repoRelativePath} />
        </header>
        <OpenSpecMarkdownPage markdown={designNote.markdown} />
      </article>
    </OpenSpecShell>
  );
}
