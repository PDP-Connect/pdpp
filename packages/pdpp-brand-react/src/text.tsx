// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Text — the shared typographic primitive.
 *
 * Owns all portable mechanics: polymorphic host element, the variant table,
 * icon-aware truncation, optical sizing and smart quotes.
 * Owns no values: every class resolves through brand `@theme` variables that
 * the active surface rebinds (see concept `[data-surface="concept"]`).
 */
import { cn } from "@pdpp/brand/tw-merge";
import type { VariantProps } from "class-variance-authority";
import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";
import { Fragment, isValidElement } from "react";

import { textVariants } from "./text-variants.ts";

export type TextSize = NonNullable<VariantProps<typeof textVariants>["size"]>;
export type TextColor = NonNullable<VariantProps<typeof textVariants>["color"]>;

const displaySizes = new Set<TextSize>(["title", "display", "hero"]);

// Doubles: &ldquo; &rdquo; / Singles: &lsquo; &rsquo; (contractions keep closing)
const WORD_CHAR = /\w/u;

const formatText = (text: string): string => {
  let singleOpen = true;
  let doubleOpen = true;

  return text
    .replaceAll('"', () => {
      const quote = doubleOpen ? "“" : "”";
      doubleOpen = !doubleOpen;
      return quote;
    })
    .replaceAll("'", (_match, offset, source) => {
      const prev = offset > 0 ? source[offset - 1] : "";
      const next = offset < source.length - 1 ? source[offset + 1] : "";
      // Contractions (doesn't, it's): always a closing apostrophe, not an open quote.
      if (WORD_CHAR.test(prev) && WORD_CHAR.test(next)) {
        return "’";
      }
      const quote = singleOpen ? "‘" : "’";
      singleOpen = !singleOpen;
      return quote;
    });
};

const toChildArray = (nodes: ReactNode): ReactNode[] => {
  if (nodes === null || nodes === undefined || typeof nodes === "boolean") {
    return [];
  }
  return Array.isArray(nodes) ? nodes : [nodes];
};

const getTruncatedChildKey = (child: ReactNode): string => {
  if (isValidElement(child)) {
    if (child.key !== null && child.key !== undefined) {
      return String(child.key);
    }
    return `element-${String(child.type)}`;
  }
  if (typeof child === "string") {
    return `text-${child}`;
  }
  if (typeof child === "number") {
    return `num-${child}`;
  }
  return "child";
};

const renderTruncatedChild = (child: ReactNode): ReactNode => {
  if (isValidElement(child)) {
    const existing = (child.props as { className?: string }).className ?? "";
    if (existing.includes("shrink-0")) {
      return child;
    }
    return <span className="shrink-0">{child}</span>;
  }

  return <span className="min-w-0 truncate">{child}</span>;
};

const renderTruncatedChildren = (nodes: ReactNode): ReactNode => {
  const childArray = toChildArray(nodes);
  if (childArray.length === 1) {
    return renderTruncatedChild(childArray[0]);
  }
  return childArray.map((child) => (
    <Fragment key={getTruncatedChildKey(child)}>{renderTruncatedChild(child)}</Fragment>
  ));
};

export type TextProps<T extends ElementType = "p"> = VariantProps<typeof textVariants> &
  Omit<ComponentPropsWithoutRef<T>, "color"> & {
    as?: T;
    children: ReactNode;
    className?: string;
    "data-slot"?: string;
    /**
     * Curl straight quotes in string children. Off by default: editorial
     * surfaces opt in, surfaces that render machine data must not.
     */
    smartQuotes?: boolean;
  };

// function decl (not const arrow): in .tsx, `<T extends … = "p">(` is ambiguous JSX.
export function Text<T extends ElementType = "p">({
  as: Component,
  className,
  size,
  color,
  weight,
  align,
  caps,
  clamp,
  inline,
  family,
  wrap = "normal",
  optical,
  truncate,
  numeric,
  bullet,
  textBox,
  pre,
  link,
  withIcon,
  withInlineIcon,
  smartQuotes = false,
  children,
  "data-slot": dataSlot = "pdpp-text",
  ...props
}: TextProps<T>) {
  const ResolvedComponent = Component ?? "p";
  const bulletProp = ResolvedComponent === "li" ? true : bullet;
  const preProp = ResolvedComponent === "pre" ? true : pre;
  const resolvedOptical = optical ?? (displaySizes.has(size ?? "body") ? "display" : "auto");

  const formattedChildren: ReactNode = smartQuotes && typeof children === "string" ? formatText(children) : children;

  // text-overflow: ellipsis doesn't work on flex containers, so when both
  // withIcon (inline-flex) and truncate are active, we wrap text children in a
  // <span class="truncate"> and only apply overflow-hidden on the outer.
  const needsTruncateWrap = !!(withIcon && truncate);
  let renderedChildren: ReactNode = formattedChildren;
  if (needsTruncateWrap) {
    renderedChildren = renderTruncatedChildren(formattedChildren);
  }

  return (
    <ResolvedComponent
      {...props}
      className={cn(
        textVariants({
          align,
          bullet: bulletProp,
          caps,
          clamp,
          className,
          color,
          inline,
          size,
          family,
          link,
          numeric,
          optical: resolvedOptical,
          pre: preProp,
          textBox,
          truncate: needsTruncateWrap ? undefined : truncate,
          weight,
          withIcon,
          withInlineIcon,
          wrap,
        }),
        needsTruncateWrap && "w-max min-w-0 max-w-full overflow-hidden"
      )}
      data-slot={dataSlot}
    >
      {renderedChildren}
    </ResolvedComponent>
  );
}
