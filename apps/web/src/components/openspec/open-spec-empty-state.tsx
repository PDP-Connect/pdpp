import type { ReactNode } from "react";

export function OpenSpecEmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-1.5 py-2">
      <div className="font-medium text-foreground/80">{title}</div>
      {description && <div className="pdpp-body text-muted-foreground">{description}</div>}
      {action}
    </div>
  );
}
