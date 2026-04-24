import Link from "next/link";
import type { ReactNode } from "react";

export function OpenSpecArtifactCard({
  href,
  eyebrow,
  title,
  excerpt,
  meta,
  footer,
}: {
  href: string;
  eyebrow?: string;
  title: string;
  excerpt?: string | null;
  meta?: ReactNode;
  footer?: ReactNode;
}) {
  const hasMetaLine = Boolean(eyebrow || footer);

  return (
    <Link
      className="group -mx-2 grid gap-2 rounded-md px-2 py-4 transition-colors hover:bg-muted/35 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
      href={href}
    >
      <div className="min-w-0 flex-1">
        <div className="pdpp-title text-foreground">{title}</div>
        {excerpt && <p className="pdpp-body mt-2 line-clamp-3 max-w-[72ch] text-muted-foreground">{excerpt}</p>}
        {hasMetaLine && (
          <div className="pdpp-caption mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
            {eyebrow && <span className="font-mono">{eyebrow}</span>}
            {footer}
          </div>
        )}
      </div>
      {meta && (
        <div className="pdpp-caption flex shrink-0 items-center gap-2 text-muted-foreground sm:justify-self-end">
          {meta}
        </div>
      )}
    </Link>
  );
}
