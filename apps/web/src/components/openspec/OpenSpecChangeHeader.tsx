import type { OpenSpecChangeDetail } from '@/lib/openspec/types';
import { OpenSpecProgressPill } from './OpenSpecProgressPill';
import { OpenSpecStatusPill } from './OpenSpecStatusPill';

export function OpenSpecChangeHeader({ change }: { change: OpenSpecChangeDetail }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-[clamp(1.6rem,2.8vw,2.05rem)] font-semibold tracking-tight leading-tight">
        {change.title}
      </h1>
      <div className="pdpp-caption flex flex-wrap items-center gap-2 text-muted-foreground">
        <OpenSpecStatusPill status={change.status} />
        <span aria-hidden="true" className="text-muted-foreground/50">·</span>
        <OpenSpecProgressPill completed={change.completedTasks} total={change.totalTasks} />
        <span aria-hidden="true" className="text-muted-foreground/50">·</span>
        <span className="font-mono">{change.name}</span>
      </div>
      {change.statusLabel && (
        <p className="pdpp-body max-w-3xl text-muted-foreground">{change.statusLabel}</p>
      )}
    </div>
  );
}
