// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Concept `Text` — brand-react primitive + concept `text-variants` extensions.
 *
 * Shared mechanics live in `@pdpp/brand-react`. This facade:
 *   1. Pins defaults (`smartQuotes`, `data-slot`)
 *   2. Applies concept-only colors/sizes from `./text-variants.ts`
 *   3. Owns section-index chrome
 *
 * Values for shared colors come from `[data-surface="concept"]` rebinding
 * brand CSS variables (`--foreground` → ink, `--primary` → teal, …).
 */
import { Text as BrandText, type TextProps as BrandTextProps, type TextSize as BrandTextSize } from "@pdpp/brand-react";
import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils.ts";
import {
  type ConceptOnlyColor,
  type ConceptOnlySize,
  conceptTextVariants,
  isConceptOnlyColor,
  isConceptOnlySize,
  sectionIndexNumeralClassName,
} from "./text-variants.ts";

export type TextColor = BrandTextProps["color"] | ConceptOnlyColor;
export type TextSize = BrandTextSize | ConceptOnlySize;

export type TextProps<T extends ElementType = "p"> = Omit<BrandTextProps<T>, "color" | "size"> & {
  color?: TextColor;
  size?: TextSize;
  /** Section index on size="title" only (e.g. "01"). */
  sectionIndex?: string;
};

/** Concept packaging that rides a shared brand size (not inherit). */
const CONCEPT_SIZE_TO_BRAND: Partial<Record<ConceptOnlySize, BrandTextSize>> = {
  stamp: "eyebrow",
};

// function decl (not const arrow): in .tsx, `<T extends … = "p">(` is ambiguous JSX.
export function Text<T extends ElementType = "p">({
  color,
  size,
  sectionIndex,
  className,
  children,
  ...props
}: TextProps<T>) {
  const conceptColor = isConceptOnlyColor(color) ? color : undefined;
  const brandColor = (conceptColor ? undefined : color) as BrandTextProps<T>["color"];

  const conceptSize = isConceptOnlySize(size) ? size : undefined;
  const brandSize = (
    conceptSize ? (CONCEPT_SIZE_TO_BRAND[conceptSize] ?? "inherit") : size
  ) as BrandTextProps<T>["size"];

  const stampAccent =
    size === "stamp" && !conceptColor && (color === undefined || color === "foreground") ? true : undefined;

  const showSectionIndex = Boolean(sectionIndex) && size === "title";

  const renderedChildren: ReactNode = showSectionIndex ? (
    <>
      <span aria-hidden className={cn(sectionIndexNumeralClassName)} data-slot="pdpp-section-index">
        {sectionIndex}
      </span>
      {children}
    </>
  ) : (
    children
  );

  return (
    <BrandText<T>
      data-slot="pdpp-concept-text"
      smartQuotes
      {...(props as BrandTextProps<T>)}
      className={cn(
        conceptTextVariants({
          color: conceptColor,
          size: conceptSize,
          stampAccent,
        }),
        showSectionIndex && "min-[1000px]:relative",
        className
      )}
      color={brandColor}
      size={brandSize}
    >
      {renderedChildren}
    </BrandText>
  );
}
