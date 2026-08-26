// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The ONE producer of a source row's owner-facing verdict: the dot/tone/label
 * the row renders AND the fused status line beneath it, derived together from
 * one set of lifecycle facts.
 *
 * Deriving them together is the load-bearing part. When the console computed
 * the two separately it was possible to pass a lifecycle fact to one and not
 * the other, and that actually happened: omitting `archived`/`setupFailed` from
 * the fused call let an archived source with a green stored verdict fuse to a
 * green "Healthy" line while its dot correctly read archived. The list row
 * renders the LINE, so the fabricated-green tone was the one the owner read.
 *
 * Both the console `/sources` page and the `sources-report` CLI call this. A
 * surface that wants only one half still gets the other half's facts, so the
 * two can no longer disagree about the same connection.
 */

import { type FusedSourceStatus, fuseSourceStatus } from "./fused-source-status.ts";
import {
  deriveRenderedSourceStatus,
  deriveSourceLifecycleFacts,
  deriveSourceVerdictStatus,
  type SourceLifecycleFacts,
  type SourceStatusFlag,
  type SourceStatusInput,
} from "./source-status.ts";

export interface SourceVerdictProjection {
  /** The lifecycle booleans both projections were derived from. */
  facts: SourceLifecycleFacts;
  /** The fused state/freshness/activity line the source row renders. */
  fusedStatus: FusedSourceStatus;
  /** The single-slot dot/tone/label (row dot, tooltip, passport line). */
  renderedStatus: SourceStatusFlag;
}

export function projectSourceVerdict(connector: SourceStatusInput): SourceVerdictProjection {
  const facts = deriveSourceLifecycleFacts(connector);
  const renderedStatus = deriveRenderedSourceStatus(
    connector.rendered_verdict,
    facts.revoked,
    facts.pending,
    facts.terminalSetupDisposition,
    facts.running,
    facts.paused,
    facts.archived,
    facts.setupFailed
  );

  const fusedStatus = fuseSourceStatus(renderedStatus, {
    hasEverSucceeded: connector.last_successful_run !== null && connector.last_successful_run !== undefined,
    syncing: facts.running,
    // Hand back the verdict the `running` collapse discards, so a source that
    // is syncing AND failing still says it is failing.
    //
    // Only for the `running` collapse. `archived`/`setupFailed`/`revoked`/
    // `paused`/`pending` are LIFECYCLE facts that outrank any verdict — a
    // revoked source is revoked no matter how its last verdict read — and
    // `deriveRenderedSourceStatus` already ranks them ahead of `running` for
    // exactly that reason. Passing the verdict for those states would let a
    // stale "Blocked" overwrite "Revoked". `archived`/`setupFailed` matter
    // most here: they sit at severity 0 in `SEVERITY_BY_KIND` alongside
    // `blocked`, and `stateSlot` prefers the fallback on a TIE, so a stale red
    // verdict would displace the terminal lifecycle label even though the
    // lifecycle override had correctly produced it.
    verdictFallback:
      facts.running && !facts.archived && !facts.setupFailed && !facts.revoked && !facts.paused && !facts.pending
        ? deriveSourceVerdictStatus(connector.rendered_verdict)
        : null,
  });

  return { facts, fusedStatus, renderedStatus };
}
