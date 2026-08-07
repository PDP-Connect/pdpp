// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Biome's resolver does not follow the package's import-only exports map; Node and TypeScript do.
// biome-ignore lint/correctness/noUnresolvedImports: verified by colors:generate and colors:check
import { bestContrastWith, color, colorMix, DesignBook, ref } from "design-book";

export interface ConceptScheme {
  dark: ConceptSchemeAnchors;
  light: ConceptSchemeAnchors;
  name: string;
}

interface ConceptSchemeAnchors {
  accent: string;
  ink: string;
  paper: string;
}

/**
 * The scheme rendered when no `?scheme=` is set. The generator emits it a
 * second time under bare `:root` / `[data-theme="dark"]`, and `tokens/index.css`
 * imports the generated file after `primitive.css`, so those blocks win on
 * source order and the default needs no attribute on <html> (no first-paint
 * flash). Set to `null` to hand the default back to `primitive.css`'s teal,
 * which stays in place underneath either way.
 */
export const defaultConceptSchemeName: string | null = "azure";

/**
 * Add experimental schemes here. Generated CSS is inert until the matching
 * `data-pdpp-concept-scheme` value is set on <html> — except for
 * `defaultConceptSchemeName` above, which is also emitted unqualified.
 */
export const conceptSchemes: ConceptScheme[] = [
  {
    name: "plum",
    light: {
      accent: "oklch(0.42 0.12 335)",
      ink: "oklch(0.19 0.018 335)",
      paper: "oklch(0.97 0.012 75)",
    },
    dark: {
      accent: "oklch(0.76 0.12 335)",
      ink: "oklch(0.93 0.012 75)",
      paper: "oklch(0.17 0.018 335)",
    },
  },
  {
    name: "moss",
    light: {
      accent: "oklch(0.45 0.1 145)",
      ink: "oklch(0.18 0.02 95)",
      paper: "oklch(0.97 0.025 95)",
    },
    dark: {
      accent: "oklch(0.76 0.13 145)",
      ink: "oklch(0.93 0.02 95)",
      paper: "oklch(0.16 0.02 145)",
    },
  },
  /**
   * The shipped default (see `defaultConceptSchemeName`): the original concept
   * palette hue-rotated off green into blue. Unlike plum and moss this invents
   * nothing — every L and C below is the corresponding token in
   * `styles/surfaces/concept/tokens/primitive.css` converted to oklch and
   * rounded. Only the hue moves — teal ~185 → azure 245.
   *
   *   paper  #f5f6f6 -> oklch(0.972 0.0011 197)   ink    #1a1a17 -> oklch(0.217 0.0057 107)
   *   accent #0e5a54 -> oklch(0.423 0.0695 187)   (dark) #4bb3a6 -> oklch(0.702 0.0979 184)
   *
   * Accent chroma stays at the teal's restrained 0.07/0.10 rather than
   * plum/moss's 0.10-0.13, because matching the original is the point. Contrast
   * on paper lands at 7.62:1 light and 6.81:1 dark, against the teal's 7.43 and
   * 7.02 — same footing, so no role below needed re-tuning.
   *
   * Paper and ink carry the teal's near-zero chroma (0.001-0.006, invisible)
   * but at the accent hue instead of the teal's incidental 197/107/264/165,
   * which are artefacts of hand-picked hex. Neutrals now agree with the accent.
   */
  {
    name: "azure",
    light: {
      accent: "oklch(0.42 0.07 245)",
      ink: "oklch(0.22 0.006 245)",
      paper: "oklch(0.97 0.001 245)",
    },
    dark: {
      accent: "oklch(0.7 0.1 245)",
      ink: "oklch(0.95 0.003 245)",
      paper: "oklch(0.21 0.004 245)",
    },
  },
];

export const conceptColorTokenNames = [
  "paper",
  "paper-deep",
  "paper-panel",
  "ink",
  "ink-soft",
  "ink-faint",
  "teal",
  "teal-deep",
  "teal-wash",
  "teal-on-wash",
  "onteal-deep",
  "onteal-deep-soft",
  "onteal-deep-label",
  "onteal-deep-wash",
] as const;

export type ConceptColorTokenName = (typeof conceptColorTokenNames)[number];

export function resolveConceptScheme(anchors: ConceptSchemeAnchors): Record<ConceptColorTokenName, string> {
  const book = new DesignBook("pdpp-concept-colors");
  const values = book.addScope("values");
  values.set("paper", color(anchors.paper));
  values.set("ink", color(anchors.ink));
  values.set("accent", color(anchors.accent));

  const contrastChoices = book.addScope("contrastChoices");
  contrastChoices.set("paper", ref("values.paper"));
  contrastChoices.set("ink", ref("values.ink"));

  const roles = book.addScope("roles");
  roles.set("paper", ref("values.paper"));
  roles.set("paper-deep", colorMix(ref("values.paper"), ref("values.ink"), { ratio: 0.06 }));
  roles.set("paper-panel", colorMix(ref("values.paper"), ref("values.accent"), { ratio: 0.12 }));
  roles.set("ink", ref("values.ink"));
  roles.set("ink-soft", colorMix(ref("values.ink"), ref("values.paper"), { ratio: 0.28 }));
  roles.set("ink-faint", colorMix(ref("values.ink"), ref("values.paper"), { ratio: 0.4 }));
  roles.set("teal", ref("values.accent"));
  roles.set("teal-deep", colorMix(ref("values.accent"), ref("values.ink"), { ratio: 0.34 }));
  roles.set("teal-wash", colorMix(ref("values.paper"), ref("values.accent"), { ratio: 0.08 }));
  roles.set("teal-on-wash", bestContrastWith(ref("roles.teal-wash"), contrastChoices));
  roles.set("onteal-deep", bestContrastWith(ref("roles.teal-deep"), contrastChoices));
  roles.set("onteal-deep-soft", colorMix(ref("roles.onteal-deep"), ref("roles.teal-deep"), { ratio: 0.18 }));
  roles.set("onteal-deep-label", colorMix(ref("roles.onteal-deep"), ref("roles.teal-deep"), { ratio: 0.42 }));
  roles.set("onteal-deep-wash", colorMix(ref("roles.onteal-deep"), ref("roles.teal-deep"), { ratio: 0.08 }));

  return Object.fromEntries(conceptColorTokenNames.map((name) => [name, book.resolve(`roles.${name}`)])) as Record<
    ConceptColorTokenName,
    string
  >;
}
