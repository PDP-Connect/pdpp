# Live Verification Closeout

Status: captured
Owner: Codex RI owner
Created: 2026-06-17
Updated: 2026-06-17
Related: `openspec/changes/redesign-connection-health-verdict-and-recovery`

## Question

Does the deployed owner surface still satisfy the connection-health redesign's
useful-and-honest contract against the live `pdpp.vivid.fish` instance?

## Evidence

Live owner-session reads on 2026-06-17 confirmed:

- ChatGPT (`cin_11deac1e728b244aaeb56765`) renders `Healthy`, channel `calm`,
  and `Fresh today`; no required actions.
- The owner dashboard, sources page, and runs page HTML did not contain `2532`,
  preserving the invariant that recovered/mechanistic gap counts stay out of the
  attention layer.
- Peregrine Claude Code (`cin_2de5ede05c8cc8d45935c414`) no longer renders as an
  owner-attention source after running the source-profile recovery command. Its
  dead-letter count is zero, the systemd timer is active, and the source renders
  `Checking` / `calm` with no owner action while the local outbox drains.
- Amazon live rows show stale manual-refresh evidence reaching the rendered
  verdict (`Stale — this connector refreshes when you run it.`), so the Risk 1
  refresh-evidence seam is not silently null.

## Named Residuals

### Live Amazon and Chase no longer match the original archetype states

The original closeout task named Amazon/Chase advisory examples from the
2026-06-15 evidence. The live system now has different evidence:

- Amazon rows are currently `Degraded` / `calm` with stale annotations and
  checking-style forward statements after controller restarts.
- Chase is currently `Degraded` / `calm` with `freshness:"unknown"` and a
  checking-style forward statement.

This does not invalidate the synthesizer contract; the archetypes remain covered
by fixtures and tests. It does mean the live instance is not presently exercising
the exact Amazon-stale-advisory and Chase-retry-advisory examples from the
original acceptance text.

### Self-heal loop remains test-proven, not live-proven

No live owner-actionable `reauth`, `refresh_now`, or similar satisfaction event
was available in this verification pass. The loop is covered by reference tests,
but this closeout did not create a live credential or refresh repair solely to
exercise it.

### Local collector recovery has a background-drain residual

The source-profile recovery command repaired the owner-actionable dead-letter
state and moved the source out of attention. It did not drain the entire local
outbox in one foreground command; 1,348 ready batches remained for the active
timer to drain. The follow-up design note
`local-collector-recovery-drain-residual-2026-06-17.md` captures the needed
foreground-repair versus background-drain design decision.

## Decision

Close the owner-only live verification task as performed, with the residuals
above explicit. Do not keep the change pseudo-active on a historical live fixture
that no longer exists. Any new behavior for local background draining or live
self-heal proof should be its own scoped tranche.
