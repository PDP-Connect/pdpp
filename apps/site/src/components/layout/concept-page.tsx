// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { cn } from "@/lib/utils.ts";

interface ConceptPageProps {
  children: ReactNode;
  className?: string;
}

interface ConceptDocProps {
  children: ReactNode;
  className?: string;
}

/**
 * Editorial `<main>` chrome: `container` + `max-w-page`, optional rail grid.
 * Compose with direct children `PdppRail` then `PdppConceptDoc` — see rail.tsx.
 *
 * Short pages (front door, 404) do not use this directly — they use
 * `PdppConceptFrontPage`, an explicit variant below that composes the same
 * `<main>` chrome with a different vertical-centering and doc-padding
 * treatment. See that variant's doc comment for why the treatment differs.
 */
export function PdppConceptPage({ children, className }: ConceptPageProps) {
  return (
    <main
      className={cn(
        // Page measure: brand container (pad/center) + concept max width; flex child of [data-surface="concept"]
        "container max-w-page shrink-0 grow basis-auto",
        // Default: one track; lg+ with PdppRail: rail | doc
        "grid grid-cols-[minmax(0,1fr)] items-start",
        "lg:has-[>[data-slot=pdpp-editorial-rail]]:grid-cols-[var(--spacing-rail)_minmax(0,1fr)]",
        "lg:has-[>[data-slot=pdpp-editorial-rail]]:gap-x-gutter",
        className
      )}
      data-slot="pdpp-editorial-page"
    >
      {children}
    </main>
  );
}

/**
 * Explicit short-page variant: same `<main>` chrome as `PdppConceptPage`,
 * plus the vertical-centering and trimmed doc padding that only the front
 * door (`/`) and 404 need. Never railed — both callers pass a single
 * `PdppConceptDoc` child, never `PdppRail`.
 *
 * Was a `home?: boolean` prop on `PdppConceptPage` switching this treatment
 * on and off (architecture-avoid-boolean-props). Split into its own module
 * instead of a variant prop: the two treatments differ enough (an extra
 * layout axis plus a padding override reaching into the child) that folding
 * them back into one interface would just move the boolean into the name.
 */
export function PdppConceptFrontPage({ children, className }: ConceptPageProps) {
  return (
    <main
      className={cn(
        "container max-w-page shrink-0 grow basis-auto",
        "grid grid-cols-[minmax(0,1fr)]",
        // The shell is min-h-dvh and <main> is `grow`, so on a window taller
        // than the content main absorbs the surplus — but the hero cannot use
        // it, and it became an empty band under the CTAs: 136px at 1440x900
        // growing to 540px (39% of the viewport) at 1440x1400, larger than any
        // of seven reference landing pages at that size (Deno 1%, MCP 3%,
        // Tailscale 6%, Stripe 7%, Kubernetes 11%, Let's Encrypt 20%, Vercel
        // 30%). items-center distributes that surplus above AND below the hero
        // instead of dumping all of it underneath. grow-0 was tried first and
        // reverted: it stops main growing, which fixes the band but strands the
        // footer 404px above the bottom of a tall window.
        "items-center",
        "**:data-[slot=pdpp-editorial-doc]:pt-7! **:data-[slot=pdpp-editorial-doc]:pb-5! max-md:**:data-[slot=pdpp-editorial-doc]:pt-0!",
        className
      )}
      data-slot="pdpp-editorial-page"
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
        "max-md:pt-0 max-lg:pt-[calc(var(--spacing-section-gap)/3)] max-lg:pb-[calc(var(--spacing-section-gap)*0.75)]",
        "[&_[data-slot=pdpp-editorial-text]_a]:link-prose",
        "[&_a:not([class])]:link-prose",
        className
      )}
      data-slot="pdpp-editorial-doc"
    >
      {children}
    </article>
  );
}
