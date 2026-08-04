// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { PdppConceptMasthead } from "@/components/pdpp-concept/masthead.tsx";
import { baseOptions } from "@/lib/docs-shared.tsx";
import { source } from "@/lib/docs-source.ts";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="pdpp-docs-shell pdpp-concept" data-pdpp-doc-theme="true">
      <PdppConceptMasthead />
      <DocsLayout sidebar={{ collapsible: false }} tree={source.getPageTree()} {...baseOptions()}>
        {children}
      </DocsLayout>
    </div>
  );
}
