// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { HERO_WATER_STREAMS } from "./hero-water-data.ts";

// Server-rendered first frame for the records-on-water figure.
//
// hero-water.tsx builds a canvas in useEffect, so between first paint and
// hydration there was nothing here: on a slow connection a reader saw an
// empty box next to the headline before any JS ran. This renders the same
// three columns, same records, same top/bottom fade, as plain HTML markup
// that exists in the initial server response — no JS required to see it.
//
// It sits in the SAME grid cell the canvas mounts into (both are children of
// `.pdpp-frontdoor__water`, absolutely stacked) so swapping one for the other
// on hydration causes no layout shift. hero-water.tsx removes this node the
// moment its own canvas is ready to paint.
const ROWS_PER_COLUMN = 12;

export function PdppHeroWaterStill() {
  return (
    <div aria-hidden="true" className="pdpp-frontdoor__water-still" data-hero-water-still="">
      {HERO_WATER_STREAMS.map((stream, colIndex) => (
        <div className="pdpp-frontdoor__water-still-col" key={stream[0]?.[0] ?? colIndex}>
          {Array.from({ length: ROWS_PER_COLUMN }, (_, rowIndex) => stream[rowIndex % stream.length]).map(
            (row, rowIndex) => (
              <div className="pdpp-frontdoor__water-still-row" key={`${row?.[0]}-${rowIndex}`}>
                <span className="pdpp-frontdoor__water-still-key">{row?.[0]}</span>{" "}
                <span className="pdpp-frontdoor__water-still-value">{row?.[1]}</span>
              </div>
            )
          )}
        </div>
      ))}
    </div>
  );
}
