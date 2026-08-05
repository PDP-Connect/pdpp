// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { PdppConceptMasthead } from "@/components/pdpp-concept/masthead.tsx";

export default function ReferenceLayout({ children }: { children: ReactNode }) {
  return (
    <div className="pdpp-concept flex min-h-screen flex-col">
      <PdppConceptMasthead />
      {children}
    </div>
  );
}
