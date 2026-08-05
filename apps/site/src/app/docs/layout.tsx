// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { PdppConceptFooter } from "@/components/pdpp-concept/footer.tsx";
import { PdppConceptMasthead } from "@/components/pdpp-concept/masthead.tsx";
import { baseOptions } from "@/lib/docs-shared.tsx";
import { source } from "@/lib/docs-source.ts";

// The specification page carries the SAME footer as the other three. The owner's
// finding was that the footer differed on every page; "one footer" has to mean
// all four surfaces, and /docs was the one without it — so the licenses that
// govern the specification text were missing from the page that shows it.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="pdpp-docs-shell pdpp-concept" data-pdpp-doc-theme="true">
      <PdppConceptMasthead />
      <DocsLayout sidebar={{ collapsible: false }} tree={source.getPageTree()} {...baseOptions()}>
        {children}
      </DocsLayout>
      <PdppConceptFooter />
    </div>
  );
}
