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
        "col-1 hidden self-start font-sans lg:block",
        "lg:sticky lg:top-[72px] lg:pt-[calc(var(--spacing-section-gap)/1.5)]",
        // Scrollbar thumb idle → ink on hover/focus.
        // --foreground, not --color-foreground: an arbitrary value is emitted
        // as authored, and --color-foreground is frozen to brand ink at :root.
        // See pdpp-brand tokens/semantic.css header.
        "transition-[scrollbar-color] duration-200 ease-in-out [scrollbar-color:transparent_transparent]",
        "hover:[scrollbar-color:color-mix(in_srgb,var(--foreground)_28%,transparent)_transparent]",
        "focus-within:[scrollbar-color:color-mix(in_srgb,var(--foreground)_28%,transparent)_transparent]",
        "hover:[&::-webkit-scrollbar-thumb]:bg-[color-mix(in_srgb,var(--foreground)_28%,transparent)]",
        "focus-within:[&::-webkit-scrollbar-thumb]:bg-[color-mix(in_srgb,var(--foreground)_28%,transparent)]",
        "[&::-webkit-scrollbar-thumb:hover]:bg-[color-mix(in_srgb,var(--foreground)_45%,transparent)]"
      )}
      data-slot="pdpp-concept-rail"
    >
      <PdppRailToc toc={toc} />
    </aside>
  );
}
