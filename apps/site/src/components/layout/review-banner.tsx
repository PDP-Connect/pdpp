// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { siteFlags } from "@/lib/site-config.ts";
import { cn } from "@/lib/utils.ts";

// The full-width review ticker, under the header, on the accent ground.
//
// One link, not a bar containing a link: the whole strip is the target, so a
// reader who aims anywhere along it lands on /review. Wrapping the marquee in
// the anchor rather than putting an anchor inside it is what makes that true
// without a click handler.
//
// The marquee is CSS-only. A JS ticker re-renders on every frame and fights
// the browser's own compositor; a single transform animation on a duplicated
// track runs off the main thread. The track is rendered TWICE and translated
// by exactly -50%, which is what makes the loop seamless: at the moment the
// first copy leaves, the second is exactly where the first began.
//
// aria-hidden on the second copy: it is the same words again, and a screen
// reader announcing the message twice per loop is noise. The first copy
// carries the accessible text, and the anchor's own label states the
// destination.
//
// prefers-reduced-motion PAUSES rather than hides: the message still has to be
// readable by someone who has asked for less movement, so the animation stops
// with the track at its start rather than the strip disappearing.

const MESSAGE = "The specification is open for comment until 1 October.";
const CALL_TO_ACTION = "Review it now →";

// Wide gaps and a slash between repeats, per the design. The separator is a
// glyph rather than a border so it travels with the text.
const SEPARATOR = "/";

function TickerTrack({ ariaHidden }: { ariaHidden?: boolean }) {
  return (
    <span aria-hidden={ariaHidden ? "true" : undefined} className="flex shrink-0 items-center gap-[120px] pr-[120px]">
      <span className="flex items-center gap-[120px]">
        <span>{MESSAGE}</span>
        <span>{CALL_TO_ACTION}</span>
        <span aria-hidden="true">{SEPARATOR}</span>
      </span>
      <span className="flex items-center gap-[120px]">
        <span>{MESSAGE}</span>
        <span>{CALL_TO_ACTION}</span>
        <span aria-hidden="true">{SEPARATOR}</span>
      </span>
    </span>
  );
}

export function PdppReviewBanner() {
  if (!siteFlags.reviewOpen) {
    return null;
  }

  return (
    <Link
      aria-label="The specification is open for comment until 1 October. Review it now."
      className={cn(
        "group block overflow-hidden bg-primary-emphasis no-underline",
        "text-on-primary-emphasis hover:text-white!",
        "border-[color-mix(in_srgb,var(--primary)_55%,transparent)] border-b"
      )}
      data-slot="pdpp-review-banner"
      href="/review"
    >
      <div className="flex w-max animate-[pdpp-ticker_55s_linear_infinite] items-center py-2 font-sans text-[13px] tracking-[0.01em] whitespace-nowrap motion-reduce:animate-none">
        <TickerTrack />
        <TickerTrack ariaHidden />
      </div>
    </Link>
  );
}
