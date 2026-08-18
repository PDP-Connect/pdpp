// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { Text } from "@/components/pdpp-concept/text.tsx";
import { cn } from "@/lib/utils.ts";

interface PdppConceptDocHeaderProps {
  className?: string;
  lede: ReactNode;
  title: string;
}

/** Railed doc pages: display title + lede stack. Gap owns rhythm. */
export function PdppConceptDocHeader({ className, lede, title }: PdppConceptDocHeaderProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)} data-slot="pdpp-concept-doc-header">
      <Text as="h1" size="display">
        {title}
      </Text>
      <Text size="lede">{lede}</Text>
    </div>
  );
}
