/**
 * Surface wrappers — flat temperature tints.
 *
 * The temperature system: a protocol-authored surface is a flat ink tint
 * behind a hairline; a human surface is a flat warm tint. The author
 * shows in the VOICE (mono vs grotesk), not in a colored stripe.
 *
 * ProtocolSurface — blue tint, for machine-authored/protocol content.
 * HumanSurface    — copper tint, for owner-authored/consent content.
 *
 * These render as `data-surface="protocol|human"` — the attribute
 * selector in components.css handles styling so tokens update it automatically.
 */
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import "./components.css";

// ─── ProtocolSurface ─────────────────────────────────────────────

interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function ProtocolSurface({ className, children, ...rest }: SurfaceProps) {
  return (
    <div className={className} data-surface="protocol" {...rest}>
      {children}
    </div>
  );
}

// ─── HumanSurface ────────────────────────────────────────────────

export function HumanSurface({ className, children, ...rest }: SurfaceProps) {
  return (
    <div className={className} data-surface="human" {...rest}>
      {children}
    </div>
  );
}
