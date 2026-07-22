// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
    <div className="border-border/40 border-t px-4 py-12 text-center">
      <p className="pdpp-eyebrow mb-3 text-muted-foreground/60 uppercase tracking-widest">Empty</p>
      <p className="pdpp-title text-foreground">{title}</p>
      {hint ? <p className="pdpp-caption mx-auto mt-2 max-w-sm text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
