// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { DocsSidebar, type DocsSidebarSection } from "./docs-sidebar.tsx";

export function DocsLayout({ sections, children }: { sections: DocsSidebarSection[]; children: ReactNode }) {
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-6 sm:px-6 xl:grid-cols-[13rem_minmax(0,1fr)]">
      <DocsSidebar sections={sections} />
      <main className="min-w-0 pb-10">{children}</main>
    </div>
  );
}
