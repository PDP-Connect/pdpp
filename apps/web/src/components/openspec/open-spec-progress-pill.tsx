export function OpenSpecProgressPill({ completed, total }: { completed: number; total: number }) {
  if (total === 0) {
    return <span className="pdpp-caption text-muted-foreground">no tasks</span>;
  }
  return (
    <span className="pdpp-caption font-mono text-muted-foreground tabular-nums">
      {completed}/{total} tasks
    </span>
  );
}
