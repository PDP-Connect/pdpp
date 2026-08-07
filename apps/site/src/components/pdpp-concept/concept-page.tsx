// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { cn } from "@/lib/utils.ts";

interface ConceptPageProps {
  children: ReactNode;
  className?: string;
  /** Short-page doc bottom pad (20px). */
  home?: boolean;
}

interface ConceptDocProps {
  children: ReactNode;
  className?: string;
}

/**
 * Editorial `<main>` chrome: `container` + `max-w-page`, optional rail grid.
 * Compose with direct children `PdppRail` then `PdppConceptDoc` — see rail.tsx.
 */
export function PdppConceptPage({ children, home = false, className }: ConceptPageProps) {
  return (
    <main
      className={cn(
        // Page measure: brand container (pad/center) + concept max width; flex child of [data-surface="concept"]
        "container max-w-page shrink-0 grow basis-auto",
        // Default: one track; lg+ with PdppRail: rail | doc
        "grid grid-cols-[minmax(0,1fr)] items-start",
        "lg:has-[>[data-slot=pdpp-concept-rail]]:grid-cols-[var(--spacing-rail)_minmax(0,1fr)]",
        "lg:has-[>[data-slot=pdpp-concept-rail]]:gap-x-gutter",
        // Short pages (home / 404): trim doc bottom pad
        home && "**:data-[slot=pdpp-concept-doc]:pt-7! **:data-[slot=pdpp-concept-doc]:pb-5!",
        className
      )}
      data-slot="pdpp-concept-page"
    >
      {children}
    </main>
  );
}

/** Editorial `<article>` track: vertical pad, prose-measure scoping. */
export function PdppConceptDoc({ children, className }: ConceptDocProps) {
  return (
    <article
      className={cn(
        // Style the doc
        "pdpp-doc",
        // Track is full column width; prose measure caps live on descendants in
        // components.css — not on this shell (tables/terminal stay wide).
        "min-w-0 max-w-full pt-[calc(var(--spacing-section-gap)/1.5)] pb-[calc(var(--spacing-section-gap)*1.25)]",
        // max-lg
        "max-lg:pt-[calc(var(--spacing-section-gap)/3)] max-lg:pb-[calc(var(--spacing-section-gap)*0.75)]",
        "[&_[data-slot=pdpp-concept-text]_a]:link-prose",
        "[&_a:not([class])]:link-prose",
        className
      )}
      data-slot="pdpp-concept-doc"
    >
      {children}
    </article>
  );
}
