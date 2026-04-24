import Link from "next/link";
import type { ReactNode } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Breadcrumb {
  href?: string;
  label: string;
}

export type MetaPillTone = "neutral" | "protocol" | "human" | "success" | "danger";

// ─── Layout: page header ────────────────────────────────────────────────────
// One header per page. Breadcrumbs above, title row, optional meta below.
// Always divides from content with a single `border-b`. No surface, no box.

export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  meta,
  count,
}: {
  title: ReactNode;
  description?: ReactNode;
  breadcrumbs?: Breadcrumb[];
  actions?: ReactNode;
  meta?: ReactNode;
  count?: ReactNode;
}) {
  return (
    <header className="mb-6 border-border/80 border-b pb-5">
      {breadcrumbs?.length ? <Breadcrumbs items={breadcrumbs} /> : null}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-3">
            <h1 className="pdpp-heading break-words text-foreground">{title}</h1>
            {count ? <span className="pdpp-caption text-muted-foreground tabular-nums">{count}</span> : null}
          </div>
          {description ? <p className="pdpp-body mt-1.5 max-w-3xl text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {meta ? <div className="mt-4 flex flex-wrap items-center gap-2">{meta}</div> : null}
    </header>
  );
}

function Breadcrumbs({ items }: { items: Breadcrumb[] }) {
  return (
    <nav
      className="pdpp-caption mb-3 flex flex-wrap items-center gap-x-1.5 text-muted-foreground"
      aria-label="Breadcrumb"
    >
      {items.map((item, index) => (
        <span key={`${item.label}:${index}`} className="inline-flex items-center gap-1.5">
          {index > 0 ? <span className="text-muted-foreground/60">/</span> : null}
          {item.href ? (
            <Link href={item.href} className="underline-offset-2 hover:text-foreground hover:underline">
              {item.label}
            </Link>
          ) : (
            <span className="text-foreground">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

// ─── Layout: section ────────────────────────────────────────────────────────
// Silent: title + optional action + children. No border, no padding box.

export function Section({
  title,
  description,
  action,
  children,
  className = "",
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`mb-8 scroll-mt-16 ${className}`.trim()}>
      {title || action || description ? (
        <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <div className="min-w-0">
            {title ? <h2 className="pdpp-title text-foreground">{title}</h2> : null}
            {description ? <p className="pdpp-caption mt-0.5 text-muted-foreground">{description}</p> : null}
          </div>
          {action ? <div className="pdpp-caption">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

// ─── Layout: toolbar ────────────────────────────────────────────────────────
// A filter/action row. Auto-flows children; right-aligned items with
// `data-align="end"` or via the `trailing` prop.

export function Toolbar({
  children,
  trailing,
  className = "",
}: {
  children: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`pdpp-caption mb-5 flex flex-wrap items-end gap-x-3 gap-y-2 ${className}`.trim()}>
      {children}
      {trailing ? <div className="ml-auto flex flex-wrap items-center gap-2">{trailing}</div> : null}
    </div>
  );
}

export function ToolbarField({ label, children, width = "" }: { label: string; children: ReactNode; width?: string }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 ${width}`.trim()}>
      <span className="pdpp-eyebrow">{label}</span>
      {children}
    </label>
  );
}

// ─── Layout: split — main + peek pane ──────────────────────────────────────

export function SplitLayout({ main, peek }: { main: ReactNode; peek: ReactNode }) {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0">{main}</div>
      <div className="min-w-0">{peek}</div>
    </div>
  );
}

// ─── List: data list wrapper ───────────────────────────────────────────────
// Single source of truth for the divide-y list pattern.

export function DataList({
  children,
  className = "",
  dense = false,
  emptyState,
  ariaLabel,
}: {
  children?: ReactNode;
  className?: string;
  dense?: boolean;
  emptyState?: ReactNode;
  ariaLabel?: string;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  if (!hasChildren && emptyState) {
    return <>{emptyState}</>;
  }
  return (
    <ul
      aria-label={ariaLabel}
      className={`divide-y divide-border/70 border-border/70 border-y ${dense ? "" : ""} ${className}`.trim()}
    >
      {children}
    </ul>
  );
}

// ─── Pager ──────────────────────────────────────────────────────────────────

export function Pager({
  prev,
  next,
  countLabel,
}: {
  prev?: string | null;
  next?: string | null;
  countLabel?: ReactNode;
}) {
  return (
    <nav className="pdpp-caption mt-5 flex flex-wrap items-center justify-between gap-3" aria-label="Pagination">
      <span className="text-muted-foreground tabular-nums">{countLabel}</span>
      <div className="flex flex-wrap items-center gap-3">
        {prev ? (
          <Link href={prev} className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            ← previous
          </Link>
        ) : (
          <span className="text-muted-foreground/40">← previous</span>
        )}
        {next ? (
          <Link href={next} className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            next →
          </Link>
        ) : (
          <span className="text-muted-foreground/40">next →</span>
        )}
      </div>
    </nav>
  );
}

// ─── Surface: meta pill (small inline key/value) ───────────────────────────

const META_PILL_TONE_CLASSES: Record<MetaPillTone, string> = {
  protocol: "border-primary/25 bg-primary/5 text-foreground",
  human: "border-[color:var(--human)]/25 bg-[color:var(--human-wash)] text-foreground",
  success: "border-[color:var(--success)]/30 bg-[color:var(--success-wash)] text-foreground",
  danger: "border-destructive/25 bg-destructive/5 text-destructive",
  neutral: "border-border/80 bg-background",
};

export function MetaPill({ label, value, tone = "neutral" }: { label: string; value: ReactNode; tone?: MetaPillTone }) {
  const toneClass = META_PILL_TONE_CLASSES[tone];
  return (
    <span className={`pdpp-caption inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${toneClass}`}>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground tabular-nums">{value}</span>
    </span>
  );
}

// ─── Status badge ──────────────────────────────────────────────────────────
// Consolidates scattered status-chip styles across grants, runs, traces.

const STATUS_BADGE_TONE_CLASSES: Record<"success" | "danger" | "warning" | "neutral", string> = {
  danger: "bg-destructive/10 text-destructive",
  success: "bg-[color:var(--success-wash)] text-[color:var(--success)]",
  warning: "bg-[color:var(--warning-wash)] text-[color:var(--warning)]",
  neutral: "bg-muted text-muted-foreground",
};

export function StatusBadge({ status, inline = false }: { status: string; inline?: boolean }) {
  const tone = statusTone(status);
  const toneClass = STATUS_BADGE_TONE_CLASSES[tone];
  return (
    <span
      className={`pdpp-eyebrow ${inline ? "" : "inline-flex"} rounded-[3px] px-1.5 py-0.5 font-medium tabular-nums ${toneClass}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

function statusTone(status: string): "success" | "danger" | "warning" | "neutral" {
  if (["failed", "rejected", "denied", "revoked", "cancelled"].includes(status)) {
    return "danger";
  }
  if (["succeeded", "issued", "token_issued", "approved"].includes(status)) {
    return "success";
  }
  if (["started", "pending", "staged", "verification_pending"].includes(status)) {
    return "warning";
  }
  return "neutral";
}

// ─── Callout: the one card pattern ─────────────────────────────────────────
// Use sparingly. Reserved for genuinely bounded context:
//   - inline human-tinted workspace step (grant request / device flow)
//   - protocol-tinted protocol-data emphasis
//   - neutral bordered box (last resort)

export function Callout({
  title,
  description,
  children,
  surface = "neutral",
  action,
  className = "",
}: {
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  surface?: "neutral" | "human" | "protocol";
  action?: ReactNode;
  className?: string;
}) {
  const surfaceAttr = surface === "neutral" ? undefined : surface;
  const neutralClass = surface === "neutral" ? "border-border/80 bg-muted/30 border rounded-md" : "rounded-md";
  return (
    <div data-surface={surfaceAttr} className={`${neutralClass} px-4 py-3 ${className}`.trim()}>
      {title || action ? (
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          {title ? <h3 className="pdpp-title text-foreground">{title}</h3> : <span />}
          {action ? <div className="pdpp-caption">{action}</div> : null}
        </div>
      ) : null}
      {description ? <p className="pdpp-caption mb-2 text-muted-foreground">{description}</p> : null}
      {children}
    </div>
  );
}

// ─── Filter summary (active filter chips) ──────────────────────────────────

export function FilterSummary({
  items,
  resetHref,
}: {
  items: Array<{ label: string; value: string }>;
  resetHref?: string;
}) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="pdpp-caption mb-4 flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground">Active</span>
      {items.map((item) => (
        <span
          key={`${item.label}:${item.value}`}
          className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-background px-2 py-0.5"
        >
          <span className="text-muted-foreground">{item.label}</span>
          <span className="font-medium text-foreground">{item.value}</span>
        </span>
      ))}
      {resetHref ? (
        <Link
          href={resetHref}
          className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          clear all
        </Link>
      ) : null}
    </div>
  );
}
