// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Text } from "@/components/typography/text.tsx";
import type { PublicSupporter } from "@/lib/public-supporters.ts";
import { cn } from "@/lib/utils.ts";

// The public register of Supporters.
//
// The prototype shows six example rows and a "[ 247 ] signatories" counter,
// labelled in the design as layout-only. Those are NOT rendered: the site
// ships supporters.json as an empty array, and a page that shows invented
// signatories is a page that has published a false register. The empty state
// below is what a reader sees until the first real signature lands.
//
// SHAPE: the table receives only the five public fields. The private store
// holds email, the signatory's name and role, and the consent flags; none of
// them have a route to this component, because the publish script never writes
// them into the public register. See docs/registers.md.

const CELL = "px-6 text-left align-top";
const BODY_CELL = cn(CELL, "py-3");

// Shared by the table and the roll: an empty register says the same thing
// wherever it is shown, and the two must not drift apart.
function PdppSupportersEmpty() {
  return (
    <div className="border border-border p-6" data-slot="pdpp-supporters-empty">
      <Text as="p" color="muted" size="body">
        No signatories are listed yet. The register is published here as soon as the first signature is confirmed.
      </Text>
    </div>
  );
}

export function PdppSupportersTable({ supporters }: { supporters: readonly PublicSupporter[] }) {
  if (supporters.length === 0) {
    return <PdppSupportersEmpty />;
  }

  return (
    // Wide tables scroll inside their own scrollport rather than pushing the
    // page sideways.
    <div className="overflow-x-auto border border-border">
      <table className="w-full border-collapse tabular-nums" data-slot="pdpp-boxed-table">
        <thead>
          <tr className="border-border border-b">
            {["Signatory", "Type", "Country", "Version", "Signed"].map((heading) => (
              <th className={cn(CELL, "pt-6 pb-3 font-normal")} key={heading} scope="col">
                <Text as="span" color="subtle" inline size="stamp">
                  {heading}
                </Text>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {supporters.map((supporter) => (
            <tr
              className="border-border/60 border-b last:border-b-0 last:[&>td]:pb-6"
              key={`${supporter.publicName}-${supporter.signedOn}`}
            >
              <td className={BODY_CELL}>
                <Text as="span" inline size="small">
                  {supporter.publicName}
                </Text>
              </td>
              <td className={BODY_CELL}>
                <Text as="span" color="muted" inline size="small">
                  {supporter.type}
                </Text>
              </td>
              <td className={BODY_CELL}>
                <Text as="span" color="muted" inline size="small">
                  {supporter.country}
                </Text>
              </td>
              <td className={BODY_CELL}>
                <Text as="span" color="muted" family="mono" inline size="small">
                  {supporter.principlesVersion}
                </Text>
              </td>
              <td className={BODY_CELL}>
                <Text as="span" color="muted" family="mono" inline size="small">
                  {supporter.signedOn}
                </Text>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The register as a slow roll, for the front page.
//
// The front page printed the whole table. That is the right shape for
// /principles, where the register IS the page, and the wrong one for a front
// page: it grows without bound, and at thirteen signatures it already pushed
// "Build on PDPP" past the fold. The roll shows the same rows, in the same
// order the register publishes them, and hands the reader on to the table.
//
// HONESTY: this is a display treatment of the published register, not a live
// feed. Every row is a confirmed signature printed with its real signing date.
// Nothing here invents a signatory and nothing relabels an old date as though
// it had just landed — the movement is the only part that is new.
//
// Order is the register's own, oldest first, so rows arrive from the bottom in
// the order people actually signed. Sorting it newest-first would read as a
// feed of arrivals while running backwards through time.

// One row is ROLL_ROW_HEIGHT; the window shows ROLL_VISIBLE_ROWS of them.
// h-60 is 5 x h-12 — keep the two in step, or the mask fades mid-row.
const ROLL_VISIBLE_ROWS = 5;
const ROLL_WINDOW = "h-60";
const ROLL_ROW_HEIGHT = "h-12";

// Seconds of travel per row. The loop is exactly one copy tall, so
// rows x this is the duration, and the roll holds its speed as the register
// grows instead of accelerating.
const ROLL_SECONDS_PER_ROW = 3.5;

// Fades the top and bottom edges so rows enter and leave rather than being
// guillotined by the border.
const ROLL_MASK = cn(
  "[-webkit-mask-image:linear-gradient(to_bottom,transparent,black_2.5rem,black_calc(100%_-_2.5rem),transparent)]",
  "[mask-image:linear-gradient(to_bottom,transparent,black_2.5rem,black_calc(100%_-_2.5rem),transparent)]"
);

// max-w-none! releases `.pdpp-doc li`, which caps list items at the measure so
// prose lists stay readable. A row here is a table row wearing an <li>, and at
// the cap its rule stopped 600px short of the box it sits in.
const ROLL_ROW = cn(
  ROLL_ROW_HEIGHT,
  "grid max-w-none! grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-6 px-6",
  "border-border/60 border-b"
);

function rollRowKey(supporter: PublicSupporter): string {
  return `${supporter.publicName}-${supporter.signedOn}`;
}

function PdppSupportersRollTrack({
  ariaHidden,
  supporters,
}: {
  ariaHidden?: boolean;
  supporters: readonly PublicSupporter[];
}) {
  return (
    <ul aria-hidden={ariaHidden ? "true" : undefined}>
      {supporters.map((supporter) => (
        <li className={ROLL_ROW} key={rollRowKey(supporter)}>
          <Text as="span" inline size="small">
            {supporter.publicName}
          </Text>
          <Text as="span" color="muted" inline size="small">
            {supporter.type}, {supporter.country}
          </Text>
          <Text as="span" color="muted" family="mono" inline size="small">
            {supporter.signedOn}
          </Text>
        </li>
      ))}
    </ul>
  );
}

export function PdppSupportersRoll({ supporters }: { supporters: readonly PublicSupporter[] }) {
  if (supporters.length === 0) {
    return <PdppSupportersEmpty />;
  }

  // A register shorter than the window cannot roll: two stacked copies of a
  // two-row register leave three rows of nothing in a five-row window, and a
  // loop that short reads as a stutter rather than a roll. It sits still until
  // there is enough register to move.
  if (supporters.length <= ROLL_VISIBLE_ROWS) {
    return (
      <div className="border border-border" data-slot="pdpp-supporters-roll">
        <div className="[&>ul>li:last-child]:border-b-0">
          <PdppSupportersRollTrack supporters={supporters} />
        </div>
      </div>
    );
  }

  return (
    <div className="border border-border" data-slot="pdpp-supporters-roll">
      <div className={cn(ROLL_WINDOW, "overflow-hidden", ROLL_MASK)}>
        {/* Inline duration beats the placeholder in the shorthand; see the
            keyframes comment in styles/surfaces/concept/components.css. */}
        <div
          className={cn(
            "animate-[pdpp-supporters-roll_1s_linear_infinite] will-change-transform",
            "motion-reduce:animate-none hover:[animation-play-state:paused]"
          )}
          style={{ animationDuration: `${supporters.length * ROLL_SECONDS_PER_ROW}s` }}
        >
          <PdppSupportersRollTrack supporters={supporters} />
          {/* The same names again, for the seam. A screen reader reading the
              register twice per loop is noise; the first track carries it. */}
          <PdppSupportersRollTrack ariaHidden supporters={supporters} />
        </div>
      </div>
    </div>
  );
}
