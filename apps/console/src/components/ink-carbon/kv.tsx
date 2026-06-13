/**
 * KV — typed key/value record block.
 *
 * Keys: grotesk, muted (labels for humans).
 * Values: mono, tabular-nums (protocol data).
 *
 * Usage:
 *   <KV>
 *     <KVRow k="status"><Endorse status="active" /></KVRow>
 *     <KVRow k="issued">2026-01-15T09:00:00Z</KVRow>
 *     <KVRow k="expires">2026-09-01T00:00:00Z</KVRow>
 *   </KV>
 */
import type { ReactNode } from "react";
import "./components.css";

// ─── KV ───────────────────────────────────────────────────────────

interface KVProps {
  children: ReactNode;
  className?: string;
}

export function KV({ className, children }: KVProps) {
  return <div className={["pdpp-kv", className].filter(Boolean).join(" ")}>{children}</div>;
}

// ─── KVRow ────────────────────────────────────────────────────────

interface KVRowProps {
  children: ReactNode;
  className?: string;
  /** Key label (grotesk, muted). */
  k: string;
}

export function KVRow({ k, className, children }: KVRowProps) {
  return (
    <div className={["pdpp-kv__row", className].filter(Boolean).join(" ")}>
      <span className="pdpp-kv__k">{k}</span>
      <span className="pdpp-kv__v">{children}</span>
    </div>
  );
}
