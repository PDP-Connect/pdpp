// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { cva } from "class-variance-authority";

/*
 * Intents = editorial.css document type (one ladder). Tokens live in
 * styles/editorial-tokens/semantic.css. Do not add a parallel Vana scale.
 *
 * cva() config stays inline (extracted config widens defaultVariants literals).
 * Shared class fragments that appear 2+ times stay as consts — CVA accepts
 * ClassValue arrays; do not flatten with .join(" ").
 */
const labelUpper = "font-sans uppercase leading-none tracking-[0.08em]";

export const textVariants = cva(["[&_strong]:font-medium"], {
  variants: {
    color: {
      inherit: "text-inherit",
      ink: "text-ink",
      soft: "text-ink-soft",
      faint: "text-ink-faint",
      teal: "text-teal",
      tealDeep: "text-teal-deep",
      tealOnWash: "text-teal-on-wash",
      paper: "text-paper",
      onTealDeep: "text-onteal-deep",
      onTealDeepSoft: "text-onteal-deep-soft",
      onTealDeepLabel: "text-onteal-deep-label",
    },
    intent: {
      inherit: "",
      body: "text-pretty text-body",
      small: "text-pretty text-small",
      caption: "text-pretty text-small italic",
      eyebrow: ["whitespace-nowrap text-eyebrow", labelUpper],
      lede: "text-pretty text-lede",
      deck: "text-pretty text-deck",
      note: "text-pretty text-note",
      callout: ["max-w-measure text-pretty text-ink text-note", "my-6 border-teal border-l-2 bg-teal-wash px-5 py-4"],
      stamp: ["whitespace-nowrap text-stamp", labelUpper, "[font-variant-numeric:tabular-nums]"],
      heading: "text-balance text-heading",
      title: "text-balance text-title",
      display: "text-balance text-display",
      numeral: "text-numeral [font-variant-numeric:tabular-nums_lining-nums]",
    },
    align: {
      center: "text-center",
      left: "text-left",
      right: "text-right",
    },
    balance: {
      true: "text-balance",
    },
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
    link: {
      false: "",
      true: "link-prose",
    },
    mono: {
      true: "font-mono",
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
    underline: {
      false: "",
      true: "link-prose",
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
    withIcon: {
      true: [
        "inline-flex items-center gap-[0.45em]",
        "[&_svg:not([class*=size-]):not([data-slot=spinner])]:size-[0.9em]",
        "[&_svg[data-slot=spinner]]:size-[0.8em]",
      ],
    },
    withInlineIcon: {
      true: ["[&_[data-icon=inline-start]]:mr-[0.1em]", "[&_[data-icon=inline-end]]:ml-[0.1em]"],
    },
  },
  compoundVariants: [
    {
      className: "text-ink-faint",
      color: "ink",
      intent: "eyebrow",
    },
    {
      className: "text-ink-soft",
      color: "ink",
      intent: ["caption", "small"],
    },
    {
      className: "text-teal",
      color: "ink",
      intent: "stamp",
    },
    // Mono stamp = status line (not the bordered sans chip): tighter tracking, beat stamp's font-sans
    {
      className: "font-mono tracking-[0.04em]",
      intent: "stamp",
      mono: true,
    },
    // Mono stamp = status line (not the bordered sans chip): tighter tracking, beat stamp's font-sans
    {
      className: "font-mono tracking-[0.04em]",
      intent: "stamp",
      mono: true,
    },
    {
      className: [
        "[&_svg:not([class*=size-]):not([data-slot=spinner])]:size-[1.1em]",
        "[&_svg[data-slot=spinner]]:size-[0.75em]",
      ],
      intent: ["heading", "title", "display"],
      withIcon: true,
    },
    {
      className: "gap-[0.25em]",
      intent: ["heading", "title", "display", "deck", "numeral"],
      withIcon: true,
    },
    {
      className: "gap-[0.375em]",
      intent: ["lede", "body", "note", "callout"],
      withIcon: true,
    },
    {
      align: "center",
      className: "justify-center",
      withIcon: true,
    },
  ],
  defaultVariants: {
    color: "ink",
    intent: "body",
    optical: "auto",
  },
});

/** Section index numeral on intent="title" — used by Text, not a cva variant. */
export const sectionIndexNumeralClassName = [
  "me-3",
  "font-mono text-[0.9em] font-normal tracking-[0.04em] text-teal",
  "tabular-nums lining-nums",
  "select-none",
  "min-[1000px]:absolute min-[1000px]:top-[0.1em] min-[1000px]:right-[calc(100%+0.6em)] min-[1000px]:me-0 min-[1000px]:align-baseline",
];
