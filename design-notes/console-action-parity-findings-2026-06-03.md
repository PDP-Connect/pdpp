# Console ↔ Owner-Agent Action Parity Findings

Status: findings
Owner: design/ui-elevation-and-action-parity lane
Created: 2026-06-03
Related: add-console-run-cancel-control, add-owner-run-cancellation-control, reference-owner-agent-control-surface, reference-implementation-architecture (agent-native parity)

## Question

The PDPP principle is agent-native parity: any action a user can take in the console, an agent can take over the control surface, and vice-versa. Where does the live console diverge from the owner-agent control catalog (`reference-implementation/server/metadata.ts`, `OWNER_AGENT_CONTROL_ACTION_CATALOG`)?

## Method

Cross-referenced every catalog `family` against (a) the human console client (`apps/console/src/app/dashboard/lib/operator-runs.ts` and the server actions that call it) and (b) the reference `/_ref/*` routes + owner-agent bearer routes. Citations verified in the worktree at `/home/user/code/pdpp-design-pass`.

## Findings

### Symmetric (no gap)

`run_connection` (run-now), `rename_connection`, `manage_schedule` pause/resume/delete, `inspect_diagnostics`, `manage_event_subscriptions`, `list_*` / `discover_control_capabilities`, and run-interaction (answer pending interaction) are present on both the console and the agent/reference surface.

### Gap G1 — `cancel_run`: agent + reference plane have it, console did not (CLOSING in this lane)

- Backend route `POST /_ref/runs/:runId/cancel` (`reference-implementation/server/routes/run-cancel.ts`) and catalog entry `cancel_run` (`metadata.ts:569`) exist.
- No console control called it; `operator-runs.ts` had no cancel wrapper.
- **Disposition: CLOSE.** Non-destructive, run-scoped, and explicitly anticipated by the cancellation design note ("Surface this in the dashboard with copy that says it stops the current run only"). Shipped as the console change `add-console-run-cancel-control` (run-detail control, active-only, confirm + run-scoped copy).

### Gap G2 — schedule create/replace: console has it, agent does not (BY DESIGN)

- Console `upsertScheduleAction` / `saveConnectionSchedule` writes a schedule; the `manage_schedule` catalog entry (`metadata.ts:586`) deliberately scopes the agent to pause/resume/delete and states "Schedule create/replace remains owner-session only."
- **Disposition: NO ACTION.** Documented, intentional asymmetry. Flagged here for owner awareness; closing it would be an agent-surface expansion, not a console change.

### Gap G3 — `revoke_connection`: agent has it, console does not (DEFERRED, owner decision)

- Catalog `revoke_connection` (`metadata.ts:652`, `supported`) + bearer route `owner-connection-revoke.ts`. Stops future collection while preserving past records. No console control.

### Gap G4 — `delete_connection`: agent has it, console does not (DEFERRED, owner decision)

- Catalog `delete_connection` (`metadata.ts:640`, `supported`) + bearer route `owner-connection-delete.ts`. **Destructive** — erases collected data. No console control.
- The `reference-owner-agent-control-surface` spec models delete as authorized "by an owner-agent bearer over the REST control plane only," with `connector_id`-ambiguity guards, and distinct from revoke.

#### Why G3/G4 are deferred rather than auto-closed

These are the inverse of G1 (agent-only, not console-only) and, unlike G1, **at least one is irreversible and erases personal data**. Adding one-click revoke/delete to the dashboard is a real product and safety decision, not a mechanical parity fill:

1. **Irreversibility.** `delete_connection` erases collected records. A console control needs a deliberate confirmation ceremony (typed-name confirm, explicit "this erases N records" accounting), not a button.
2. **Ambiguity.** The agent path has typed `connector_id`-vs-`connection_id` ambiguity handling; the console equivalent must resolve a concrete `connection_id` and show exactly what will be revoked/deleted.
3. **Spec posture.** The owner-agent-control-surface spec currently frames these as bearer/REST-control actions; mirroring them to the human console is a new normative requirement, not an existing one.
4. **Autonomy boundary.** Wiring an outward-facing, irreversible, data-erasing control into the dashboard without explicit owner sign-off is exactly the class of change an agent should surface, not ship unilaterally.

**Recommendation:** Close G3 and G4 in a dedicated change (`add-console-connection-revoke-and-delete-controls`) with a proper confirmation ceremony, after owner decision. Revoke (non-destructive of past data) can lead; delete should ship behind a record-count-aware, typed-confirmation flow. The agent-native-parity principle argues these SHOULD exist in the console — the open question is the ceremony, not the direction.

## Decision Log

- 2026-06-03: Audited full catalog ↔ console parity. Closed G1 (cancel) as non-destructive and intended. Recorded G2 as by-design. Deferred G3/G4 (revoke/delete) to a dedicated, ceremony-bearing change pending owner decision, because they are destructive/irreversible and adding them autonomously to the dashboard exceeds the safe autonomy boundary.
