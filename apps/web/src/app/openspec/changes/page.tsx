import type { Metadata } from 'next';
import {
  OpenSpecArtifactCard,
  OpenSpecBreadcrumbs,
  OpenSpecEmptyState,
  OpenSpecProgressPill,
  OpenSpecShell,
  OpenSpecStatusPill,
  buildOpenSpecSidebarSections,
} from '@/components/openspec';
import { listOpenSpecChanges } from '@/lib/openspec';

export const metadata: Metadata = {
  title: 'OpenSpec changes — PDPP',
  description: 'All discovered OpenSpec changes for the PDPP reference implementation.',
};

function formatLastModified(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toISOString().slice(0, 10);
}

export default async function OpenSpecChangesPage() {
  const changes = await listOpenSpecChanges();
  // Use the overview scope and force the Changes item active — there's no specific change
  // selected on the index page, so the per-change subnav doesn't apply yet.
  const sections = buildOpenSpecSidebarSections({ kind: 'overview' }).map((section) => ({
    ...section,
    items: section.items.map((item) =>
      item.href === '/openspec/changes' ? { ...item, active: true } : item,
    ),
  }));

  return (
    <OpenSpecShell sections={sections}>
      <div className="flex flex-col gap-6">
        <OpenSpecBreadcrumbs
          crumbs={[{ label: 'OpenSpec', href: '/openspec' }, { label: 'Changes' }]}
        />
        <header className="flex flex-col gap-2">
          <h1 className="text-[clamp(1.6rem,2.8vw,2.05rem)] font-semibold tracking-tight leading-tight">Changes</h1>
          <p className="pdpp-body max-w-3xl text-muted-foreground">
            All discovered entries under <code className="font-mono text-xs">openspec/changes/</code>.
            Sorted by status, then by most recently modified.
          </p>
        </header>

        {changes.length === 0 ? (
          <OpenSpecEmptyState
            title="No changes found"
            description="There are currently no entries under openspec/changes/."
          />
        ) : (
          <div className="flex flex-col divide-y divide-border/60">
            {changes.map((c) => {
              const last = formatLastModified(c.lastModified);
              return (
                <OpenSpecArtifactCard
                  key={c.name}
                  href={`/openspec/changes/${c.name}`}
                  eyebrow={c.name}
                  title={c.title}
                  excerpt={c.excerpt}
                  meta={<OpenSpecStatusPill status={c.status} />}
                  footer={
                    <>
                      <OpenSpecProgressPill
                        completed={c.completedTasks}
                        total={c.totalTasks}
                      />
                      {c.affectedCapabilities.length > 0 && (
                        <span>
                          affects:{' '}
                          <span className="font-mono">{c.affectedCapabilities.join(', ')}</span>
                        </span>
                      )}
                      {last && <span>updated {last}</span>}
                    </>
                  }
                />
              );
            })}
          </div>
        )}
      </div>
    </OpenSpecShell>
  );
}
