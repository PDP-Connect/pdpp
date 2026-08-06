// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PdppRailToc, type PdppRailTocItem } from "@/components/pdpp-concept/rail-toc.tsx";
import { cn } from "@/lib/utils.ts";

export type { PdppRailTocItem } from "@/components/pdpp-concept/rail-toc.tsx";

export interface PdppRailProps {
  toc: readonly PdppRailTocItem[];
}

/**
 * Left apparatus for railed docs. Direct child of `PdppConceptPage` (before
 * `PdppConceptDoc`) — page flips to rail|doc + gutter gap via this data-slot.
 */
export function PdppRail({ toc }: PdppRailProps) {
  return (
    <aside
      aria-label="Document apparatus"
      className={cn(
        // Page grid col 1; self-start so sticky works (page also items-start)
        "col-1 self-start font-sans",
        // Stick under masthead; pt matches .pdpp-doc track pad
        "sticky top-[72px] pt-16",
        // Scrollbar thumb idle → ink on hover/focus
        "transition-[scrollbar-color] duration-200 ease-in-out [scrollbar-color:transparent_transparent]",
        "hover:[scrollbar-color:color-mix(in_srgb,var(--color-ink)_28%,transparent)_transparent]",
        "focus-within:[scrollbar-color:color-mix(in_srgb,var(--color-ink)_28%,transparent)_transparent]",
        "hover:[&::-webkit-scrollbar-thumb]:bg-[color-mix(in_srgb,var(--color-ink)_28%,transparent)]",
        "focus-within:[&::-webkit-scrollbar-thumb]:bg-[color-mix(in_srgb,var(--color-ink)_28%,transparent)]",
        "[&::-webkit-scrollbar-thumb:hover]:bg-[color-mix(in_srgb,var(--color-ink)_45%,transparent)]",
        // Page stacks to 1 col <720px; rail becomes ruled strip above doc
        "max-[720px]:static max-[720px]:mb-2 max-[720px]:flex max-[720px]:flex-wrap max-[720px]:items-start",
        "max-[720px]:gap-x-8 max-[720px]:gap-y-5 max-[720px]:border-rule max-[720px]:border-b max-[720px]:pt-8 max-[720px]:pb-2"
      )}
      data-slot="pdpp-concept-rail"
    >
      <PdppRailToc toc={toc} />
    </aside>
  );
}
