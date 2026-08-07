// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { SpecificationShell } from "@/components/specification/shell.tsx";
import "@/styles/surfaces/concept/index.css";
import "@/styles/surfaces/specification.css";

export default function Layout({ children }: { children: ReactNode }) {
  return <SpecificationShell>{children}</SpecificationShell>;
}
