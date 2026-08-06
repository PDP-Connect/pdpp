// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils.ts";

/*
 * Editorial CTAs — replaces `.pdpp-cta*` BEM. Base UI primitive + concept
 * tokens (ink/paper/teal). Kept under pdpp-concept, not @/components/ui
 * (that re-exports operator brand). `!` beats `.pdpp-concept a` color/underline.
 */
const buttonVariants = cva(
  [
    "box-border inline-flex cursor-pointer select-none items-center justify-center",
    "min-h-11 px-5 py-[13px]",
    "rounded-[2px] border border-teal",
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
          "bg-teal text-paper!",
          "hover:border-teal-deep hover:bg-teal-deep hover:text-onteal-deep!",
          "focus-visible:border-teal-deep focus-visible:bg-teal-deep focus-visible:text-onteal-deep!",
        ],
        secondary: [
          "bg-transparent text-teal!",
          "hover:bg-teal-wash hover:text-teal-deep!",
          "focus-visible:bg-teal-wash focus-visible:text-teal-deep!",
        ],
        quiet: [
          "border-transparent px-1 text-ink-soft!",
          "hover:text-teal-deep! hover:underline hover:underline-offset-[3px]",
          "focus-visible:text-teal-deep! focus-visible:underline focus-visible:underline-offset-[3px]",
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
      className={cn(buttonVariants({ variant, className }))}
      data-slot="pdpp-concept-button"
      {...props}
    />
  );
}

export { Button, buttonVariants };
