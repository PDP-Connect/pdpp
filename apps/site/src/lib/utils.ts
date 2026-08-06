// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { withPdppBrand } from "@pdpp/brand/tw-merge";
import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Site cn = brand twMerge + editorial theme keys.
 *
 * Brand scales live in `@pdpp/brand/tw-merge`. Editorial-only keys
 * (`stamp`, `pad`, `page`, …) stay here — keep in step with
 * editorial-tokens/semantic.css.
 *
 * @see https://github.com/dcastil/tailwind-merge/blob/main/docs/configuration.md
 */
const twMerge = extendTailwindMerge(
  {
    extend: {
      theme: {
        container: ["page", "measure"],
        spacing: ["pad", "gutter", "rail", "section-gap"],
        text: ["stamp", "small", "note", "lede", "deck", "numeral"],
      },
    },
  },
  withPdppBrand
);

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
