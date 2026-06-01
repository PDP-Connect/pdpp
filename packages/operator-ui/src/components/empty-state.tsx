import type { ReactNode } from "react";

/**
 * Empty-state placeholder used by the shared dashboard list/overview views.
 *
 * Previously this lived inside each app's `dashboard/components/shell.tsx`.
 * The shell is genuinely forked between the public site (mock-owner sandbox
 * chrome) and the operator console (live owner chrome), so it stays
 * app-local; `EmptyState` is the one shell export the shared views depend on,
 * so it is extracted here where both shells and the shared views can import it.
 */
export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="rounded-md border border-border/80 border-dashed px-4 py-10 text-center">
      <p className="pdpp-body font-medium text-foreground">{title}</p>
      {hint ? <p className="pdpp-body mx-auto mt-1 max-w-md text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
