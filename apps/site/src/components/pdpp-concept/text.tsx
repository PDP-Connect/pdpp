// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { VariantProps } from "class-variance-authority";
import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";
import { Fragment, isValidElement } from "react";

import { cn } from "@/lib/utils.ts";
import { sectionIndexNumeralClassName, textVariants } from "./text-variants.ts";

type TextIntent = NonNullable<VariantProps<typeof textVariants>["intent"]>;
const displayIntents = new Set<TextIntent>(["title", "display", "deck", "numeral"]);

// Doubles: &ldquo; &rdquo; / Singles: &lsquo; &rsquo; (contractions keep closing)
const WORD_CHAR = /\w/u;

const formatText = (text: string): string => {
  let singleOpen = true;
  let doubleOpen = true;

  return text
    .replaceAll('"', () => {
      const quote = doubleOpen ? "\u201C" : "\u201D";
      doubleOpen = !doubleOpen;
      return quote;
    })
    .replaceAll("'", (_match, offset, source) => {
      const prev = offset > 0 ? source[offset - 1] : "";
      const next = offset < source.length - 1 ? source[offset + 1] : "";
      // Contractions (doesn't, it's): always a closing apostrophe, not an open quote.
      if (WORD_CHAR.test(prev) && WORD_CHAR.test(next)) {
        return "\u2019";
      }
      const quote = singleOpen ? "\u2018" : "\u2019";
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

type TextProps<T extends ElementType = "p"> = VariantProps<typeof textVariants> &
  Omit<ComponentPropsWithoutRef<T>, "color"> & {
    as?: T;
    children: ReactNode;
    /** Section index on intent="title" only (e.g. "01"). Other inline spans in the title are unaffected. */
    sectionIndex?: string;
  };

// function decl (not const arrow): in .tsx, `<T extends … = "p">(` is ambiguous JSX.
export function Text<T extends ElementType = "p">({
  as: Component,
  className,
  intent,
  color,
  weight,
  align,
  caps,
  clamp,
  inline,
  mono,
  wrap = "normal",
  balance,
  optical,
  truncate,
  numeric,
  bullet,
  textBox,
  pre,
  underline,
  link,
  withIcon,
  withInlineIcon,
  sectionIndex,
  children,
  ...props
}: TextProps<T>) {
  const ResolvedComponent = Component ?? "p";
  const bulletProp = ResolvedComponent === "li" ? true : bullet;
  const preProp = ResolvedComponent === "pre" ? true : pre;
  const underlineProp = underline;
  const linkProp = link;
  const resolvedOptical = optical ?? (displayIntents.has(intent ?? "body") ? "display" : "auto");

  const formattedChildren: ReactNode = typeof children === "string" ? formatText(children) : children;

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
      className={cn(
        textVariants({
          align,
          balance,
          bullet: bulletProp,
          caps,
          clamp,
          className,
          color,
          inline,
          intent,
          link: linkProp,
          mono,
          numeric,
          optical: resolvedOptical,
          pre: preProp,
          textBox,
          truncate: needsTruncateWrap ? undefined : truncate,
          underline: underlineProp,
          weight,
          withIcon,
          withInlineIcon,
          wrap,
        }),
        sectionIndex && intent === "title" && "min-[1000px]:relative",
        needsTruncateWrap && "w-max min-w-0 max-w-full overflow-hidden"
      )}
      data-slot="pdpp-concept-text"
      {...props}
    >
      {sectionIndex ? (
        <span aria-hidden className={cn(sectionIndexNumeralClassName)} data-slot="pdpp-section-index">
          {sectionIndex}
        </span>
      ) : null}
      {renderedChildren}
    </ResolvedComponent>
  );
}
