import type { Metadata } from 'next';
import {
  OpenSpecArtifactCard,
  OpenSpecBreadcrumbs,
  OpenSpecEmptyState,
  OpenSpecShell,
  buildOpenSpecSidebarSections,
} from '@/components/openspec';
import { listOpenSpecDesignNotes } from '@/lib/openspec';

export const metadata: Metadata = {
  title: 'OpenSpec design notes — PDPP',
  description:
    'Supplemental design notes under openspec/changes/*/design-notes for the PDPP reference implementation.',
};

export default async function OpenSpecDesignNotesPage() {
  const notes = await listOpenSpecDesignNotes();
  const sections = buildOpenSpecSidebarSections({ kind: 'notes' });

  return (
    <OpenSpecShell sections={sections}>
      <div className="flex flex-col gap-6">
        <OpenSpecBreadcrumbs
          crumbs={[{ label: 'OpenSpec', href: '/openspec' }, { label: 'Design Notes' }]}
        />
        <header className="flex flex-col gap-2">
          <h1 className="text-[clamp(1.6rem,2.8vw,2.05rem)] font-semibold tracking-tight leading-tight">
            Design notes
          </h1>
          <p className="pdpp-body max-w-3xl text-muted-foreground">
            Supplemental notes co-located with changes under{' '}
            <code className="font-mono text-xs">openspec/changes/*/design-notes/</code>.
          </p>
        </header>

        {notes.length === 0 ? (
          <OpenSpecEmptyState
            title="No design notes found"
            description="There are currently no markdown files under openspec/changes/*/design-notes/."
          />
        ) : (
          <div className="flex flex-col divide-y divide-border/60">
            {notes.map((note) => (
              <OpenSpecArtifactCard
                key={`${note.changeName}/${note.noteSlug}`}
                href={`/openspec/notes/${note.changeName}/${note.noteSlug}`}
                title={note.title}
                excerpt={note.excerpt}
                eyebrow={note.changeName}
              />
            ))}
          </div>
        )}
      </div>
    </OpenSpecShell>
  );
}
