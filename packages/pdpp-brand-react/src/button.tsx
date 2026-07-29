// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Button — Ink Carbon button component.
 *
 * Variants:
 *   default     — dark bg, light text. The machine confirms.
 *   human       — copper (--human). ONLY for owner consent acts.
 *                 The one warm element on a protocol surface.
 *   ghost       — outline, foreground text. Secondary/cancel.
 *   destructive — red outline. Irreversible acts only.
 *
 * Size:
 *   default — standard padding (9px 18px)
 *   sm      — compact (6px 12px)
 *   lg      — prominent (12px 22px); for full-width primary CTAs
 *
 * This component wraps a <button> element. For link-styled buttons use
 * the existing operator-ui Button with variant="link".
 */
// biome-ignore lint/correctness/noUnresolvedImports: Biome 2.5.5 cannot resolve pnpm's package directory; pnpm's Node resolver and tsc both resolve this declared dependency.
import { cva, type VariantProps } from "class-variance-authority";
import { type ButtonHTMLAttributes, forwardRef } from "react";
import "./components.css";

const buttonVariants = cva("pdpp-btn", {
  defaultVariants: {
    size: "default",
    variant: "default",
  },
  variants: {
    size: {
      default: "",
      lg: "pdpp-btn--lg",
      sm: "pdpp-btn--sm",
    },
    variant: {
      default: "",
      destructive: "pdpp-btn--destructive",
      ghost: "pdpp-btn--ghost",
      human: "pdpp-btn--human",
    },
  },
});

export interface IcButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

/**
 * IcButton (Ink Carbon Button) — use this prefix to avoid collision
 * with the existing operator-ui Button during the Phase 1→2 migration.
 */
const IcButton = forwardRef<HTMLButtonElement, IcButtonProps>(({ className, variant, size, ...props }, ref) => (
  <button className={buttonVariants({ className, size, variant })} ref={ref} {...props} />
));
IcButton.displayName = "IcButton";

export { buttonVariants, IcButton };
