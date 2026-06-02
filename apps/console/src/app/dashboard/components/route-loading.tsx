/**
 * Lightweight content skeletons for App Router `loading.tsx` files.
 *
 * Each dashboard `loading.tsx` wraps one of these in the same `DashboardShell`
 * the resolved page uses, so the sidebar/topbar stay stable through the
 * navigation and only the content region animates. The shell's env-footer
 * probe is cached (15s revalidate), so on a warm dashboard the loading state
 * paints immediately; cold, it is bounded by the footer's 900ms probe timeout
 * — still far faster than the page's own data fetch, which is what these
 * loading states exist to cover.
 *
 * Visual language: muted blocks built from the existing console tokens
 * (`bg-muted`, `pdpp-*` type ramp). No bespoke animation framework — a single
 * `animate-pulse` on the placeholder blocks, matching the running-state dot
 * already used in `connector-row`. Decorative blocks are `aria-hidden`; a
 * single polite live region names what is loading for assistive tech.
 *
 * These are deliberately tiny and dependency-free so a route-level loading
 * state never becomes a second source of slowness.
 */

/** One muted placeholder bar. Decorative; hidden from assistive tech. */
function Bar({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`block animate-pulse rounded bg-muted ${className}`} />;
}

/** Stable, deterministic keys for the fixed set of skeleton rows. */
function skeletonRowKeys(rows: number): string[] {
  return Array.from({ length: rows }, (_, i) => `skeleton-row-${i}`);
}

/** Page header skeleton: a title bar plus an optional subtitle bar. */
function HeaderSkeleton({ withSubtitle = true }: { withSubtitle?: boolean }) {
  return (
    <div className="mb-6 flex flex-col gap-2">
      <Bar className="h-7 w-48" />
      {withSubtitle ? <Bar className="h-4 w-72 max-w-full" /> : null}
    </div>
  );
}

/**
 * A skeleton for a vertical list surface (records list, runs list). Renders a
 * header and `rows` muted list rows inside the standard bordered container.
 */
export function ListLoadingSkeleton({
  label,
  rows = 6,
}: {
  /** What is loading, e.g. "connections" — announced to assistive tech. */
  label: string;
  rows?: number;
}) {
  return (
    <div aria-busy="true" className="min-w-0">
      <span className="sr-only" role="status">
        Loading {label}…
      </span>
      <HeaderSkeleton />
      <div className="divide-y divide-border/70 overflow-hidden rounded-md border border-border/70">
        {skeletonRowKeys(rows).map((key) => (
          <div className="flex items-center justify-between gap-4 px-3 py-3" key={key}>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Bar className="h-4 w-40 max-w-[60%]" />
              <Bar className="h-3 w-28 max-w-[40%]" />
            </div>
            <Bar className="h-4 w-24 shrink-0" />
            <Bar className="h-7 w-20 shrink-0 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A skeleton for a detail surface (one connection, one run): a header plus a
 * couple of stacked content blocks. Lightweight on purpose — the resolved page
 * fills in the real sections.
 */
export function DetailLoadingSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" className="min-w-0">
      <span className="sr-only" role="status">
        Loading {label}…
      </span>
      <HeaderSkeleton />
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 rounded-md border border-border/70 px-4 py-4">
          <Bar className="h-4 w-32" />
          <Bar className="h-3 w-full max-w-md" />
          <Bar className="h-3 w-2/3 max-w-sm" />
        </div>
        <div className="flex flex-col gap-2 rounded-md border border-border/70 px-4 py-4">
          <Bar className="h-4 w-40" />
          <Bar className="h-3 w-full max-w-lg" />
          <Bar className="h-3 w-1/2 max-w-xs" />
        </div>
      </div>
    </div>
  );
}
