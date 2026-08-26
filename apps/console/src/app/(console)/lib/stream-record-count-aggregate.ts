// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Aggregation of per-stream retained-record counts into a connection total.
 *
 * Split out of `rs-client.ts` (which is server-only by transitive import) so
 * this pure, display-critical rule can be tested directly.
 */

import type { RefCountState } from "./ref-client.ts";

/**
 * The per-stream count evidence this aggregation reads. Structurally a subset
 * of `StreamSummary` in `rs-client.ts`, declared here so the rule stays free of
 * that module's server-only dependencies.
 */
export interface StreamRecordCountEvidence {
  readonly count_state?: RefCountState;
  /**
   * Retained-record count, or `null` when the count is unavailable. The server
   * synthesizes exact zeros only when the retained-size projection is proven
   * fresh and clean, so a declared stream with no row is an unreliable count.
   */
  readonly record_count: number | null;
}

/**
 * Sum per-stream retained-record counts WITHOUT fabricating a count the
 * streams do not support.
 *
 * `record_count` is `null` exactly when the server could not measure a stream
 * ("rendered as unavailable, never fabricated as 0"). Coercing those nulls with
 * `?? 0` and summing produces a confident total over unmeasured streams — the
 * defect that told owners "Holding 0 records." about connections holding
 * hundreds of thousands of records.
 *
 * The returned `totalRecordsState` is what keeps the sum honest downstream:
 * `resolveRecordCountDisplay`/`formatTotalRecordsLabel` only render a bare
 * number when the state is authoritative, and `isTotalRecordsAuthoritative`
 * treats an OMITTED state as authoritative — so this always reports one rather
 * than leaving it undefined.
 */
export function aggregateStreamRecordCounts(streams: readonly StreamRecordCountEvidence[]): {
  totalRecords: number;
  totalRecordsState: RefCountState;
} {
  let total = 0;
  let measuredAny = false;
  let unmeasuredAny = false;
  let staleAny = false;
  for (const stream of streams) {
    // `count_state` is the explicit evidence when the reference supplies it; an
    // older reference omits it, leaving `record_count === null` as the
    // documented legacy "unavailable" signal.
    const state = stream.count_state;
    const unmeasured =
      state === undefined ? stream.record_count === null : state === "unobserved" || state === "unknown";
    if (unmeasured) {
      unmeasuredAny = true;
      continue;
    }
    if (state === "stale") {
      staleAny = true;
    }
    total += stream.record_count ?? 0;
    measuredAny = true;
  }
  if (unmeasuredAny) {
    // A partial sum is not a total. Report the number we do have, but never as
    // an authoritative count: some of this connection's data was never counted.
    return { totalRecords: total, totalRecordsState: measuredAny ? "stale" : "unobserved" };
  }
  if (staleAny) {
    return { totalRecords: total, totalRecordsState: "stale" };
  }
  if (!measuredAny) {
    // No streams at all: nothing has been observed, so claim nothing.
    return { totalRecords: 0, totalRecordsState: "unobserved" };
  }
  return { totalRecords: total, totalRecordsState: total > 0 ? "known" : "known_zero" };
}
