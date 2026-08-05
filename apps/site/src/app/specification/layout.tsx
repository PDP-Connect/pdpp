// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { PdppConceptFooter } from "@/components/pdpp-concept/footer.tsx";
import { PdppConceptMasthead } from "@/components/pdpp-concept/masthead.tsx";
import { specRailSlots } from "@/components/pdpp-concept/spec-rail.tsx";
import { SpecRailProvider } from "@/components/pdpp-concept/spec-rail-context.tsx";
import { baseOptions } from "@/lib/docs-shared.tsx";
import { getSpecNavTree } from "@/lib/docs-source.ts";
import { getSpecFrontMatter } from "@/lib/spec-front-matter.ts";

// The specification page carries the SAME footer as the other three. The owner's
// finding was that the footer differed on every page; /docs was the one without
// it — so the licenses that govern the specification text were missing from the
// page that shows it.
//
// THREE DELIBERATE SUBSTITUTIONS, all through fumadocs' own API rather than CSS
// fighting its markup:
//
// getSpecNavTree() — the rail lists the five specification documents and, under
// a hairline, the supporting ones. Everything is still built, routed, linked
// and indexed; nothing is deleted. See docs-source.ts.
//
// specRailSlots.sidebar — replaces what is INSIDE the sidebar (front matter
// block, document links at the concept's type and density) while fumadocs' own
// Sidebar keeps rendering the column itself: sticky desktop placement, the
// mobile drawer, the scroll container, active state.
//
// specRailSlots.searchTrigger (false) — removes the sidebar's search box. The
// concept has exactly one search affordance, in the masthead, and this route
// was rendering two on screen at once. `false` is fumadocs' own supported
// value here; the masthead trigger drives the same dialog over the same index,
// so `/` and Cmd-K still work.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="pdpp-docs-shell pdpp-concept" data-pdpp-doc-theme="true">
      <PdppConceptMasthead />
      <SpecRailProvider frontMatter={getSpecFrontMatter()}>
        <DocsLayout sidebar={{ collapsible: false }} slots={specRailSlots} tree={getSpecNavTree()} {...baseOptions()}>
          {children}
        </DocsLayout>
      </SpecRailProvider>
      <PdppConceptFooter />
    </div>
  );
}
