/**
 * Carbon — the server's retained copy wrapper.
 *
 * Wrapping a Sheet in <Carbon> renders the offset duplicate behind it:
 * a tinted rectangle translated (--carbon-offset, --carbon-offset)
 * down-right, representing the copy the server keeps on the owner's behalf.
 *
 * USE ONLY on objects the server actually retains:
 *   - a staged consent request waiting for owner approval
 *   - a held grant the server references
 *   - an export in flight
 *
 * NEVER use for decoration. If nothing is retained, no Carbon.
 * Maximum 2 Carbon wrappers per screen (spec constraint).
 *
 * Copyline renders the "Carbon — your copy stays here" caption
 * in the typed mono voice.
 */
import type { ReactNode } from "react";
import "./components.css";

// ─── Carbon ───────────────────────────────────────────────────────

interface CarbonProps {
  children: ReactNode;
  className?: string;
}

export function Carbon({ className, children }: CarbonProps) {
  return <div className={["pdpp-carbon", className].filter(Boolean).join(" ")}>{children}</div>;
}

// ─── Copyline ─────────────────────────────────────────────────────

interface CopylineProps {
  /** Override the default text. Default: "Carbon — your copy stays here" */
  children?: ReactNode;
  className?: string;
}

export function Copyline({ children = "Carbon — your copy stays here", className }: CopylineProps) {
  return <span className={["pdpp-copyline", className].filter(Boolean).join(" ")}>{children}</span>;
}
