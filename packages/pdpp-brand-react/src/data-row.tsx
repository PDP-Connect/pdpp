// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
  /**
   * Opt-in per-instance color, derived by the caller from a stable seed
   * (e.g. `deterministicHue`). Absent by default, which keeps the neutral
   * `--muted-foreground` look every existing caller already renders.
   */
  tinted?: boolean;
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

// A small fixed palette of readable, distinguishable hues (not a brand color
// for any specific connector — purely a deterministic hash target, so distinct
// names/connectors are visually distinguishable in a list before any icon is
// declared).
const MONOGRAM_HUES = [4, 24, 44, 84, 152, 172, 200, 224, 262, 292, 322] as const;

/** Deterministic (not random) hue derived from a stable string seed. */
function deterministicHue(seed: string): number {
  const hash = seed.split("").reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) % Number.MAX_SAFE_INTEGER, 0);
  return MONOGRAM_HUES[hash % MONOGRAM_HUES.length] as number;
}

export function Monogram({ name, className, tinted }: MonogramProps) {
  const cls = ["pdpp-monogram", tinted ? "pdpp-monogram--tinted" : undefined, className].filter(Boolean).join(" ");
  const style = tinted
    ? ({ "--pdpp-monogram-hue": deterministicHue(name.trim().toLowerCase() || "?") } as CSSProperties)
    : undefined;
  return <span aria-hidden="true" className={cls} data-initials={toMonogram(name)} style={style} />;
}
