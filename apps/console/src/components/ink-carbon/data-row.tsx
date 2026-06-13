/**
 * DataRow — dense row for the console grant/connection list.
 *
 * Columns (default, left-to-right):
 *   monogram | who (title + id) | detail | [endorsement] | meta
 *
 * Override the column template via the `cols` prop (CSS --cols).
 * The default is: 26px monmax(0,1.25fr) minmax(0,1.6fr) 112px 128px
 *
 * Revoked rows: pass `revoked` to apply the struck-not-erased style.
 * Title and detail gain line-through; monogram fades.
 */
import type { CSSProperties, ReactNode } from "react";
import "./components.css";

// ─── DataRow ──────────────────────────────────────────────────────

interface DataRowProps {
  children: ReactNode;
  className?: string;
  /** Override the grid column template. */
  cols?: string;
  revoked?: boolean;
}

export function DataRow({ revoked, cols, className, children }: DataRowProps) {
  const cls = ["pdpp-data-row", revoked ? "pdpp-data-row--revoked" : undefined, className].filter(Boolean).join(" ");
  return (
    <div className={cls} style={cols ? ({ "--cols": cols } as CSSProperties) : undefined}>
      {children}
    </div>
  );
}

// ─── DataRowWho ───────────────────────────────────────────────────

interface DataRowWhoProps {
  className?: string;
  /** The protocol identifier. Mono voice. */
  id?: string;
  /** The human display name. Grotesk voice. */
  title: string;
}

export function DataRowWho({ title, id, className }: DataRowWhoProps) {
  return (
    <span className={["pdpp-data-row__who", className].filter(Boolean).join(" ")}>
      <span className="pdpp-data-row__title">{title}</span>
      {id && <span className="pdpp-data-row__id">{id}</span>}
    </span>
  );
}

// ─── DataRowDetail ────────────────────────────────────────────────

interface DataRowDetailProps {
  children: ReactNode;
  className?: string;
}

export function DataRowDetail({ children, className }: DataRowDetailProps) {
  return <span className={["pdpp-data-row__detail", className].filter(Boolean).join(" ")}>{children}</span>;
}

// ─── DataRowMeta ──────────────────────────────────────────────────

interface DataRowMetaProps {
  children: ReactNode;
  className?: string;
}

export function DataRowMeta({ children, className }: DataRowMetaProps) {
  return <span className={["pdpp-data-row__meta", className].filter(Boolean).join(" ")}>{children}</span>;
}

// ─── Monogram ─────────────────────────────────────────────────────

interface MonogramProps {
  className?: string;
  /**
   * Client name — the first two characters (uppercased) are used.
   * Alternatively pass a 1-2 char string directly.
   */
  name: string;
}

const WHITESPACE_RE = /\s+/;

/** Derive a 2-letter monogram from a client name. */
function toMonogram(name: string): string {
  const words = name.trim().split(WHITESPACE_RE);
  if (words.length >= 2 && words[0] && words[1]) {
    return ((words[0][0] ?? "") + (words[1][0] ?? "")).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export function Monogram({ name, className }: MonogramProps) {
  return <span className={["pdpp-monogram", className].filter(Boolean).join(" ")}>{toMonogram(name)}</span>;
}
