// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Band — the dataset summary strip.
 *
 * A horizontal stat strip that divides evenly into cells. Each cell
 * has a value (mono, tabular-nums, large) and a key (eyebrow, muted).
 *
 * Usage:
 *   <Band>
 *     <BandCell k="grants" v="14" />
 *     <BandCell k="streams" v="6" />
 *     <BandCell k="records" v="4,201" />
 *   </Band>
 */
import type { ReactNode } from "react";
import "./components.css";

// ─── Band ─────────────────────────────────────────────────────────

interface BandProps {
  children: ReactNode;
  className?: string;
}

export function Band({ className, children }: BandProps) {
  return <div className={["pdpp-band", className].filter(Boolean).join(" ")}>{children}</div>;
}

// ─── BandCell ─────────────────────────────────────────────────────

interface BandCellProps {
  className?: string;
  /** The label (uppercase mono eyebrow). */
  k: string;
  /** The value (large mono tabular-nums). */
  v: ReactNode;
}

export function BandCell({ k, v, className }: BandCellProps) {
  return (
    <div className={["pdpp-band__cell", className].filter(Boolean).join(" ")}>
      <span className="pdpp-band__v">{v}</span>
      <span className="pdpp-band__k">{k}</span>
    </div>
  );
}
