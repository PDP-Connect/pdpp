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
        // Page measure: brand container (pad/center) + concept max width; flex child of .pdpp-concept
        "container max-w-page shrink-0 grow basis-auto",
        // Default: one track (home / 404)
        "grid grid-cols-[minmax(0,1fr)] items-start",
        // With direct-child PdppRail: rail | doc, gutter as column-gap (rail owns sticky col-1)
        "has-[>[data-slot=pdpp-concept-rail]]:grid-cols-[var(--spacing-rail)_minmax(0,1fr)]",
        "has-[>[data-slot=pdpp-concept-rail]]:gap-x-gutter",
        // <720px: stack — PdppRail unsticks / becomes ruled strip
        "max-[720px]:grid-cols-[minmax(0,1fr)] max-[720px]:gap-x-0",
        // Short pages (home / 404): trim doc bottom pad
        home && "[&_[data-slot=pdpp-concept-doc]]:pb-5!",
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
        "pdpp-doc",
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
