// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { LONGVIEW_CLIENT_NAME, LONGVIEW_DESCRIPTION } from "@/lib/longview-world.ts";

export function LongviewWordmark({ compact = false, inverse = false }: { compact?: boolean; inverse?: boolean }) {
  const nameColor = inverse ? "#FBFCFE" : "var(--foreground)";
  const descriptorColor = inverse ? "rgba(251, 252, 254, 0.72)" : "var(--primary)";

  return (
    <div className="min-w-0">
      <div
        className={compact ? "font-semibold text-base leading-none" : "font-semibold text-[1.6rem] leading-none"}
        style={{
          color: nameColor,
          letterSpacing: compact ? "-0.04em" : "-0.055em",
        }}
      >
        {LONGVIEW_CLIENT_NAME}
      </div>
      <div
        className={
          compact
            ? "mt-1 font-mono text-[9px] uppercase tracking-[0.11em]"
            : "mt-2 font-mono text-[10px] uppercase tracking-[0.12em]"
        }
        style={{ color: descriptorColor }}
      >
        {LONGVIEW_DESCRIPTION}
      </div>
    </div>
  );
}
