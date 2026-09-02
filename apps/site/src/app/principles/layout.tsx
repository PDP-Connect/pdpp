// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { SpecificationShell } from "@/components/specification/shell.tsx";
import { getPrinciplesFrontMatter } from "@/lib/spec-front-matter.ts";
import "@/styles/surfaces/concept/index.css";
import "@/styles/surfaces/specification.css";

// Same shell and stylesheets as /governance, for the same reason: the
// Principles are a different KIND of document from the specification, not a
// different visual language. Reusing the shell is also what puts the rail on
// this page, so a reader who arrives at /principles sees the governance
// document and the specification set beside it.
//
// railFrontMatter is tagged "principles" and carries PRINCIPLES.md's own
// Version/Status, not the specification's VERSION/STATUS/DATE/EDITORS block.
// That block describes the SPECIFICATION; showing "Status: Normative draft"
// beside a document that is not protocol text at all would contradict the page.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <SpecificationShell railFrontMatter={{ kind: "principles", value: getPrinciplesFrontMatter() }}>
      {children}
    </SpecificationShell>
  );
}
