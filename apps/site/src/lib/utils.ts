// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { withPdppBrand } from "@pdpp/brand/tw-merge";
import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Site cn = brand twMerge + editorial theme keys.
 *
 * Brand scales live in `@pdpp/brand/tw-merge` — including the full `--text-*`
 * ladder, which `@pdpp/brand-react`'s `Text` now owns. Only layout keys with
 * no shared counterpart stay here; keep them in step with
 * styles/surfaces/concept/tokens/semantic.css.
 *
 * @see https://github.com/dcastil/tailwind-merge/blob/main/docs/configuration.md
 */
const twMerge = extendTailwindMerge(
  {
    extend: {
      theme: {
        container: ["page", "measure"],
        spacing: ["pad", "gutter", "rail", "section-gap"],
      },
    },
  },
  withPdppBrand
);

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
