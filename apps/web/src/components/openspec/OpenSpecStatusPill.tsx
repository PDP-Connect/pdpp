import type { OpenSpecChangeStatus } from '@/lib/openspec/types';

const LABELS: Record<OpenSpecChangeStatus, string> = {
  'in-progress': 'In progress',
  complete: 'Complete',
  unknown: 'No tasks',
};

export function OpenSpecStatusPill({ status }: { status: OpenSpecChangeStatus }) {
  const label = LABELS[status];
  const tone =
    status === 'complete'
      ? 'text-foreground'
      : status === 'in-progress'
        ? 'text-foreground'
        : 'text-muted-foreground';

  return <span className={`pdpp-caption ${tone}`}>{label}</span>;
}
