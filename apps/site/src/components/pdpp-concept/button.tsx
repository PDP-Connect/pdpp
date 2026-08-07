// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils.ts";

/*
 * Editorial CTAs built from the Base UI primitive and shadcn semantic tokens.
 * Kept under pdpp-concept, not @/components/ui (that re-exports operator brand).
 * `!` beats [data-surface="concept"] a color/underline.
 */
const buttonVariants = cva(
  [
    "box-border inline-flex cursor-pointer select-none items-center justify-center",
    "min-h-11 px-5 py-[13px]",
    "rounded-[2px] border border-primary",
    "no-underline! font-medium font-sans text-small leading-none",
    "outline-none transition-[background-color,color,border-color] duration-150 ease-out",
    "focus-visible:outline-none",
    "disabled:pointer-events-none disabled:opacity-50",
  ],
  {
    defaultVariants: {
      variant: "primary",
    },
    variants: {
      variant: {
        primary: [
          "bg-primary text-primary-foreground!",
          "hover:border-primary-emphasis hover:bg-primary-emphasis hover:text-on-primary-emphasis!",
          "focus-visible:border-primary-emphasis focus-visible:bg-primary-emphasis focus-visible:text-on-primary-emphasis!",
        ],
        secondary: [
          "bg-transparent text-primary!",
          "hover:bg-primary-wash hover:text-primary-emphasis!",
          "focus-visible:bg-primary-wash focus-visible:text-primary-emphasis!",
        ],
        quiet: [
          "border-transparent px-1 text-muted-foreground!",
          "hover:text-primary-emphasis! hover:underline hover:underline-offset-[3px]",
          "focus-visible:text-primary-emphasis! focus-visible:underline focus-visible:underline-offset-[3px]",
        ],
        footer: [
          "border-on-primary-emphasis/30 bg-transparent text-on-primary-emphasis!",
          "hover:border-on-primary-emphasis hover:bg-on-primary-emphasis/10 hover:text-white!",
          "focus-visible:border-on-primary-emphasis focus-visible:bg-on-primary-emphasis/10 focus-visible:text-white!",
        ],
      },
    },
  }
);

function Button({
  className,
  variant = "primary",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      className={cn(buttonVariants({ variant }), className)}
      data-slot="pdpp-concept-button"
      {...props}
    />
  );
}

export { Button, buttonVariants };
