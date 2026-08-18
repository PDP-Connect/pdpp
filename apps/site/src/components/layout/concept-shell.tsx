// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils.ts";
import { PdppConceptFooter } from "./footer.tsx";
import { PdppConceptMasthead } from "./masthead.tsx";

/** CSS cascade scope for legacy prose and teal-deep overrides. */
export const CONCEPT_SURFACE = "concept" as const;

/** Document frame only — palette/type rebinds live in tokens/semantic.css;
 *  selection, scrollbar, raw heading/code cascades, and `.pdpp-*` register live
 *  in `styles/surfaces/concept/components.css` under `[data-surface="concept"]`. */
export function PdppConceptShell({ children, className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        // Container inset remap (brand `container` reads --spacing-inset)
        "[--spacing-inset:var(--spacing-pad)]",
        // Sticky-footer column: min viewport height, masthead / main / footer stack
        "flex min-h-dvh flex-col",
        className
      )}
      data-surface={CONCEPT_SURFACE}
      {...props}
    >
      <PdppConceptMasthead />
      {children}
      <PdppConceptFooter />
    </div>
  );
}
