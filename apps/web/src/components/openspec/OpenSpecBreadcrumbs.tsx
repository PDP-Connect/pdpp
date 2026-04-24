import Link from "next/link";
import { Fragment } from "react";

export interface OpenSpecCrumb {
  href?: string;
  label: string;
}

export function OpenSpecBreadcrumbs({ crumbs }: { crumbs: OpenSpecCrumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="pdpp-caption text-muted-foreground">
      <ol className="flex flex-wrap items-center gap-1.5">
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <Fragment key={`${crumb.href ?? "leaf"}:${crumb.label}`}>
              <li>
                {crumb.href && !isLast ? (
                  <Link href={crumb.href} className="transition-colors hover:text-foreground">
                    {crumb.label}
                  </Link>
                ) : (
                  <span aria-current={isLast ? "page" : undefined} className="text-foreground">
                    {crumb.label}
                  </span>
                )}
              </li>
              {!isLast && (
                <li aria-hidden="true" className="opacity-40">
                  /
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
