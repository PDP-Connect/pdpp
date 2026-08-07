# GNAP-Leg Gating Decision Memo

Status: awaiting owner call
Owner: reference implementation owner
Captured: 2026-08-07

## The decision this memo asks for

The GNAP-leg gating decision for the seam-spike, for the owner to accept or
reject. The seam-spike gate requires one of two things for the GNAP adapter
leg of the spike (gate requirement "The Core/binding decomposition and the
closed 0.2 common schemas SHALL remain gated on the repaired seam-spike
protocol", item 3):

> Either give the GNAP adapter leg binding pass/fail criteria...or explicitly
> and textually declare the GNAP leg non-gating for the decomposition-
> commitment decision. A mapping-completeness report alone SHALL NOT serve
> as the GNAP leg's pass criterion if the GNAP leg is declared gating.

The spec text does not yet make this call.

## The three criteria, if the GNAP leg is gating

The gate spells these out by name (same requirement, item 3):

1. Partial approval returns an unambiguous client-visible result.
2. `single_use` credential exchange behaves exactly-once.
3. The GNAP leg resolves a full `PDPPAuthorizationContext`-equivalent
   context, not a partial one.

## Option 1: GNAP leg gating, judged against the three criteria

**What this means:** the decomposition-commitment decision waits on someone
building a working GNAP adapter, running it against the same 13-vector
corpus (including vector 13, the `legacy_0_1` vector), and passing all three
criteria above under independent evaluation (gate item 2: a separate team or
an off-the-shelf product, not the adapter's own builder judging its own
adapter).

**Tradeoff:** this couples the Core/binding decomposition schedule to
building and proving a GNAP adapter that no implementer has asked for yet.
PDPP's normative core today is OAuth-shaped throughout (spec-core.md Section
5's selection request is an OAuth 2.0 authorization request carrying RFC
9396 `authorization_details`; Section 8's token introspection is RFC
7662-style). A GNAP leg is a second, structurally different binding built
specifically to stress-test whether the Core/binding seam holds under a
protocol that is not OAuth-shaped. Requiring it to pass three real criteria,
not just a mapping report, is the right bar if GNAP conformance is a real
deliverable; but if nobody is asking for GNAP, that bar becomes a blocking
dependency on speculative work.

## Option 2: GNAP leg declared non-gating for the decomposition-commitment decision

**What this means:** the decomposition-commitment decision proceeds on
however many legs the corpus actually exercises without a GNAP adapter (the
OAuth binding, and the `legacy_0_1` migration vector). The three criteria
above remain written down as the standard any future GNAP leg must clear;
they are just not a precondition for this decision.

**Tradeoff:** the seam gets validated on OAuth evidence alone. If GNAP
turns out to have a structural misfit with the Core abstraction (for
example, a GNAP concept that does not map onto
`PDPPAuthorizationContext`-equivalent resolution at all, not just
incompletely), that misfit surfaces after the decomposition is already
committed, not before. That is a real risk, not a hypothetical one: a
binding-independent Core is exactly the claim GNAP would test hardest,
because GNAP's request/continuation model differs from OAuth's
authorization-code exchange more than a second OAuth-shaped binding would.

## Recommendation (orchestrator's prior, for the owner to accept or reject)

Declare the GNAP leg non-gating initially. Keep the three criteria written
down as the standard any future GNAP leg must meet if one is ever built.
Revisit this decision if an implementer with actual GNAP intent appears.

Reasoning: nobody has demanded a GNAP adapter yet, and building one
specifically to prove a point about seam-independence risks becoming
speculative engineering effort that blocks a decision the OAuth evidence can
already inform. The risk this creates (deciding the seam on OAuth evidence
alone) is real but bounded: the decomposition-commitment decision is not
irreversible, and a future GNAP adapter can still be built and judged
against the same three criteria without having to redo the OAuth-leg
evidence.

## If Option 2 is chosen: the declaration to paste into the gate text

The gate spec's seam-spike protocol requirement (item 3) needs exactly one of
the two outcomes stated in the spec text itself. If the owner picks Option
2, this is the textual declaration the gate requires, ready to paste into
that requirement:

> The GNAP adapter leg of the seam-spike protocol is declared non-gating for
> the Core/binding decomposition-commitment decision. The three pass/fail
> criteria defined for a gating GNAP leg (partial approval returning an
> unambiguous client-visible result, `single_use` credential exchange
> behaving exactly-once, and full `PDPPAuthorizationContext`-equivalent
> resolution) remain the standard any future GNAP leg SHALL be judged against
> if one is built; they are not a precondition for this decomposition-
> commitment decision. A mapping-completeness report is not, and is not
> being treated as, the GNAP leg's pass criterion, because the GNAP leg is
> not part of this commitment decision at all.
