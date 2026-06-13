/**
 * Scope — one stream/scope row inside a consent sheet.
 *
 * A Scope has a name (mono voice — protocol identifier), a terms string
 * (also mono, right-aligned), and an optional description (grotesk).
 *
 * Declined scopes: pass `off` to render the name struck-out.
 * Revocation = struck, not erased.
 */
import type { ReactNode } from "react";
import "./components.css";

interface ScopeProps {
  className?: string;
  /** Human-readable description of what this scope provides. */
  description?: string;
  /** The stream/scope identifier. Rendered in mono voice. */
  name: string;
  /** Scope was declined by the owner at consent. */
  off?: boolean;
  /** Terms string (e.g. "read · 30 days"). Mono, right-aligned. */
  terms?: string;
  /** Extra content in the terms slot (overrides `terms` string). */
  termsSlot?: ReactNode;
}

export function Scope({ name, terms, description, off, termsSlot, className }: ScopeProps) {
  const cls = ["pdpp-scope", off ? "pdpp-scope--off" : undefined, className].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <span className="pdpp-scope__name">{name}</span>
      {(terms || termsSlot) && <span className="pdpp-scope__terms">{termsSlot ?? terms}</span>}
      {description && <span className="pdpp-scope__desc">{description}</span>}
    </div>
  );
}
