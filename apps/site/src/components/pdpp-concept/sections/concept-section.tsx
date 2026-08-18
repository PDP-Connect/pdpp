// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { Text } from "@/components/pdpp-concept/text.tsx";
import { cn } from "@/lib/utils.ts";

export interface PdppConceptSectionProps {
  children?: ReactNode;
  className?: string;
  id: string;
  /** Editorial numeral on the section title (e.g. "01"). */
  sectionIndex: string;
  title: string;
}

/**
 * Hand-authored concept doc section: anchor id + ruled vertical rhythm + indexed
 * h2. For `/self-host`, `/participate`, and similar railed JSX pages only.
 *
 * `/specification` does not use this — MDX headings get section breaks from
 * `.pdpp-docs-body h2` in `styles/surfaces/specification.css`. Visual parity
 * target: those h2 rules; same rhythm, different mechanism (prose selectors).
 */
export function PdppConceptSection({ children, className, id, sectionIndex, title }: PdppConceptSectionProps) {
  return (
    <section
      className={cn(
        "relative mt-[calc(var(--spacing-section-gap)/1.25)]",
        // The section leading a page needs no rule of its own — the doc header
        // above it already separates it — so it keeps the tighter step.
        "first-of-type:mt-10",
        "max-[720px]:mt-10",
        className
      )}
      data-slot="pdpp-concept-section"
      id={id}
    >
      <Text as="h2" sectionIndex={sectionIndex} size="title">
        {title}
      </Text>
      {children}
    </section>
  );
}
