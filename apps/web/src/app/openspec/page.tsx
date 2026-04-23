import type { Metadata } from 'next';
import {
  OpenSpecArtifactCard,
  OpenSpecEmptyState,
  OpenSpecProgressPill,
  OpenSpecSectionCard,
  OpenSpecShell,
  OpenSpecStatusPill,
  buildOpenSpecSidebarSections,
} from '@/components/openspec';
import { getOpenSpecLandingSummary } from '@/lib/openspec';

export const metadata: Metadata = {
  title: 'OpenSpec — PDPP',
  description:
    'The PDPP repository OpenSpec layer: active changes and capability specifications for the reference implementation.',
};

export default async function OpenSpecLandingPage() {
  const { changes, specs } = await getOpenSpecLandingSummary();
  const sections = buildOpenSpecSidebarSections({ kind: 'overview' });

  return (
    <OpenSpecShell sections={sections}>
      <div className="flex flex-col gap-8">
        <header className="flex flex-col gap-3">
          <h1 className="text-[clamp(1.7rem,3vw,2.2rem)] font-semibold tracking-tight leading-tight">
            Reference implementation change planning
          </h1>
          <p className="pdpp-body max-w-3xl text-muted-foreground">
            OpenSpec is this repository&rsquo;s project layer for cross-cutting reference
            architecture and active change planning. It is rendered here directly from
            the official structure under <code className="font-mono text-xs">openspec/</code>.
          </p>
        </header>

        <OpenSpecSectionCard
          title="Authority order"
        >
          <ul className="grid gap-4 md:grid-cols-3">
            <li className="pdpp-body text-muted-foreground">
              <span className="font-medium text-foreground">Root PDPP spec files.</span>{' '}
              Authoritative for protocol semantics such as grants, queries, and
              authorization metadata.
            </li>
            <li className="pdpp-body text-muted-foreground">
              <span className="font-medium text-foreground">Reference code &amp; tests.</span>{' '}
              Authoritative for what the reference implementation currently does.
            </li>
            <li className="pdpp-body text-muted-foreground">
              <span className="font-medium text-foreground">OpenSpec.</span>{' '}
              The project layer for reference architecture, boundaries, and active
              change planning.
            </li>
          </ul>
        </OpenSpecSectionCard>

        <OpenSpecSectionCard
          title="Active changes"
          description="Sorted by status, then most recently modified."
        >
          {changes.length === 0 ? (
            <OpenSpecEmptyState
              title="No changes found"
              description="There are currently no entries under openspec/changes/."
            />
          ) : (
            <div className="flex flex-col divide-y divide-border/60">
              {changes.map((c) => (
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
                          <span className="font-mono">
                            {c.affectedCapabilities.join(', ')}
                          </span>
                        </span>
                      )}
                    </>
                  }
                />
              ))}
            </div>
          )}
        </OpenSpecSectionCard>

        <OpenSpecSectionCard
          title="Capability specs"
          description="Durable specifications under openspec/specs/."
        >
          {specs.length === 0 ? (
            <OpenSpecEmptyState
              title="No specs found"
              description="There are currently no entries under openspec/specs/."
            />
          ) : (
            <div className="flex flex-col divide-y divide-border/60">
              {specs.map((s) => (
                <OpenSpecArtifactCard
                  key={s.capability}
                  href={`/openspec/specs/${s.capability}`}
                  eyebrow={s.capability}
                  title={s.title}
                  excerpt={s.excerpt}
                  footer={
                    s.relatedChanges.length > 0 && (
                      <span>
                        related changes:{' '}
                        <span className="font-mono">{s.relatedChanges.join(', ')}</span>
                      </span>
                    )
                  }
                />
              ))}
            </div>
          )}
        </OpenSpecSectionCard>
      </div>
    </OpenSpecShell>
  );
}
