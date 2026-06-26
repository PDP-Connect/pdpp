## Context

The live Sources page exposed several honesty and action-routing defects at once:

- A source could show "Sync started" without a path to the run that actually started.
- An already-running response could lose the `run_` prefix, making the run id unusable as a link target.
- Switching selected sources could retain detail-local confirmation/toast state from the previous source.
- Owner-runnable attention actions could be absent from the list cue, so a degraded row did not name the required owner step.
- A source with a successful latest collection and known terminal coverage gaps could render as "Can't collect" with "connector code needs a fix," even though collection did run and retained data exists.

## Decision

Keep the repair at the projection and Sources presentation seam.

The rendered verdict remains the server-owned source of truth. Sources consumes the primary required action as typed data:

- `refresh_now` and `retry_gap` render as run buttons using the server action label.
- Other owner-runnable actions render as inert detail hints, not generic run buttons.
- Maintainer or wait actions remain status facts, not dead owner controls.

For terminal coverage, the verdict distinguishes total terminal collection failure from successful collection with known coverage gaps. When the snapshot is degraded, the disposition is terminal, and current evidence proves `CollectionSucceeded=true`, the pill softens to degraded and the maintainer-status label becomes coverage review copy. The coverage gap is still visible; the owner is not told the connector failed to collect.

The UI links run-start success and already-running outcomes to `/dashboard/runs/<run_id>` when the server returns a run id. The selected source keys the passport component so local confirmation and toast state cannot leak across source selection. The low-burn test shape for this tranche is pure view-model coverage plus source-level structural assertions for the hook-heavy client component; browser interaction coverage remains a stronger future harness, not a claim of this patch.

## Alternatives

### Add a full React render harness

Deferred. The existing console tests use pure view-model tests and source-level structural assertions for client components with hooks. That is the lower-burn fit for this fix and still pins the regressions.

### Make every owner action a button

Rejected. Reauth and other non-run actions do not start a connector run from the list. They belong on the source detail surface where the owner can complete the specific flow.

### Hide terminal coverage gaps after a successful run

Rejected. That would be a worse honesty failure. The fix changes the claim from total failure to degraded coverage review while preserving the gap.

## Acceptance Checks

- Credential-required verdicts render `reauth` without maintainer `code_fix`.
- Successful collection with terminal coverage gaps renders degraded coverage review, not `Can't collect` / generic code-fix copy.
- Sources list cues include owner-runnable attention actions.
- Run-start and already-running toasts link to the concrete run id.
- Switching selected sources resets passport-local state.
- Focused OpenSpec, console, and rendered-verdict tests pass.
