// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { cn } from "@/lib/utils.ts";

/** Shared rail meta label voice — Version, Specification, Contents, etc. */
export const pdppRailLabelClassName = "font-mono text-[12px] text-muted-foreground uppercase tracking-[0.04em]";

export function PdppRailSectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("m-0 pb-2.5", pdppRailLabelClassName, className)}>{children}</p>;
}
