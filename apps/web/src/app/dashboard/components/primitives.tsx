import Link from 'next/link';
import type { ReactNode } from 'react';

export type DashboardBreadcrumb = {
  label: string;
  href?: string;
};

export function DashboardBreadcrumbs({ items }: { items: DashboardBreadcrumb[] }) {
  if (!items.length) return null;
  return (
    <nav className="text-muted-foreground mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {items.map((item, index) => (
        <div key={`${item.label}:${index}`} className="contents">
          {index > 0 ? <span>/</span> : null}
          {item.href ? (
            <Link href={item.href} className="hover:text-foreground underline-offset-2 hover:underline">
              {item.label}
            </Link>
          ) : (
            <span className="text-foreground">{item.label}</span>
          )}
        </div>
      ))}
    </nav>
  );
}

export function DashboardFrame({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-[1.25rem] border border-border/70 bg-background/80 px-4 py-4 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.7)] sm:px-5 sm:py-5 ${className}`.trim()}
    >
      {children}
    </div>
  );
}

export function DashboardRail({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <aside
      className={`rounded-[1.5rem] border border-border/70 bg-background/85 px-3 py-3 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.8),0_1px_2px_rgb(0_0_0_/_0.04)] ${className}`.trim()}
    >
      {children}
    </aside>
  );
}

export function DashboardRailSection({
  title,
  children,
  className = '',
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`border-t border-border/70 px-2 pt-3 first:border-t-0 first:pt-1 ${className}`.trim()}>
      <div className="pdpp-label text-muted-foreground mb-2 uppercase tracking-[0.12em]">{title}</div>
      {children}
    </section>
  );
}

export function DashboardMasthead({
  title,
  description,
  eyebrow = 'control plane',
  breadcrumbs = [],
  actions,
  meta,
  surface: _surface,
}: {
  title: string;
  description?: ReactNode;
  eyebrow?: string;
  breadcrumbs?: DashboardBreadcrumb[];
  actions?: ReactNode;
  meta?: ReactNode;
  surface?: 'protocol' | 'human';
}) {
  return (
    <header className="mb-8 border-b border-border/80 pb-6">
      <DashboardBreadcrumbs items={breadcrumbs} />
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="pdpp-label text-muted-foreground uppercase tracking-[0.12em]">
            {eyebrow}
          </div>
          <h1 className="pdpp-heading mt-1 break-words">{title}</h1>
          {description ? (
            <div className="text-muted-foreground mt-2 max-w-3xl text-sm leading-6">
              {description}
            </div>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2 text-xs">{actions}</div> : null}
      </div>
      {meta ? <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">{meta}</div> : null}
    </header>
  );
}

export function DashboardMetaPill({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  tone?: 'neutral' | 'protocol' | 'human' | 'danger';
}) {
  const toneClass =
    tone === 'protocol'
      ? 'border-primary/20 bg-primary/6'
      : tone === 'human'
        ? 'border-[color:var(--human)]/20 bg-[color:var(--human-wash)]'
        : tone === 'danger'
          ? 'border-destructive/20 bg-destructive/5 text-destructive'
          : 'border-border bg-background/80';
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 ${toneClass}`}>
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground font-medium">{value}</span>
    </span>
  );
}

export function DashboardToolbar({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mb-4 flex flex-wrap items-center gap-2 text-xs ${className}`.trim()}>
      {children}
    </div>
  );
}

export function DashboardSection({
  title,
  description,
  href,
  actions,
  children,
  className = '',
}: {
  title: string;
  description?: ReactNode;
  href?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`mb-8 border-t border-border/80 pt-4 ${className}`.trim()}>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="pdpp-title">{title}</h2>
          {description ? (
            <div className="text-muted-foreground mt-1 text-xs leading-5">{description}</div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {actions}
          {href ? (
            <Link href={href} className="text-muted-foreground underline-offset-2 hover:underline">
              view all →
            </Link>
          ) : null}
        </div>
      </div>
      {children}
    </section>
  );
}

export function DashboardSurfaceCard({
  title,
  description,
  href,
  actions,
  children,
  surface = 'protocol',
  className = '',
}: {
  title: string;
  description?: ReactNode;
  href?: string;
  actions?: ReactNode;
  children: ReactNode;
  surface?: 'protocol' | 'human';
  className?: string;
}) {
  return (
    <section
      data-surface={surface}
      className={`rounded-2xl px-4 py-4 sm:px-5 sm:py-5 ${className}`.trim()}
    >
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="pdpp-title">{title}</h2>
          {description ? (
            <div className="text-muted-foreground mt-1 text-xs leading-5">{description}</div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {actions}
          {href ? (
            <Link href={href} className="text-muted-foreground underline-offset-2 hover:underline">
              view all →
            </Link>
          ) : null}
        </div>
      </div>
      {children}
    </section>
  );
}

export function DashboardFilterSummary({
  items,
  resetHref,
}: {
  items: Array<{ label: string; value: string }>;
  resetHref?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">active filters</span>
      {items.map((item) => (
        <span
          key={`${item.label}:${item.value}`}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-background/80 px-2.5 py-1"
        >
          <span className="text-muted-foreground">{item.label}</span>
          <span className="font-medium">{item.value}</span>
        </span>
      ))}
      {resetHref ? (
        <Link href={resetHref} className="text-muted-foreground underline-offset-2 hover:underline">
          clear all
        </Link>
      ) : null}
    </div>
  );
}

export const DashboardPageHeader = DashboardMasthead;
export const DashboardSectionCard = DashboardSurfaceCard;
