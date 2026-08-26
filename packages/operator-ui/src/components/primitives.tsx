// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import type { ReactNode } from "react";
import { RUN_LIFECYCLE_VOCABULARY, type StatusTone, type StatusVocabulary } from "./status-vocabularies.ts";
import "./status-badge.css";

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
  // Read only via `breadcrumbs?.length ? ... : null` below; callers (e.g.
  // DeploymentDiagnosticsView) forward their own same-shaped optional prop
  // verbatim, so "absent" and "present but undefined" are already the same
  // "no breadcrumbs" one level up.
  breadcrumbs?: Breadcrumb[] | undefined;
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
      {/* On mobile (below xl / 1280px) the peek pane is hidden entirely.
          Mobile list rows navigate to full-page detail routes instead. */}
      <div className="hidden min-w-0 xl:block">{peek}</div>
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
      // --data-list-divider flips in primitive.css; no theme selector here.
      className={`divide-y divide-data-list-divider border-data-list-divider border-y ${dense ? "" : ""} ${className}`.trim()}
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
  danger: "border-destructive/25 bg-destructive/5 text-destructive",
  human: "border-[color:var(--human)]/25 bg-[color:var(--human-wash)] text-foreground",
  neutral: "border-border/80 bg-background",
  protocol: "border-primary/25 bg-primary/5 text-foreground",
  success: "border-[color:var(--success)]/30 bg-[color:var(--success-wash)] text-foreground",
  warning: "border-[color:var(--warning)]/25 bg-[color:var(--warning-wash)] text-foreground",
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

// The badge owns fill + label color + inset ring via unlayered tone classes in
// status-badge.css (`pdpp-status-badge` + `pdpp-status-*`). Not @utility /
// `dark:` / `text-*` here:
//   1. Console Tailwind content scan only covers apps/console/src, so a
//      `dark:` token that appears only in operator-ui never gets generated.
//   2. `.pdpp-eyebrow { color: var(--muted-foreground) }` is unlayered and
//      beats @layer utilities; tone presentation must stay unlayered too.
// Rings live as --status-*-ring (transparent light, same-hue / border-strong
// dark) so charcoal badges stay scannable.
// Later home: @pdpp/brand-react (see status-badge.css).
const STATUS_BADGE_TONE_CLASSES: Record<StatusTone, string> = {
  danger: "pdpp-status-danger",
  neutral: "pdpp-status-neutral",
  success: "pdpp-status-success",
  warning: "pdpp-status-warning",
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
      className={`pdpp-status-badge pdpp-eyebrow ${toneClass} ${inline ? "" : "inline-flex"} rounded-[3px] px-1.5 py-0.5 font-medium tabular-nums`}
    >
      {entry.label}
    </span>
  );
}

// ─── Callout: the one card pattern ─────────────────────────────────────────
// Use sparingly. Reserved for genuinely bounded context:
//   - `info`     — informational / advisory note (cool-blue tint; token-backed)
//   - `warning`  — owner-action required or non-blocking risk (amber tint; token-backed)
//   - `human`    — inline workspace step with human-temperature left-border
//   - `protocol` — protocol-data emphasis with protocol-temperature left-border
//   - `neutral`  — plain bordered box (last resort; no temperature signal)
//
// `tone` (new) takes `info` | `warning`; `surface` (legacy) takes
// `neutral` | `human` | `protocol`. Passing `tone` wins over `surface`
// for the styling — callers migrating from faked inline warm callouts should
// switch to `tone="info"` or `tone="warning"`.

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The branch structure directly represents the supported data variants; extraction would split one decision table.
export function Callout({
  title,
  description,
  children,
  surface = "neutral",
  tone,
  action,
  className = "",
}: {
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Legacy temperature surface. Prefer `tone` for informational/warning callouts. */
  surface?: "neutral" | "human" | "protocol";
  /** Semantic callout tone. When set, overrides `surface` styling. */
  tone?: "info" | "warning";
  action?: ReactNode;
  className?: string;
}) {
  let containerClass: string;
  let titleColorClass: string;
  let descColorClass: string;

  if (tone === "info") {
    containerClass = "rounded-md border px-4 py-3 bg-callout-info-bg border-callout-info-border";
    titleColorClass = "text-callout-info-fg";
    descColorClass = "text-callout-info-fg/80";
  } else if (tone === "warning") {
    containerClass = "rounded-md border px-4 py-3 bg-callout-warning-bg border-callout-warning-border";
    titleColorClass = "text-callout-warning-fg";
    descColorClass = "text-callout-warning-fg/80";
  } else {
    const surfaceAttr = surface === "neutral" ? undefined : surface;
    const neutralClass = surface === "neutral" ? "border-border/80 bg-muted/30 border rounded-md" : "rounded-md";
    containerClass = neutralClass;
    titleColorClass = "text-foreground";
    descColorClass = "text-muted-foreground";
    return (
      <div className={`${containerClass} px-4 py-3 ${className}`.trim()} data-surface={surfaceAttr}>
        {title || action ? (
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            {title ? <h3 className={`pdpp-title ${titleColorClass}`}>{title}</h3> : <span />}
            {action ? <div className="pdpp-caption">{action}</div> : null}
          </div>
        ) : null}
        {description ? <p className={`pdpp-caption mb-2 ${descColorClass}`}>{description}</p> : null}
        {children}
      </div>
    );
  }

  return (
    <div className={`${containerClass} ${className}`.trim()}>
      {title || action ? (
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          {title ? <h3 className={`pdpp-title ${titleColorClass}`}>{title}</h3> : <span />}
          {action ? <div className="pdpp-caption">{action}</div> : null}
        </div>
      ) : null}
      {description ? <p className={`pdpp-caption mb-2 ${descColorClass}`}>{description}</p> : null}
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
  // Read only via `resetHref ? <Link .../> : null` below; callers (e.g.
  // records-explorer-view.tsx) build this from a ternary that ends in an
  // explicit `: undefined`, so "absent" and "present but undefined" are
  // already the same "no reset link" one level up.
  resetHref?: string | undefined;
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
