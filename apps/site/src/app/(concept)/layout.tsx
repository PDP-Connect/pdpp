// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { PdppConceptShell } from "@/components/pdpp-concept/concept-shell.tsx";
import "@/styles/surfaces/concept/index.css";

export default function ConceptLayout({ children }: { children: ReactNode }) {
  return <PdppConceptShell>{children}</PdppConceptShell>;
}
