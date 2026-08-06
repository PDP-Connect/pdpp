// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge, taught this app's theme.
 *
 * v3 mirrors Tailwind v4 theme namespaces — declare custom scales under
 * `extend.theme` with the namespace as the key. That covers every utility built
 * on the namespace (`text-` sizes, `p-`/`gap-` spacing, `max-w-` containers, …).
 *
 * Required here: anything in `--text-*` / `--spacing-*` / `--container-*` /
 * `--radius-*` that isn't a Tailwind default. Without `theme.text`, merge
 * treats `text-stamp` as a colour, so `text-teal` deletes it and type falls
 * back to inherited 17px.
 *
 * Custom `--color-*` names do **not** need listing — twMerge accepts any
 * colour token out of the box.
 *
 * Keep lists in step with editorial-tokens/semantic.css + brand semantic.css.
 *
 * @see https://github.com/dcastil/tailwind-merge/blob/main/docs/configuration.md
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      container: [
        // editorial
        "page",
        "measure",
        // brand
        "content",
      ],
      radius: ["pill"],
      spacing: [
        // editorial
        "pad",
        "gutter",
        "rail",
        "section-gap",
        // brand
        "inset",
        "sidebar",
      ],
      text: [
        // editorial type ladder
        "stamp",
        "eyebrow",
        "small",
        "note",
        "body",
        "lede",
        "heading",
        "deck",
        "title",
        "display",
        "numeral",
        // brand scale
        "caption",
        "label",
        "body-lg",
        "display-lg",
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
