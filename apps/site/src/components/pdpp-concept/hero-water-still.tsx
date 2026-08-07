// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/lib/utils.ts";
import { HERO_WATER_STREAMS } from "./hero-water-data.ts";

const ROWS_PER_COLUMN = 17;
const STREAM_ANIMATION_CLASS_NAMES = [
  "motion-safe:animate-[pdpp-water-drift_41s_linear_infinite]",
  "motion-safe:animate-[pdpp-water-drift_33s_linear_infinite]",
  "motion-safe:animate-[pdpp-water-drift_27s_linear_infinite]",
] as const;

export function PdppHeroWaterStill() {
  return (
    <>
      <style>{`@keyframes pdpp-water-drift {
        from { transform: translateY(-50%); }
        to { transform: translateY(0); }
      }`}</style>
      <div
        aria-hidden="true"
        className="flex h-full w-full overflow-hidden font-light font-mono text-[12px] text-foreground leading-[34px] [-webkit-mask-image:linear-gradient(to_bottom,transparent,black_90px,black_calc(100%_-_90px),transparent)] [mask-image:linear-gradient(to_bottom,transparent,black_90px,black_calc(100%_-_90px),transparent)]"
      >
        {HERO_WATER_STREAMS.map((stream, colIndex) => (
          <div className="min-w-0 flex-1 overflow-hidden whitespace-nowrap ps-[18px]" key={stream[0]?.[0] ?? colIndex}>
            <div
              className={cn(
                "motion-safe:will-change-transform motion-reduce:-translate-y-1/2",
                STREAM_ANIMATION_CLASS_NAMES[colIndex]
              )}
            >
              {[0, 1].map((copyIndex) => (
                <div aria-hidden="true" key={copyIndex}>
                  {Array.from({ length: ROWS_PER_COLUMN }, (_, rowIndex) => stream[rowIndex % stream.length]).map(
                    (row, rowIndex) => (
                      <div key={`${row?.[0]}-${rowIndex}`}>
                        <span className="text-[rgba(14,90,84,0.78)]">{row?.[0]}</span>{" "}
                        <span className="text-[rgba(26,26,23,0.92)]">{row?.[1]}</span>
                      </div>
                    )
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
