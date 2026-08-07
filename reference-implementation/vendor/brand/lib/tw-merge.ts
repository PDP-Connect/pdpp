// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// biome-ignore lint/correctness/noUnresolvedImports: Biome can't resolve pnpm package exports; tsc validates.
import { type ClassValue, clsx } from "clsx";
// biome-ignore lint/correctness/noUnresolvedImports: Biome can't resolve pnpm package exports; tsc validates.
import { type Config, extendTailwindMerge, mergeConfigs } from "tailwind-merge";

/**
 * Brand theme keys for tailwind-merge.
 *
 * Keep in step with tokens/semantic.css `@theme` custom scales
 * (`--text-*`, `--spacing-*`, `--container-*`, `--radius-*` that aren't
 * Tailwind defaults). Unlisted `text-*` sizes are treated as colours.
 *
 * Custom `--color-*` names need no listing.
 *
 * @see https://github.com/dcastil/tailwind-merge/blob/main/docs/configuration.md
 */
export const pdppBrandTheme = {
  container: ["content", "measure"],
  radius: ["pill"],
  spacing: ["sidebar"],
  // The eight type rungs, in ladder order. Exactly the `--text-*` names in
  // tokens/semantic.css — one entry per rank, no treatment aliases.
  text: ["eyebrow", "small", "body", "lede", "heading", "title", "display", "hero"],
} as const;

/** Compose into app-level `extendTailwindMerge(..., withPdppBrand)`. */
export function withPdppBrand(config: Config<string, string>): Config<string, string> {
  return mergeConfigs<string, string>(config, {
    extend: {
      theme: { ...pdppBrandTheme },
    },
  });
}

export const twMerge = extendTailwindMerge(withPdppBrand);

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
