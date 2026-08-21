// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type TextSize, textVariants } from "@pdpp/brand-react";
import type { VariantProps } from "class-variance-authority";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import type { ComponentPropsWithoutRef } from "react";
import { Mermaid } from "@/components/mdx/mermaid.tsx";
import { Text } from "@/components/typography/text.tsx";
import { cn } from "@/lib/utils.ts";

type HeadingProps = ComponentPropsWithoutRef<"h1">;
type ParagraphProps = ComponentPropsWithoutRef<"p">;
type ListItemProps = ComponentPropsWithoutRef<"li">;
type QuoteProps = ComponentPropsWithoutRef<"blockquote">;

// `title`/`display` rungs get optical-sizing "display" inside `Text` itself
// (see brand-react text.tsx `displaySizes`). Headings below bypass `Text`'s
// own render path (see the block comment above `heading` for why), so the
// same rung->optical rule is restated here rather than silently dropped.
const OPTICAL_DISPLAY_SIZES = new Set<TextSize>(["title", "display", "hero"]);

/**
 * Bind a `Text` size rung onto a heading className, without replacing
 * fumadocs' own `Heading` (id, `#anchor` link, copy button — see
 * fumadocs-ui/components/heading). `Text` as a component can't wrap that
 * heading's existing children (the anchor + button) without either
 * duplicating the anchor/copy-button markup or dropping it, so this reads
 * the same `textVariants` classes `Text` renders and merges them onto the
 * className fumadocs already outputs — same ladder, fumadocs keeps owning
 * the element.
 */
type TextWeight = VariantProps<typeof textVariants>["weight"];

function headingTextClassName(size: TextSize, weight?: TextWeight) {
  return textVariants({
    optical: OPTICAL_DISPLAY_SIZES.has(size) ? "display" : "auto",
    size,
    weight,
  });
}

/*
 * Spec prose maps onto the concept surface's ONE `Text` ladder instead of
 * carrying its own raw-element type rules (see specification.css, which used
 * to set font-size/line-height/font-weight for h1-h4/p/li/strong directly).
 * Prose gets a different SOURCE (MDX) — not a different type system.
 *
 * Rung choice was measured, not read off the old CSS (see
 * apps/site/scripts/style-differ.mjs and the mapping table in the commit that
 * introduced this file). No `family` prop/class: the doc surface's own
 * ambient `font-serif` (concept/components.css `[data-surface="concept"]`)
 * already matches every rung the old CSS set explicitly, so an explicit
 * family here would duplicate — not fix — that inheritance. `em` is not
 * mapped (no rule targeted it and none renders in spec content). `strong` IS
 * still an explicit rule in specification.css, not `Text`'s built-in
 * `[&_strong]:font-medium` — measured in a browser, `font-medium` (500) reads
 * as barely distinguishable from 400 body weight at this surface's serif
 * lede rung, a real legibility loss against the spec's functional use of
 * `<strong>` as inline mini-headers. See the comment on that rule.
 *
 * h1-h4 route through fumadocs' own `Heading` (via defaultMdxComponents),
 * not `Text` directly — `Heading` owns the `#anchor` link + copy button for
 * any heading with an `id`, and swapping it for `Text` silently drops that
 * affordance (proven with the differ: `display: flex -> block` on every
 * h2/h3). Only the className changes.
 */
// Rendered as JSX below (`<DefaultH1 ... />`), not called as plain functions —
// fumadocs' `Heading` is a React component and only React's own render path
// guarantees its component contract (hooks, forwardRef, memo, …) still holds
// if a future fumadocs release changes how `Heading` is implemented.
const DefaultH1 = defaultMdxComponents.h1;
const DefaultH2 = defaultMdxComponents.h2;
const DefaultH3 = defaultMdxComponents.h3;
const DefaultH4 = defaultMdxComponents.h4;

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Mermaid,
    h1: ({ className, ...props }: HeadingProps) => (
      <DefaultH1 className={cn(headingTextClassName("display"), className)} {...props} />
    ),
    h2: ({ className, ...props }: HeadingProps) => (
      <DefaultH2 className={cn(headingTextClassName("title"), className)} {...props} />
    ),
    h3: ({ className, ...props }: HeadingProps) => (
      <DefaultH3 className={cn(headingTextClassName("heading"), className)} {...props} />
    ),
    h4: ({ className, ...props }: HeadingProps) => (
      <DefaultH4 className={cn(headingTextClassName("lede", "semi"), className)} {...props} />
    ),
    p: ({ className, color: _color, children, ...props }: ParagraphProps) => (
      <Text as="p" className={className} size="lede" wrap="pretty" {...props}>
        {children}
      </Text>
    ),
    li: ({ className, color: _color, children, ...props }: ListItemProps) => (
      <Text as="li" className={className} size="lede" {...props}>
        {children}
      </Text>
    ),
    blockquote: ({ className, color: _color, children, ...props }: QuoteProps) => (
      <Text as="blockquote" className={className} size="lede" wrap="pretty" {...props}>
        {children}
      </Text>
    ),
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
