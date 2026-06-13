/**
 * Endorse — the typed status badge.
 *
 * The ONLY component where state color is spent. Every other surface
 * is achromatic (paper, ink, muted). Color here signals authorship
 * and state, never decoration.
 *
 * Variants:
 *   active      — green (--success): grant is live, data is flowing
 *   continuous  — blue (--primary): open-ended / indefinite grant
 *   expiring    — amber (--warning): expiring soon, owner attention
 *   revoked     — muted outline: struck, not erased
 *   denied      — red (--destructive): access denied
 *
 * The badge background and border are derived from currentColor
 * via color-mix so the variant modifier drives the entire badge.
 */
import { cva, type VariantProps } from "class-variance-authority";
import "./components.css";

const endorse = cva("pdpp-endorse", {
  variants: {
    status: {
      active: "pdpp-endorse--active",
      continuous: "pdpp-endorse--continuous",
      expiring: "pdpp-endorse--expiring",
      revoked: "pdpp-endorse--revoked",
      denied: "pdpp-endorse--denied",
    },
  },
  defaultVariants: {
    status: "active",
  },
});

/** Human-readable label for each status, matching the RFC voice. */
const LABEL: Record<NonNullable<EndorseProps["status"]>, string> = {
  active: "active",
  continuous: "continuous",
  expiring: "expiring",
  revoked: "revoked",
  denied: "denied",
};

interface EndorseProps extends VariantProps<typeof endorse> {
  className?: string;
  /** Override the default label derived from status. */
  label?: string;
}

export function Endorse({ status = "active", label, className }: EndorseProps) {
  const resolvedStatus = status ?? "active";
  return <span className={endorse({ status: resolvedStatus, className })}>{label ?? LABEL[resolvedStatus]}</span>;
}
