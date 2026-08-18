// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { cn } from "@/lib/utils.ts";

export interface PdppRuledListProps {
  children: ReactNode;
  className?: string;
}

/**
 * A `<ul>` of title-then-description rows, ruled open on top and between
 * items (no rule after the last item). Used for "What you get" on
 * `/self-host` and the doc lists on `/maintainers` — same shape, same rule.
 */
export function PdppRuledList({ children, className }: PdppRuledListProps) {
  return <ul className={cn("mt-6 list-none border-border-subtle border-t p-0", className)}>{children}</ul>;
}

export interface PdppRuledListItemProps {
  children: ReactNode;
  className?: string;
}

export function PdppRuledListItem({ children, className }: PdppRuledListItemProps) {
  return (
    // The list opens on its own border-top, so each item's border-bottom is a
    // SEPARATOR between items. On the last item there is nothing below to
    // separate, and the section that follows draws its own rule — two lines a
    // few pixels apart. Owner-reported 2026-08-05: "within them, we should
    // not have a rule at the end of the last item."
    <li className={cn("border-border-subtle border-b py-3.5 text-foreground last:border-b-0", className)}>
      {children}
    </li>
  );
}
