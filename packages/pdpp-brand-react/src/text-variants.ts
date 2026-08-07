// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/*
 * Shared text presentation. The table is portable; the values are not.
 *
 * Every class here resolves through a brand `@theme` variable —
 * `--color-foreground`, `--color-muted-foreground`, `--color-primary`,
 * `--text-body`, … A surface themes `Text` by rebinding those CSS variables
 * (never by passing a theme object, class map or provider into React).
 *
 * Color keys match shadcn/brand semantics (`foreground`, `muted`, `primary`).
 * Surface-specific packaging (stamp chip, callout, deck) belongs on the
 * surface facade. Never put a literal palette name (`teal`, `ink`, `slate`)
 * in this table.
 *
 * Rule: a rung in brand `tokens/semantic.css` is a size here (1:1) —
 * eyebrow · small · body · lede · heading · title · display · hero.
 * Enforced by `text.test.ts` in this package (not duplicated in site concept tests).
 * @see docs/design-system/styling-in-apps.md § Enforcement (tests)
 * Treatments that are not rungs (italic caption, concept deck/stamp chip)
 * stay off this table.
 *
 * Ownership: token owns metrics · CVA owns voice · packaging does not
 * re-emit the rung. Size ⊥ color. See styling-in-apps.md § Text ownership.
 *
 * cva() config stays inline (extracted config widens defaultVariants literals).
 * Shared class fragments that appear 2+ times stay as consts — CVA accepts
 * ClassValue arrays; do not flatten with .join(" ").
 */
import { cva } from "class-variance-authority";

const withIconBase = [
  "inline-flex items-center gap-[0.45em]",
  "[&_svg:not([class*=size-]):not([data-slot=spinner])]:size-[0.9em]",
  "[&_svg[data-slot=spinner]]:size-[0.8em]",
] as const;

const withIconDisplaySvg = [
  "[&_svg:not([class*=size-]):not([data-slot=spinner])]:size-[1.1em]",
  "[&_svg[data-slot=spinner]]:size-[0.75em]",
] as const;

export const textVariants = cva(["[&_strong]:font-medium"], {
  variants: {
    color: {
      inherit: "text-inherit",
      foreground: "text-foreground",
      muted: "text-muted-foreground",
      primary: "text-primary",
      background: "text-background",
    },
    size: {
      // Size inherit = emit nothing (cascade). Do not use text-[inherit] —
      // TW treats that as a *color* arbitrary; color inherit is text-inherit above.
      inherit: "",
      // Voice only (uppercase + nowrap + sans). Size/lh/tracking/weight come
      // from `text-eyebrow` → `--text-eyebrow*` — never hardcode tracking here.
      eyebrow: "whitespace-nowrap font-sans text-eyebrow uppercase",
      small: "text-small",
      body: "text-body",
      lede: "text-lede",
      heading: "text-heading",
      title: "text-title",
      display: "text-display",
      hero: "text-hero",
    },
    family: {
      inherit: "",
      sans: "font-sans",
      mono: "font-mono",
      serif: "font-serif",
    },
    weight: {
      bold: "font-bold",
      light: "font-light",
      medium: "font-medium",
      mediumNormal: "font-[450]",
      normal: "font-normal",
      semi: "font-semibold",
      thin: "font-thin",
    },
    align: {
      center: "text-center",
      left: "text-left",
      right: "text-right",
    },
    // Wrap policy lives here — not on size, not a boolean `balance` dupe.
    // Size compounds below apply pretty/balance only when wrap="normal"
    // (default). Explicit wrap="balanced"|"pretty"|"nowrap" skips those
    // compounds so the override wins (bare compounds would run after variants
    // and beat wrap).
    wrap: {
      normal: "",
      balanced: "text-balance",
      pretty: "text-pretty",
      nowrap: "whitespace-nowrap",
    },
    bullet: {
      true: "list-disc",
    },
    caps: {
      true: "uppercase",
    },
    clamp: {
      "1": "line-clamp-1",
      "2": "line-clamp-2",
      "3": "line-clamp-3",
      "4": "line-clamp-4",
      "5": "line-clamp-5",
      "6": "line-clamp-6",
      none: "line-clamp-none",
    },
    inline: {
      true: "leading-none",
    },
    // Prose link treatment — not CSS `underline`. Class lives in
    // `packages/pdpp-brand/styles/utilities.css` (`@utility link-prose`); surfaces
    // theme it by rebinding `--primary` / `--color-primary`.
    link: {
      true: "link-prose",
    },
    numeric: {
      proportional: "[font-variant-numeric:proportional-nums]",
      tabular: "[font-variant-numeric:tabular-nums]",
    },
    optical: {
      auto: "[font-optical-sizing:auto]",
      display: '[font-variation-settings:"opsz"_var(--font-display-opsz)]',
    },
    pre: {
      true: "whitespace-pre-wrap font-mono",
    },
    textBox: {
      true: "[text-box:trim-both_cap_text]",
    },
    truncate: {
      true: "w-max min-w-0 max-w-full truncate",
    },
    withIcon: {
      true: [...withIconBase],
    },
    withInlineIcon: {
      true: ["[&_[data-icon=inline-start]]:mr-[0.1em]", "[&_[data-icon=inline-end]]:ml-[0.1em]"],
    },
  },
  compoundVariants: [
    // Default wrap policy per size — gated on wrap="normal" so an explicit
    // wrap= override is not clobbered (compounds run after variants).
    {
      className: "text-pretty",
      size: ["body", "small", "lede"],
      wrap: "normal",
    },
    {
      className: "text-balance",
      size: ["heading", "title", "display", "hero"],
      wrap: "normal",
    },
    {
      className: [...withIconDisplaySvg],
      size: ["heading", "title", "display", "hero"],
      withIcon: true,
    },
    {
      className: "gap-[0.25em]",
      size: ["heading", "title", "display", "hero"],
      withIcon: true,
    },
    {
      className: "gap-[0.375em]",
      size: ["lede", "body"],
      withIcon: true,
    },
    {
      align: "center",
      className: "justify-center",
      withIcon: true,
    },
  ],
  defaultVariants: {
    color: "foreground",
    size: "body",
    optical: "auto",
    wrap: "normal",
  },
});
