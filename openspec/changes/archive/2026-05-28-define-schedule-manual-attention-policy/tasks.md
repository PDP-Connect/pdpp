## 1. Policy Contract

- [x] 1.1 Review the existing prior-art design note and adjacent schedule/freshness changes.
- [x] 1.2 Create a focused OpenSpec change for the schedule/manual-attention policy.
- [x] 1.3 Specify schedule freshness intent, bounded run attempts, durable attention requests, notification state, and per-connection suppression.
- [x] 1.4 Run second-pass SLVP prior-art review and specify latest-only catch-up as the default after attention clears.

## 2. Future Implementation

- [x] 2.1 Add storage and projections for durable typed attention requests.
  - Storage: `server/stores/connector-attention-store.js` (`connector_attention_records` table, SQLite + Postgres). Projection: `server/ref-control.ts::getConnectorAttentionProjection`. Both pre-existed for the operator console; this tranche reuses them rather than minting a parallel store.
- [x] 2.2 Teach scheduled launches to skip or suppress when equivalent unresolved attention exists.
  - `runtime/scheduler.ts`: new `hasUnresolvedAttention` hook, durable attention check is now the highest-priority gate inside `executeRun`, emits one `attention_unresolved` skip per attention identity (deduped via `notifiedAttentionSkips`).
  - `server/index.js`: wires the hook to `getConnectorAttentionProjection` + `runtime/attention.ts::isHealthRelevant` so the durable typed projection drives the gate.
- [x] 2.3 Terminate owner-attention runs as bounded attempts while preserving resume evidence.
  - Existing runtime path: when an automatic run hits an `INTERACTION`/`ASSISTANCE` prompt, the wrapped `onInteraction` returns `cancelled`, the connector exits, and `attention-writer.js` persists the durable typed request. The new scheduler gate uses that durable evidence to suppress further automatic attempts.
- [x] 2.4 Add notification policy state and operator-visible safe instructions.
  - Pure model: `runtime/attention.ts::NotificationState` (`pending | sent | suppressed | failed | acknowledged`), `notification_state` / `notification_updated_at` / `notification_reason` added to `AttentionRecord`, `recordNotificationOutcome` pure transition helper, `isNotificationDeliveryFailed` predicate. Lifecycle transitions to `acknowledged`/`in_progress` promote `notification_state` to `acknowledged` automatically.
  - Durable store: `server/stores/connector-attention-store.js::recordNotificationOutcomeById` (SQLite + Postgres) updates the `record_json` column without touching `lifecycle` so a `failed` outcome leaves the prompt visible — the spec scenario "Notification failure does not cause a run storm" is now enforced at the store boundary.
  - Push fanout: `server/web-push-notifications.js::classifyPushFanoutOutcome` maps the existing `{ attempted, sent, suppressed, unavailable, failureReasons }` shape onto `NotificationState`; `fanoutPendingInteractionWebPush` and `fanoutAssistanceWebPush` accept an optional `recordOutcome` callback that is invoked even when the fanout short-circuits (VAPID disabled, no opted-in subscriptions, policy-suppressed). Callback failure is logged and swallowed so notification fanout is never blocked by recorder errors.
  - Runtime wiring: `runtime/controller.ts` and `server/index.js` thread `recordOutcome` callbacks that resolve the durable attention id from the runtime's default `att_<runId>_<requestId>` factory and call the store's new method. The scheduler-side `onInteraction` seam (cancelled-on-needs-human path) is wired identically so process-restart safety holds.
  - Operator surface: `next_action.notification_state` on `ConnectionHealthSnapshot` exposes the durable axis (`null` for schedule-fallback CTAs where the precise record is unknown), so the dashboard can render "we notified you / delivery failed / quiet hours" without rereading transport logs.
  - Tests: `test/attention.test.js` (notification-state defaults, recordNotificationOutcome paths, lifecycle promotion to acknowledged, transition preservation); `test/attention-writer.test.js` (writer-level notification recording, lifecycle preservation on failure, deterministic id lookup); `test/connector-attention-store.test.js` (store-level `recordNotificationOutcomeById` happy path, invalid outcome rejection, missing id null return, "failed delivery does not retire the row"); `test/web-push-notifications.test.js` (classifier coverage + callback fires on suppressed branch).
- [x] 2.5 Add tests proving no silent retry storm and no cross-connection suppression bleed.
  - `test/scheduler-attention-suppression.test.js` covers (a) one suppression per attention identity, (b) identity rotation re-arms the emitter, (c) suppression does not bleed across connections, (d) probe failure does NOT silently suppress launches.
- [x] 2.6 Add scheduler behavior proving missed ticks do not replay as an unbounded backlog after attention resolves.
  - `test/scheduler-attention-suppression.test.js::resolved attention does not replay missed ticks — latest-only catch-up` asserts the post-resolution tick count is bounded (no per-missed-tick replay).

## 3. Acceptance Checks

- [x] 3.1 Run `openspec validate define-schedule-manual-attention-policy --strict`.
- [x] 3.2 Confirm no package publishing, PWA, local collector runner, or behavioral runtime files were touched.
- [x] 3.3 Owner-review the policy against the prior-art note and confirm it remains a design-only tranche.
- [x] 3.4 Re-run `openspec validate define-schedule-manual-attention-policy --strict` after second-pass SLVP updates.
