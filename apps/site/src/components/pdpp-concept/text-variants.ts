// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/*
 * Concept-only Text extensions. Shared mechanics/colors live in
 * `@pdpp/brand-react` `text-variants.ts`. This table owns editorial packaging
 * that is not a portable type rung:
 *   - colors: foreground-faint / on-primary-emphasis labels
 *   - sizes: stamp chip, callout box, deck (title + normal weight)
 *   - section-index chrome (const below, not a cva variant)
 *
 * Stamp is packaging on the shared `eyebrow` rung — the facade maps
 * size="stamp" → brand size="eyebrow". Do not re-emit text-eyebrow / uppercase /
 * tracking here. Stamp eyebrow tracking is a var rebind on the stamp size
 * variant — `[--text-eyebrow--letter-spacing:0.04em]`.
 *
 * Ladder rung enforcement lives in @pdpp/brand-react/text.test.ts — not here.
 * @see docs/design-system/styling-in-apps.md § Enforcement (tests)
 *
 * Same CVA rules as brand-react: config inline; shared fragments as consts.
 */
import { cva } from "class-variance-authority";

export const CONCEPT_ONLY_COLORS = [
  "subtle",
  "accentStrong",
  "onWash",
  "onAccent",
  "onAccentSoft",
  "onAccentLabel",
] as const;

export const CONCEPT_ONLY_SIZES = ["stamp", "callout", "deck"] as const;

export type ConceptOnlyColor = (typeof CONCEPT_ONLY_COLORS)[number];
export type ConceptOnlySize = (typeof CONCEPT_ONLY_SIZES)[number];

export const conceptTextVariants = cva("", {
  variants: {
    color: {
      subtle: "text-foreground-faint",
      accentStrong: "text-primary-emphasis",
      onWash: "text-primary-on-wash",
      onAccent: "text-on-primary-emphasis",
      onAccentSoft: "text-on-primary-emphasis-soft",
      onAccentLabel: "text-on-primary-emphasis-label",
    },
    size: {
      // Chip extras only — brand Text owns eyebrow voice + rung.
      stamp: [
        "[font-variant-numeric:tabular-nums]",
        // Rebind eyebrow tracking for stamp chip — not tracking-[…] (fights text-eyebrow).
        "[--text-eyebrow--letter-spacing:0.04em]",
      ],
      callout: [
        "max-w-measure text-pretty text-body text-foreground",
        "my-6 border-primary border-l-2 bg-primary-wash px-5 py-4",
      ],
      // Title rung, normal weight — editorial identity line.
      deck: "text-pretty font-normal text-title",
    },
    /** Stamp default accent when caller left color at brand foreground/default. */
    stampAccent: {
      true: "text-primary",
    },
  },
});

/* Section index numeral on size="title" — concept chrome, not a cva variant. */
export const sectionIndexNumeralClassName = [
  "me-3",
  "font-mono text-[0.85em] font-normal tracking-[0.04em] text-primary",
  "tabular-nums lining-nums",
  "select-none",
  "min-[1000px]:absolute min-[1000px]:top-[0.15em] min-[1000px]:right-[calc(100%+0.6em)] min-[1000px]:me-0 min-[1000px]:align-baseline",
];

export function isConceptOnlyColor(color: string | null | undefined): color is ConceptOnlyColor {
  return typeof color === "string" && (CONCEPT_ONLY_COLORS as readonly string[]).includes(color);
}

export function isConceptOnlySize(size: string | null | undefined): size is ConceptOnlySize {
  return typeof size === "string" && (CONCEPT_ONLY_SIZES as readonly string[]).includes(size);
}
