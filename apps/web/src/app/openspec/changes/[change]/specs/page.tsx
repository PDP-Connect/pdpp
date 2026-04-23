import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  OpenSpecArtifactCard,
  OpenSpecBreadcrumbs,
  OpenSpecEmptyState,
  OpenSpecShell,
  buildOpenSpecSidebarSections,
} from '@/components/openspec';
import {
  getOpenSpecChange,
  listOpenSpecChangeSpecDeltas,
  listOpenSpecChanges,
} from '@/lib/openspec';

type PageProps = { params: Promise<{ change: string }> };

export async function generateStaticParams() {
  const changes = await listOpenSpecChanges();
  return changes.map((c) => ({ change: c.name }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { change } = await params;
  const summary = await getOpenSpecChange(change);
  if (!summary) return { title: 'Spec deltas not found — OpenSpec — PDPP' };
  return { title: `${summary.title} — Spec Deltas — OpenSpec — PDPP` };
}

export default async function ChangeSpecDeltasPage({ params }: PageProps) {
  const { change } = await params;
  const [summary, deltas] = await Promise.all([
    getOpenSpecChange(change),
    listOpenSpecChangeSpecDeltas(change),
  ]);
  if (!summary) notFound();

  const sections = buildOpenSpecSidebarSections({
    kind: 'change',
    changeName: change,
    artifact: 'spec-deltas',
  });

  return (
    <OpenSpecShell sections={sections}>
      <div className="flex flex-col gap-6">
        <OpenSpecBreadcrumbs
          crumbs={[
            { label: 'OpenSpec', href: '/openspec' },
            { label: 'Changes', href: '/openspec/changes' },
            { label: change, href: `/openspec/changes/${change}` },
            { label: 'Spec Deltas' },
          ]}
        />
        <header className="flex flex-col gap-2">
          <h1 className="text-[clamp(1.6rem,2.8vw,2.05rem)] font-semibold tracking-tight leading-tight">
            Spec deltas
          </h1>
          <p className="pdpp-body max-w-3xl text-muted-foreground">
            Per-capability spec changes proposed by{' '}
            <span className="font-mono">{change}</span>.
          </p>
        </header>

        {deltas.length === 0 ? (
          <OpenSpecEmptyState
            title="No spec deltas in this change"
            description="This change does not propose modifications to any capability spec."
          />
        ) : (
          <div className="flex flex-col divide-y divide-border/60">
            {deltas.map((d) => (
              <OpenSpecArtifactCard
                key={d.capability}
                href={`/openspec/changes/${change}/specs/${d.capability}`}
                eyebrow={d.capability}
                title={d.title}
                excerpt={d.excerpt}
              />
            ))}
          </div>
        )}
      </div>
    </OpenSpecShell>
  );
}
