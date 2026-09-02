// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { PdppConceptShell } from "@/components/layout/concept-shell.tsx";
import { specDocsOptions } from "@/lib/docs-shared.tsx";
import { getSpecNavTree } from "@/lib/docs-source.ts";
import { getSpecFrontMatter } from "@/lib/spec-front-matter.ts";
import { specRailSlots } from "./rail.tsx";
import { SpecRailProvider } from "./rail-context.tsx";

type RailFrontMatterProp = Parameters<typeof SpecRailProvider>[0]["frontMatter"];

// The specification shell uses fumadocs' own slots to replace the sidebar
// contents and remove its duplicate search trigger. Fumadocs still owns the
// sidebar behavior, mobile drawer, active state, and document tree.
// `railFrontMatter` defaults to the specification's own block, tagged "spec"
// so RailBanner (rail.tsx) knows which card shape to render. Pass a
// "governance"- or "principles"-tagged block (see those routes) or null on a
// surface that is none of them, so the rail keeps the document list without
// claiming a front-matter block it doesn't have data for.
export function SpecificationShell({
  children,
  railFrontMatter = { kind: "spec", value: getSpecFrontMatter() },
}: {
  children: ReactNode;
  railFrontMatter?: RailFrontMatterProp;
}) {
  return (
    <PdppConceptShell className="pdpp-docs-shell" data-pdpp-doc-theme="true">
      <SpecRailProvider frontMatter={railFrontMatter}>
        {/* Same page measure as PdppConceptPage / masthead / footer — no
            full-bleed exception, so the rail's links open on the same x as
            the wordmark here as on every other page. */}
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
