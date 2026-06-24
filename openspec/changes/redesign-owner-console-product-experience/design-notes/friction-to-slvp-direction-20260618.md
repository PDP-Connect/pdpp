# Friction-To-SLVP Direction

Date: 2026-06-18
Status: Decision note

## Decision

the owner's documented friction is not only a defect list. It is the primary signal for what an SLVP-tier solution must make obvious.

Implementation packets SHALL treat repeated friction as evidence of a missing product contract, not as a request for local polish. A local fix is acceptable only when it follows from the higher-level product contract.

## Friction Signals And Design Implications

| Feedback signal | What it usually means | Design response |
|---|---|---|
| "I don't understand why this page exists" | The surface has no clear owner job | Define the page job, primary subject, and primary next action before changing components. |
| "Is this a source or connection?" | The noun model is leaking implementation structure | Use the owner noun map and demote internal IDs/connection language to advanced evidence. |
| "Why is this count different?" | Projection basis is missing or inconsistent | Define the count basis, source of truth, and drill-through before changing labels. |
| "It shouldn't be capped" | Performance optimization violated trust | Provide full-set navigation, pagination, or virtualization; preview labels are not enough. |
| "I like this run breakdown" | A secondary surface contains essential owner value | Preserve the value when demoting or merging the surface. Do not delete by simplification. |
| "I can't tell what to do next" | The action model is missing or competing | Present one owner-legible cause and one closing action, with progress and reconciliation. |
| "This feels vibe-coded" | Local components do not compose into a product | Stop route-local fixes; return to product model, prior art, and journey evidence. |
| "I won't review the rest, but assume similar issues" | Unaudited surfaces are not implicitly acceptable | Treat named but unreviewed surfaces as risk until atlas/pixel/data evidence exists. |
| "Could it render this if it knows?" | The owner wants guaranteed semantics used for comprehension | Use reliable manifest/schema semantics for richer rendering; avoid guessed magic. |
| "This is important for sharing with others" | Fresh-owner and external trust matter | Test the Docker/Railway-to-first-records-to-first-grant journey, not only the owner's logged-in state. |

## Hard-Problem Charter Gate

Before broad implementation begins on a hard surface, the owner must produce a short charter. Hard surfaces include:

- Sources / Syncs / Runs relationship
- Add Data and connector setup
- Explore / stream record workbench
- Recovery and local collector liveness
- Grants / reads / Connect AI Apps
- Evidence timelines / traces
- Fresh-owner onboarding

Each charter SHALL include:

1. Owner promise: which of the five product promises it advances.
2. Friction evidence: the exact feedback signals and what they imply.
3. Prior-art anchor: the SLVP-tier products or patterns used as the design bar.
4. Product contract: the essential nouns, facts, actions, and lifecycle states.
5. What to preserve: useful facts or workflows that must not be lost.
6. What to demote or delete: incidental complexity that should stop being primary.
7. What not to solve locally: rabbit holes and tempting small fixes that do not improve the promise.
8. Acceptance evidence: pixels, data-truth probes, keyboard/focus checks, and live journey proof.

No worker may start broad UI implementation on a hard surface without the charter.

## Rabbit-Hole Filter

A candidate task is allowed into an implementation packet only if it satisfies at least one condition:

- It directly improves one of the five product promises.
- It removes a trust blocker on a core journey.
- It establishes a reusable contract needed by multiple journeys.
- It is a tiny opportunistic fix inside a surface already being changed and has no product-design ambiguity.

If a task is real but does not pass this filter, it goes to a later backlog. It should not interrupt the active wave.

## Prior-Art Use

Prior art is not decoration or justification after the fact. For each hard surface:

- Choose the comparison set before designing the solution.
- Extract interaction principles, not visual mimicry.
- Name the affordances the solution must include because the prior art makes them expected.
- State where PDPP differs because it is personal-data/self-hosted/protocol software.
- Use the prior art as the acceptance oracle during review.

Examples:

- Explore is judged against Datadog Log Explorer, GitHub search, PostHog filters, DevTools, Airtable, Algolia, and Notion views.
- Add Data is judged against Stripe/Plaid onboarding, GitHub token setup, Tailscale device enrollment, and Railway/Vercel/Supabase deployment readiness.
- Access Review is judged against Google account access, GitHub app authorization, Plaid consent, Stripe restricted keys, and Apple Sign in with Apple management.

## Orchestration Change

Workers may gather evidence, research prior art, draft charters, build narrow implementations, capture pixels, or red-team a tranche. Workers do not own product judgment.

The RI owner must reject worker output when it:

- solves a symptom without naming the hard problem
- changes a route or component without journey evidence
- removes useful facts in the name of simplification
- replaces one piece of jargon with another
- passes tests without proving the owner journey
- makes a surface cleaner but less powerful or less trustworthy

## Confidence Model

This adjustment raises confidence only if it changes behavior:

- Before implementation: every hard surface has a charter.
- During implementation: workers follow the charter and cannot self-certify.
- Before deploy: the owner sees pixels, data truth, and journey proof.
- After deploy: the same journey is walked live.

Without those gates, the plan will regress to churn.
