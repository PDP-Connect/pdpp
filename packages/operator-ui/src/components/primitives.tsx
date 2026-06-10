import Link from "next/link";
import type { ReactNode } from "react";
import { RUN_LIFECYCLE_VOCABULARY, type StatusTone, type StatusVocabulary } from "./status-vocabularies.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Breadcrumb {
  href?: string;
  label: string;
}

export type MetaPillTone = "neutral" | "protocol" | "human" | "success" | "warning" | "danger";

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
      aria-label="Breadcrumb"
      className="pdpp-caption mb-3 flex flex-wrap items-center gap-x-1.5 text-muted-foreground"
    >
      {items.map((item, index) => (
        <span className="inline-flex items-center gap-1.5" key={`${item.href ?? "leaf"}:${item.label}`}>
          {index > 0 ? <span className="text-muted-foreground/60">/</span> : null}
          {item.href ? (
            <Link className="underline-offset-2 hover:text-foreground hover:underline" href={item.href}>
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
    <section className={`mb-8 scroll-mt-16 ${className}`.trim()} id={id}>
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
    <div className={`flex min-w-0 flex-col gap-1 ${width}`.trim()}>
      <span className="pdpp-eyebrow">{label}</span>
      {children}
    </div>
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
      // `pdpp-data-list` is a brand-stylesheet hook (base.css) that owns the
      // row-separator + outer-rule contrast. It lives in real CSS rather than
      // dark: utility classes because the console's Tailwind content scan only
      // covers apps/console/src — utility classes that appear *only* in
      // operator-ui (e.g. a dark: divider token) never get generated. The CSS
      // hook also lets the dark surface step the separators up to
      // --border-strong (charcoal needs the extra contrast) while light keeps
      // the gentle hairline, in one place.
      className={`pdpp-data-list divide-y divide-border/70 border-border/70 border-y ${dense ? "" : ""} ${className}`.trim()}
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
    <nav aria-label="Pagination" className="pdpp-caption mt-5 flex flex-wrap items-center justify-between gap-3">
      <span className="text-muted-foreground tabular-nums">{countLabel}</span>
      <div className="flex flex-wrap items-center gap-3">
        {prev ? (
          <Link className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" href={prev}>
            ← previous
          </Link>
        ) : (
          <span className="text-muted-foreground/40">← previous</span>
        )}
        {next ? (
          <Link className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" href={next}>
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
  warning: "border-[color:var(--warning)]/25 bg-[color:var(--warning-wash)] text-foreground",
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
// One primitive (the chip), many vocabularies (one per domain). The tone/
// vocabulary types and the domain vocabularies themselves live in the sibling
// `status-vocabularies.ts` module so this component file stays Fast-Refresh
// clean (component-only exports).

// The badge fill rides on a base (light) wash class; the dark-mode fill + ring
// strengthening and the semantic label COLOR are owned by the brand stylesheet
// (base.css, keyed off the `data-status-tone` attribute below). Two reasons it
// is NOT done with `dark:` utility classes here:
//   1. The console's Tailwind content scan only covers apps/console/src, so a
//      `dark:` token that appears only in operator-ui never gets generated.
//   2. The label needs to escape `.pdpp-eyebrow { color: var(--muted-foreground) }`,
//      which is *unlayered* and so beats any Tailwind `text-*` utility (utilities
//      live in `@layer utilities`; unlayered rules win the cascade over layered
//      ones). A real CSS rule of equal-or-greater specificity is the clean fix.
// On the charcoal dark surface the prior wash-only fills (8–16% alpha) read
// nearly flat — base.css steps each tone's fill up and adds a same-hue inset
// ring so a failure is easy to spot in a scannable list.
const STATUS_BADGE_TONE_CLASSES: Record<StatusTone, string> = {
  // bg-success-wash / bg-warning-wash are now Tailwind token utilities (mapped in
  // each app's @theme inline block) — no more bracket-notation pressure here.
  danger: "bg-destructive/10",
  success: "bg-success-wash",
  warning: "bg-warning-wash",
  neutral: "bg-muted",
};

export function StatusBadge({
  status,
  vocabulary = RUN_LIFECYCLE_VOCABULARY,
  inline = false,
}: {
  status: string;
  vocabulary?: StatusVocabulary;
  inline?: boolean;
}) {
  const entry = vocabulary[status] ?? { label: status.replace(/_/g, " "), tone: "neutral" as const };
  const toneClass = STATUS_BADGE_TONE_CLASSES[entry.tone];
  return (
    <span
      // `data-status-tone` lets the brand stylesheet (base.css) own the semantic
      // label color and the dark-mode fill/ring strengthening — see the
      // STATUS_BADGE_TONE_CLASSES note for why this can't be `dark:`/`text-*`
      // utilities here.
      className={`pdpp-status-badge pdpp-eyebrow ${inline ? "" : "inline-flex"} rounded-[3px] px-1.5 py-0.5 font-medium tabular-nums ${toneClass}`}
      data-status-tone={entry.tone}
    >
      {entry.label}
    </span>
  );
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
    <div className={`${neutralClass} px-4 py-3 ${className}`.trim()} data-surface={surfaceAttr}>
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
  /**
   * Active filter chips. When an item carries `removeHref`, the chip renders a
   * dismiss control that links to the same view with just that one filter
   * dropped, so a multi-filter selection can be narrowed one chip at a time
   * instead of only "clear all". Items without `removeHref` stay display-only,
   * which keeps every existing caller backward compatible.
   */
  items: Array<{ label: string; value: string; removeHref?: string }>;
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
          className={`inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-background py-0.5 pl-2 ${
            item.removeHref ? "pr-1" : "pr-2"
          }`}
          key={`${item.label}:${item.value}`}
        >
          <span className="text-muted-foreground">{item.label}</span>
          <span className="font-medium text-foreground">{item.value}</span>
          {item.removeHref ? (
            <Link
              aria-label={`Remove ${item.label} filter ${item.value}`}
              className="-mr-0.5 inline-flex size-4 items-center justify-center rounded-full text-muted-foreground leading-none hover:bg-muted hover:text-foreground"
              href={item.removeHref}
            >
              ×
            </Link>
          ) : null}
        </span>
      ))}
      {resetHref ? (
        <Link
          className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          href={resetHref}
        >
          clear all
        </Link>
      ) : null}
    </div>
  );
}
