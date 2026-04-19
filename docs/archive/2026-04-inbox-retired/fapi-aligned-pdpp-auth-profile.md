I want a future-work memo and research pass for a **FAPI-aligned PDPP auth profile**.

This is **not** a current implementation priority and **not** a spec-edit task yet. The goal is to tee up the right thoughtwork so that when we are ready, we can move quickly and cleanly.

## Goal

Figure out what it would mean for PDPP’s **auth surface** to become FAPI-aligned, without dragging collection/orchestrator concerns into the exercise.

The focus is the **AS / client / RS layer**:

* authorization requests
* consent / grant initiation
* token issuance
* token presentation
* token verification
* client authentication
* sender-constrained access
* grant lifecycle implications

The focus is **not**:

* Collection Profile
* browser automation
* imports
* scheduler/orchestrator
* landing-page copy
* general protocol redesign

## Framing assumptions

Work from the current PDPP split:

* Core handles consent / grants / disclosure
* Collection Profile is a separate bounded-run companion
* richer runtime/orchestrator behavior is reference architecture, not the auth-profile problem

Assume that a future FAPI-aligned profile would be:

* a **hardening / ecosystem-readiness layer** for PDPP’s OAuth-facing auth surface
* not a rewrite of PDPP’s collection model
* not something we are adopting immediately

## Questions to answer

1. What are the concrete deltas between current PDPP auth assumptions and a FAPI-aligned posture?
2. Which parts of PDPP would be most affected?

   * client type assumptions
   * bearer vs sender-constrained tokens
   * PAR
   * PKCE
   * authorization response handling
   * RS token verification expectations
   * introspection / proof handling
3. How would FAPI alignment interact with:

   * RFC 9396 / RAR usage in PDPP
   * current grant semantics
   * current consent UX / AS flow
   * owner-token vs client-token distinctions
4. What should remain unchanged because it belongs to collection/runtime, not auth?
5. What would a **minimal PDPP auth profile** look like if we wanted to become FAPI-aligned later without overfitting too early?
6. What are the biggest architectural tensions or likely migration costs?
7. What decisions are true spec-surface questions versus reference-implementation questions?

## Deliverables

Please produce:

1. `docs/research/fapi-aligned-auth-profile-deep-dive.md`
2. `docs/archive/2026-04-inbox-retired/fapi-aligned-auth-profile-memo.md`

## Requirements for the deep dive

Include:

* executive summary
* current PDPP auth surface as it exists now
* FAPI-aligned target shape
* concrete gap analysis
* what would need to change in spec semantics
* what would need to change only in implementation/reference
* what should explicitly stay out of scope
* migration / sequencing recommendations
* final recommendation: if and when PDPP should pursue this

## Requirements for the shorter memo

Keep it crisp:

* bottom line
* biggest deltas
* biggest risks
* clearest next-step thoughtwork when/if we prioritize this

## Working style

* Do real research, not vibes.
* Use primary sources where possible.
* Do not edit specs or code in this pass.
* Do not assume we should adopt FAPI wholesale; evaluate fit honestly.
* Keep the distinction between **auth profile** and **collection/runtime** very sharp.
* Be explicit about uncertainty and about where PDPP’s current architecture may already be pulling in a different direction.

Please report back with the main recommendation and the top 3 design tensions you found.
