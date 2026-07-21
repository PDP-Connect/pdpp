// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Rhythm — a run-history sparkline.
 *
 * A row of small ticks, oldest → newest, one per recent run. A successful run
 * is a quiet green tick; a failed run is a louder amber tick. Used by the Syncs
 * view (per-stream run cadence) and anywhere a compact run history reads better
 * than a number.
 *
 * Spent color stays disciplined: the only colors here are `--success` (ok) and
 * `--warning` (fail), matching the Endorse vocabulary.
 */
import "./components.css";

export type RhythmTick = "ok" | "fail";

interface RhythmProps {
  /** Accessible label, e.g. "last 5 runs: 4 ok, 1 failed". */
  label?: string;
  /** Run outcomes, oldest first. */
  ticks: readonly RhythmTick[];
}

export function Rhythm({ ticks, label }: RhythmProps) {
  const failures = ticks.filter((t) => t === "fail").length;
  const resolvedLabel = label ?? `last ${ticks.length} runs: ${ticks.length - failures} ok, ${failures} failed`;
  return (
    <span aria-label={resolvedLabel} className="rr-rhythm" role="img">
      {ticks.map((tick, i) => (
        <span
          // ticks are positional and have no stable id; index is the identity.
          className={["rr-rhythm__tick", tick === "fail" ? "is-fail" : undefined].filter(Boolean).join(" ")}
          // biome-ignore lint/suspicious/noArrayIndexKey: positional sparkline ticks have no other identity.
          key={i}
        />
      ))}
    </span>
  );
}
