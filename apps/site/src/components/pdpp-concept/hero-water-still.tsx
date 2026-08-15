// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/lib/utils.ts";
import { HERO_WATER_STREAMS } from "./hero-water-data.ts";

// Must be <= the shortest stream in hero-water-data.ts, or a column repeats
// itself on screen (`rowIndex % stream.length` wraps early).
const ROWS_PER_COLUMN = 17;

// Durations are close together and deliberately NOT ordered by column index.
// They were 41s / 33s / 22s left-to-right, which reads as one mechanism with a
// speed dial rather than three independent streams: the eye picks up the ramp
// and the near-2x spread between the outer columns makes the third look like
// it is racing. Prime-ish values within a narrow band drift in and out of phase
// instead of settling into a repeating pattern, and putting the slowest in the
// middle breaks the left-to-right ramp.
//
// Each column also starts part-way through its own cycle. Without that the
// three columns begin perfectly aligned on load, which is the most mechanical
// moment of all.
const STREAM_ANIMATION_CLASS_NAMES = [
  "motion-safe:animate-[pdpp-water-drift_31s_linear_infinite]",
  "motion-safe:animate-[pdpp-water-drift_43s_linear_infinite]",
  "motion-safe:animate-[pdpp-water-drift_37s_linear_infinite]",
] as const;
const STREAM_ANIMATION_DELAYS = ["-7s", "-19s", "-3s"] as const;

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
              style={{ animationDelay: STREAM_ANIMATION_DELAYS[colIndex] }}
            >
              {[0, 1].map((copyIndex) => (
                <div aria-hidden="true" key={copyIndex}>
                  {Array.from({ length: ROWS_PER_COLUMN }, (_, rowIndex) => stream[rowIndex % stream.length]).map(
                    (row, rowIndex) => (
                      // overflow-hidden on the row, not just the column: the
                      // column clips its own box, but a long pair still paints
                      // over the next column's track because the row is a
                      // nowrap line with no bound of its own. At 600px
                      // "artist Stars of the Lid" ran into the messages
                      // column. Data keeps pairs short (see hero-water-data);
                      // this makes over-long ones fail quietly instead.
                      <div className="overflow-hidden text-ellipsis" key={`${row?.[0]}-${rowIndex}`}>
                        <span className="text-primary/80">{row?.[0]}</span>{" "}
                        <span className="text-foreground/90">{row?.[1]}</span>
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
