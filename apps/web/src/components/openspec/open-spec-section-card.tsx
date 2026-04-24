import type { ReactNode } from "react";
import { cn } from "@/lib/utils.ts";

export function OpenSpecSectionCard({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-4 border-border/60 border-t pt-5", className)}>
      <header className="flex items-start gap-4">
        <div className="flex flex-col gap-1.5">
          <h2 className="pdpp-title text-foreground">{title}</h2>
          {description && <p className="pdpp-body max-w-3xl text-muted-foreground">{description}</p>}
        </div>
        {action && <div className="ml-auto text-xs">{action}</div>}
      </header>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}
