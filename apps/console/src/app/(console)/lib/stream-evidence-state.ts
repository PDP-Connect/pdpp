// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Formats a stream's orthogonal `declaration_state`/`count_state` pair
 * (`reconcile-active-summary-evidence` design.md "Explicit stream evidence")
 * into the owner-facing count label the connector detail page renders.
 *
 * Honest-by-default: `known_zero` reads "0 records" (a proven exact count,
 * distinct from "count unavailable"); `unobserved`/`stale`/`unknown` never
 * render a number, since none of them are a canonical count. `unexpected`
 * declaration state is a distinct provenance fact (canonical/retained data
 * exists for a stream the current manifest no longer declares) surfaced as a
 * caveat alongside whatever count is available, not folded into the count
 * label itself.
 *
 * Pure and side-effect-free so it is testable without a browser harness,
 * mirroring the `connection-evidence.ts` idiom.
 */

import type { EvidenceTone } from "./connection-evidence.ts";
import type { RefConnectorStreamRecord } from "./ref-client.ts";

export interface StreamCountLabel {
  text: string;
  title: string;
  tone: EvidenceTone;
}

const COUNT_STATE_LABELS: Record<
  NonNullable<RefConnectorStreamRecord["count_state"]>,
  (count: number | null) => StreamCountLabel
> = {
  known: (count) => ({
    text: count === null ? "count unavailable" : `${count.toLocaleString()} records`,
    tone: "neutral",
    title: "The canonical stable-records snapshot for this stream is current.",
  }),
  known_zero: () => ({
    text: "0 records",
    tone: "neutral",
    title: "The canonical snapshot proves this stream has exactly zero retained records right now.",
  }),
  unobserved: () => ({
    text: "count not yet observed",
    tone: "neutral",
    title:
      "No observation has completed for this stream yet; a count will appear once the next read reconciles evidence.",
  }),
  stale: () => ({
    text: "count unavailable",
    tone: "warning",
    title: "The last known count is stale relative to the live canonical checkpoint.",
  }),
  unknown: () => ({
    text: "count unavailable",
    tone: "warning",
    title: "The count could not be determined; evidence collection failed or is otherwise unreliable.",
  }),
};

/**
 * Derives the stream count label from the orthogonal evidence pair when
 * present, falling back to the legacy `record_count === null` binary check
 * for a reference predating `count_state` — never inventing a state.
 */
export function streamCountLabel(record: {
  count_state?: RefConnectorStreamRecord["count_state"];
  record_count: number | null;
}): StreamCountLabel {
  if (record.count_state) {
    return COUNT_STATE_LABELS[record.count_state](record.record_count);
  }
  return {
    text: record.record_count === null ? "count unavailable" : `${record.record_count.toLocaleString()} records`,
    tone: "neutral",
    title: "",
  };
}

/**
 * `true` only when the stream's canonical/retained data is visible but the
 * current manifest no longer declares it (design.md "unexpected" declaration
 * state) — a distinct provenance caveat, never merged into the count label.
 */
export function isUnexpectedStreamDeclaration(
  declarationState: RefConnectorStreamRecord["declaration_state"] | undefined
): boolean {
  return declarationState === "unexpected";
}
