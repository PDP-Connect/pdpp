"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Rows3, Rows4 } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { useDensity } from "./density-provider.tsx";
import type { Density } from "./density-state.ts";

const NEXT_DENSITY: Record<Density, Density> = {
  comfortable: "compact",
  compact: "comfortable",
};

const CURRENT_LABEL: Record<Density, string> = {
  comfortable: "Density: comfortable",
  compact: "Density: compact",
};

const NEXT_LABEL: Record<Density, string> = {
  comfortable: "Switch to compact density",
  compact: "Switch to comfortable density",
};

export function DensityToggle({ className }: { className?: string }) {
  const { density, setDensity } = useDensity();
  const nextDensity = NEXT_DENSITY[density];

  return (
    <Button
      aria-label={`${CURRENT_LABEL[density]}. ${NEXT_LABEL[density]}.`}
      className={className}
      data-testid="density-toggle"
      // biome-ignore lint/performance/noJsxPropsBind: non-memoized, inline binding intentional
      onClick={() => setDensity(nextDensity)}
      size="icon-sm"
      title={`${CURRENT_LABEL[density]}. ${NEXT_LABEL[density]}.`}
      type="button"
      variant="ghost"
    >
      {density === "compact" ? (
        <Rows4 aria-hidden="true" size={14} strokeWidth={1.75} />
      ) : (
        <Rows3 aria-hidden="true" size={14} strokeWidth={1.75} />
      )}
    </Button>
  );
}
