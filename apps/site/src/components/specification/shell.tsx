// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { PdppConceptShell } from "@/components/pdpp-concept/concept-shell.tsx";
import { specDocsOptions } from "@/lib/docs-shared.tsx";
import { getSpecNavTree } from "@/lib/docs-source.ts";
import { getSpecFrontMatter } from "@/lib/spec-front-matter.ts";
import { specRailSlots } from "./rail.tsx";
import { SpecRailProvider } from "./rail-context.tsx";

// The specification shell uses fumadocs' own slots to replace the sidebar
// contents and remove its duplicate search trigger. Fumadocs still owns the
// sidebar behavior, mobile drawer, active state, and document tree.
export function SpecificationShell({ children }: { children: ReactNode }) {
  return (
    <PdppConceptShell className="pdpp-docs-shell" data-pdpp-doc-theme="true">
      <SpecRailProvider frontMatter={getSpecFrontMatter()}>
        {/* Same page measure as PdppConceptPage / masthead / footer. */}
        <div className="container max-w-page">
          <DocsLayout
            sidebar={{ collapsible: false }}
            slots={specRailSlots}
            tree={getSpecNavTree()}
            {...specDocsOptions()}
          >
            {children}
          </DocsLayout>
        </div>
      </SpecRailProvider>
    </PdppConceptShell>
  );
}
