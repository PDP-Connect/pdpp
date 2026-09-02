// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Provider coverage-horizon/provenance types.
 *
 * A coverage horizon is a structured, reversible disclosure of the BOUNDARY
 * of what a source can EVER provide — e.g. "GroupMe does not retain group
 * messages before 2013" or "H-E-B's purchase history predates this account's
 * connection." This is a THIRD axis, orthogonal to both possession ("not yet
 * fetched") and connection health ("currently erroring"): see the
 * commissioned research (`upstream-retention-loss-health-ux-prior-art.md`)
 * and `openspec/specs/reference-connection-health/spec.md`.
 *
 * Rules, all load-bearing and enforced by callers of this module — NOT by
 * this module itself, which is a pure type/predicate surface with no I/O:
 *
 *   - A horizon requires POSITIVE evidence (`basis`) and fails closed to
 *     absent/unknown when evidence is weak. There is no "unconfirmed"
 *     horizon value — the absence of a `ConnectionCoverageHorizon` record IS
 *     the fail-closed-to-unknown state; see `ConnectorCoverageHorizonStore`
 *     (`server/stores/connector-coverage-horizon-store.ts`).
 *   - A horizon NEVER rewrites or deletes retained records. It is pure
 *     disclosure metadata about a boundary, never a mutation of the records
 *     on either side of that boundary.
 *   - A horizon participates in NO classification step. It never marks a
 *     connection unhealthy, never marks a stream's coverage complete, never
 *     narrows the coverage denominator, and never carries a
 *     `ConnectionHealthState`/`ConnectionConditionStatus` — it is read as
 *     informational disclosure by the owner-facing detail surface
 *     (`rendered-verdict.ts`'s `detail`), never the `pill`/`channel`
 *     tone-bearing surface (see `coverageHorizonDisclosure` below), and never
 *     by the coverage condition. This holds even when a connector's own skip
 *     evidence carries a matching `boundary_claim`: nothing in the protocol
 *     binds a specific GAP to a horizon's EDGE, so "the stream has a horizon"
 *     cannot prove any particular gap falls outside the interval the provider
 *     can still serve. See the disclosure-only rationale in
 *     `server/connector-gap-classification.ts` and the normative requirement
 *     in `openspec/changes/add-coverage-horizon-and-actionability-banner/
 *     specs/reference-connection-health/spec.md`.
 *   - A later provider contradiction SUPERSEDES the prior record
 *     (`supersededAt`/`supersededByHorizonId`), never silently overwrites
 *     it — provenance (who/when/why) survives every revision.
 *   - This module and every caller of it carry NO connector/provider-ID
 *     branching — a horizon is a generic per-connection-per-stream fact any
 *     connector's manifest/operator workflow can populate, enforced by
 *     `test/ri-zero-connector-knowledge-conformance.test.ts`.
 */

/**
 * How the horizon was established.
 *
 *   - `provider_stated`: the provider's own documentation/support content
 *     states the boundary (e.g. a help-center article naming a retention
 *     window).
 *   - `provider_confirmed`: the provider's system directly confirmed the
 *     boundary for THIS account (e.g. an API response, an export receipt).
 *   - `inferred_from_stable_boundary`: no direct provider statement exists,
 *     but repeated collection attempts against a stable, reproducible
 *     boundary support the inference. Weakest basis — never inferred from a
 *     single empty page or one failed attempt (see the plan's stop
 *     condition: "a provider limit was inferred from one empty page").
 */
export type CoverageHorizonBasis = "inferred_from_stable_boundary" | "provider_confirmed" | "provider_stated";

/** Why the boundary exists. Closed vocabulary so the UI never parses free text to decide how to render it. */
export type CoverageHorizonReason =
  | "consent_window"
  | "provider_deleted_history"
  | "provider_never_had_data"
  | "provider_retention_policy";

/**
 * A single coverage-horizon record. `horizonId` is durable and referenced by
 * `supersededByHorizonId` on the row it replaces, so a reader can walk the
 * full provenance chain even though only the current (non-superseded) row is
 * returned by ordinary reads.
 */
export interface ConnectionCoverageHorizon {
  readonly basis: CoverageHorizonBasis;
  readonly confirmedAt: string;
  /** Actor (owner subject id, or an operator identity) who recorded this confirmation. Never a connector/provider identity. */
  readonly confirmedBy: string;
  readonly connectorInstanceId: string;
  /** ISO date/timestamp, or `null` when the boundary is known to exist but its exact edge is not (e.g. "before this account existed"). */
  readonly earliestAvailable: string | null;
  readonly horizonId: string;
  /** Optional free-text context for the confirming actor; never rendered as the sole justification (basis/reason are the structured facts). */
  readonly note: string | null;
  readonly reason: CoverageHorizonReason;
  /** `"*"` for a connection-wide horizon; a manifest stream name for a stream-scoped one (e.g. GroupMe's `"group_messages"`). */
  readonly stream: string;
  readonly supersededAt: string | null;
  readonly supersededByHorizonId: string | null;
}

/**
 * Owner-facing, neutral-register disclosure text for a coverage horizon.
 * Deliberately FAQ/explainer register, never alarm — modeled on the
 * commissioned research's found copy patterns ("Why does this Item include
 * only three months of transaction history?", "nothing is broken — you're
 * looking at the smaller of two independent numbers"). This function is
 * PURE presentation over an already-recorded horizon; it does not decide
 * whether one exists.
 */
export function coverageHorizonDisclosure(horizon: ConnectionCoverageHorizon): string {
  const boundary = horizon.earliestAvailable
    ? `records before ${horizon.earliestAvailable}`
    : "some records from before this connection existed";
  const reasonText: Record<CoverageHorizonReason, string> = {
    consent_window: "the consent window in effect when this connection was authorized",
    provider_deleted_history: "the provider no longer retains that history",
    provider_never_had_data: "the provider never had that data",
    provider_retention_policy: "the provider's own retention policy",
  };
  return `PDPP cannot retrieve ${boundary}, because of ${reasonText[horizon.reason]}. This is not a problem with the connection — every record the provider can still serve remains retained here.`;
}
