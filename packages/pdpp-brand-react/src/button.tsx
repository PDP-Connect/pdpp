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
import { cva, type VariantProps } from "class-variance-authority";
import { type ButtonHTMLAttributes, forwardRef } from "react";
import "./components.css";

const buttonVariants = cva("pdpp-btn", {
  variants: {
    variant: {
      default: "",
      human: "pdpp-btn--human",
      ghost: "pdpp-btn--ghost",
      destructive: "pdpp-btn--destructive",
    },
    size: {
      default: "",
      sm: "pdpp-btn--sm",
      lg: "pdpp-btn--lg",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

export interface IcButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

/**
 * IcButton (Ink Carbon Button) — use this prefix to avoid collision
 * with the existing operator-ui Button during the Phase 1→2 migration.
 */
const IcButton = forwardRef<HTMLButtonElement, IcButtonProps>(({ className, variant, size, ...props }, ref) => (
  <button className={buttonVariants({ variant, size, className })} ref={ref} {...props} />
));
IcButton.displayName = "IcButton";

export { buttonVariants, IcButton };
