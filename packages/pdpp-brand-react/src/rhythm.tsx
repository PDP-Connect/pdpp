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
  const keyedTicks = ticks.reduce<{ key: string; tick: string }[]>((items, tick) => {
    const occurrence = items.filter(({ tick: previousTick }) => previousTick === tick).length;
    items.push({ key: `${tick}-${occurrence}`, tick });
    return items;
  }, []);
  return (
    <span aria-label={resolvedLabel} className="rr-rhythm" role="img">
      {keyedTicks.map(({ key, tick }) => (
        <span
          // Repeated tick values get occurrence-qualified keys for stable reconciliation.
          className={["rr-rhythm__tick", tick === "fail" ? "is-fail" : undefined].filter(Boolean).join(" ")}
          key={key}
        />
      ))}
    </span>
  );
}
