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
          <div
            className={cn(
              "min-w-0 flex-1 overflow-hidden whitespace-nowrap ps-[18px]",
              // Drop columns instead of squeezing them. Text cannot scale below
              // its own size the way the image heroes on comparable landing
              // pages do, so three tracks inside a 375px column leave ~100px
              // each and every pair truncates to "sleep_score…" with the value
              // — the actual content — clipped away. One column at phone
              // widths, two by 640, all three from 768.
              // The breakpoints are on the CONTAINER, not the viewport,
              // because the hero column's width is not a function of viewport
              // width alone: the front door splits its container in two, so
              // this column measures 325px at 375, peaks at 707px around 768,
              // and settles at 540px from 1440 up. A viewport-keyed rule got
              // that backwards — at 1024 each stream was 128px, narrower than
              // at 768, and 22 rows truncated.
              //
              // Thresholds come from the width a pair actually needs, measured
              // rather than estimated: the widest rendered row is 123px at
              // 12px mono, plus the 18px inline padding, so a track needs
              // ~141px. Two fit above 300px of container, three above 440 —
              // and the container is 540px from 1440 up, so all three survive
              // on desktop instead of the block stranding in the middle third.
              colIndex === 1 && "@[300px]:block hidden",
              colIndex === 2 && "@[440px]:block hidden"
            )}
            key={stream[0]?.[0] ?? colIndex}
          >
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
