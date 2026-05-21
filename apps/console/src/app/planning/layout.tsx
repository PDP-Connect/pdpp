import type { ReactNode } from "react";
import { SiteHeader } from "@/components/site-header.tsx";
import { PLANNING_LABEL } from "@/lib/openspec/public.ts";

export default function PlanningLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header
        className="sticky top-0 z-40 flex h-12 items-center px-5 md:px-6"
        style={{
          backgroundColor: "var(--background)",
          backdropFilter: "blur(8px)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <SiteHeader currentLabel={PLANNING_LABEL} />
      </header>
      {children}
    </div>
  );
}
