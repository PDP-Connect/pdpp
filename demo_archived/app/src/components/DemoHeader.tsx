'use client';

import { DemoPhase } from '@/lib/types';
import { Button } from '@/components/ui/button';

interface Props {
  phase: DemoPhase;
  seeded: { following_accounts: number; posts: number; ad_targeting: number } | null;
  onReset: () => void;
  logOpen: boolean;
  logCount: number;
  onToggleLog: () => void;
}

const PHASE_STORY: Record<DemoPhase, string> = {
  idle:                'A research app wants access to your Instagram data',
  requesting:          'Personal server starting up…',
  consenting_research: 'Audience Lens is requesting read access to your social graph',
  consenting_ai:       'Audience Lens also wants to use your data for AI training',
  showing_results:     'Grant enforced — client received only what it was permitted',
  authenticating:      'Connect to Instagram to sync fresh data',
  scraping:            'Personal server is syncing fresh data from Instagram',
  done:                'Reference flow complete — spec features exercised',
  error:               'Something went wrong',
};

const PHASE_ORDER: DemoPhase[] = [
  'idle', 'requesting', 'consenting_research', 'consenting_ai',
  'showing_results', 'authenticating', 'scraping', 'done',
];

const STEPS = [
  { label: 'Connect',  phases: ['requesting'] as DemoPhase[] },
  { label: 'Consent',  phases: ['consenting_research', 'consenting_ai'] as DemoPhase[] },
  { label: 'Results',  phases: ['showing_results'] as DemoPhase[] },
  { label: 'Complete', phases: ['authenticating', 'scraping', 'done'] as DemoPhase[] },
];

function phaseIndex(p: DemoPhase) { return PHASE_ORDER.indexOf(p); }

function stepState(stepPhases: DemoPhase[], currentPhase: DemoPhase): 'pending' | 'active' | 'done' {
  const currentIdx = phaseIndex(currentPhase);
  const stepMax = Math.max(...stepPhases.map(phaseIndex));
  if (currentIdx > stepMax) return 'done';
  if (stepPhases.includes(currentPhase)) return 'active';
  return 'pending';
}

export function DemoHeader({ phase, seeded, onReset, logOpen, logCount, onToggleLog }: Props) {
  const progress = phaseIndex(phase);
  const isDone = phase === 'done';

  return (
    <header className="relative flex items-center h-12 shrink-0 border-b border-border bg-background overflow-hidden">
      {/* Progress bar */}
      <div
        className="absolute bottom-0 left-0 h-px transition-all duration-500"
        style={{ width: `${Math.max(0, Math.min(100, (progress / 7) * 100))}%`, background: isDone ? 'var(--success)' : 'var(--primary)' }}
      />

      {/* Logo */}
      <div className="flex items-center gap-2 px-4 h-full border-r border-border shrink-0">
        <div className="w-6 h-6 rounded flex items-center justify-center text-xs font-bold text-white bg-primary shrink-0">P</div>
        <div>
          <div className="text-xs font-semibold text-foreground leading-none">PDPP</div>
          <div className="text-xs text-muted-foreground font-mono">v0.1.0</div>
        </div>
      </div>

      {/* Status */}
      <div className="flex-1 flex items-center gap-3 px-4 min-w-0">
        <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{
          background: phase === 'error' ? 'var(--destructive)' : isDone ? 'var(--success)' : phase === 'idle' ? 'var(--border)' : 'var(--primary)',
        }} />
        <span className="text-xs text-muted-foreground truncate">{PHASE_STORY[phase]}</span>
        {seeded && phase !== 'idle' && phase !== 'requesting' && (
          <span className="text-xs text-muted-foreground shrink-0">
            {seeded.following_accounts} contacts · {seeded.posts} posts
          </span>
        )}
      </div>

      {/* Steps + actions */}
      <div className="flex items-center gap-2 px-4 shrink-0">
        <div className="flex items-center gap-1">
          {STEPS.map(({ label, phases: stepPhases }, i) => {
            const state = stepState(stepPhases, phase);
            return (
              <div key={label} className="flex items-center gap-1">
                {i > 0 && <div className="w-3 h-px bg-border" />}
                <div className="px-2 py-0.5 rounded text-xs transition-all duration-200" style={{
                  background: state === 'active' ? 'var(--primary)' : 'transparent',
                  color: state === 'active' ? '#fff' : state === 'done' ? 'var(--muted-foreground)' : 'var(--border)',
                }}>
                  {state === 'done' ? '✓' : ''} {label}
                </div>
              </div>
            );
          })}
        </div>

        <Button size="sm" variant={logOpen ? 'secondary' : 'ghost'} onClick={onToggleLog} className="gap-1 text-xs">
          Log
          {logCount > 0 && <span className="font-mono text-xs">{logCount}</span>}
        </Button>

        {phase !== 'idle' && (
          <Button size="sm" variant="outline" onClick={onReset} className="text-xs">Reset</Button>
        )}
      </div>
    </header>
  );
}
