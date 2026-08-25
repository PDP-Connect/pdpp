// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { SpecificationShell } from "@/components/specification/shell.tsx";
import "@/styles/surfaces/concept/index.css";
import "@/styles/surfaces/specification.css";

// Same shell, same stylesheets as /specification: the governance document is a
// different KIND of document, not a different visual language. Reusing the
// shell is also what puts the rail on this page, so a reader who arrives at
// /governance can still see the specification set beside it.
//
// specFrontMatter={null} drops the rail's VERSION/STATUS/DATE/EDITORS block.
// That block describes the SPECIFICATION; showing "Status: Normative draft"
// beside a document whose own callout says it is not normative protocol text
// would contradict the page.
export default function Layout({ children }: { children: ReactNode }) {
  return <SpecificationShell specFrontMatter={null}>{children}</SpecificationShell>;
}
