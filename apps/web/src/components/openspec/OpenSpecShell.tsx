import type { ReactNode } from "react";
import { OpenSpecSidebar, type OpenSpecSidebarSection } from "./OpenSpecSidebar.tsx";

export function OpenSpecShell({ sections, children }: { sections: OpenSpecSidebarSection[]; children: ReactNode }) {
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-6 sm:px-6 xl:grid-cols-[13rem_minmax(0,1fr)]">
      <OpenSpecSidebar sections={sections} />
      <main className="min-w-0 pb-10">{children}</main>
    </div>
  );
}
