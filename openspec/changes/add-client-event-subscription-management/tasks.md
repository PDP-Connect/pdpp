## 1. OpenSpec

- [x] 1.1 Draft proposal/design/tasks/spec delta for `add-client-event-subscription-management`.
- [x] 1.2 Capture prior-art research in `design-notes/prior-art/client-event-subscription-management-prior-art-2026-05-27.md`.
- [x] 1.3 `openspec validate add-client-event-subscription-management --strict`.
- [x] 1.4 `openspec validate --all --strict`.

## 2. Store extensions

- [x] 2.1 Add `listAllSubscriptions` (with `clientId?`, `grantId?`, `status?` filters) to both SQLite and Postgres stores in `server/stores/client-event-subscription-store.ts`. Register matching SQL artifacts.
- [x] 2.2 Add `getSubscriptionSummary(subscriptionId)` that joins `client_event_queue` and `client_event_attempts` to surface pending count, last attempt timestamp/ok/status, and final-failure count without N+1.
- [x] 2.3 Add `listAttemptsForSubscription(subscriptionId, limit)` bounded by the operation layer's cap.

## 3. Operations

- [x] 3.1 `ref.client-event-subscriptions.list` — operation in `operations/ref-client-event-subscriptions-list/`. Accepts filter input, calls store helpers, returns `{object: 'list', data}` of operator-summary rows (no secrets).
- [x] 3.2 `ref.client-event-subscriptions.get` — operation in `operations/ref-client-event-subscriptions-get/`. Accepts subscription id, returns the detail projection including recent attempts capped at 25.
- [x] 3.3 `ref.client-event-subscriptions.disable` — operation in `operations/ref-client-event-subscriptions-disable/`. Accepts optional reason, transitions `active` / `pending_verification` → `disabled` with reason `operator_disabled` (or the operator-supplied reason), drops queued events. Idempotent for already-disabled / revoked / deleted.

## 4. Routes

- [x] 4.1 Mount `GET /_ref/event-subscriptions` in `server/index.js` under `ownerAuth.requireOwnerSession`, calling `executeRefClientEventSubscriptionsList`.
- [x] 4.2 Mount `GET /_ref/event-subscriptions/:id` calling `executeRefClientEventSubscriptionsGet`.
- [x] 4.3 Mount `POST /_ref/event-subscriptions/:id/disable` calling `executeRefClientEventSubscriptionsDisable`.

## 5. CLI

- [x] 5.1 Add `packages/cli/src/ref/commands/event-subscriptions.js` with `list`, `show`, and `disable` subcommands.
- [x] 5.2 Wire dispatch in `packages/cli/src/index.js` and add the help text.
- [x] 5.3 `disable` prompts for confirmation unless `--yes` is passed; `--reason <text>` forwards to the route body.

## 6. Dashboard

- [x] 6.1 Add `apps/web/src/app/dashboard/event-subscriptions/page.tsx` rendering a filterable list with a peek pane.
- [x] 6.2 Add `apps/web/src/app/dashboard/event-subscriptions/disable-action.ts` server action calling the `_ref` disable route.
- [x] 6.3 Add typed list/get helpers in `apps/web/src/app/dashboard/lib/ref-client.ts`.

## 7. Tests and validation

- [x] 7.1 Operation tests for `list`, `get`, `disable` (projection-safety, filtering, idempotency, queue-drop).
- [x] 7.2 Route + auth tests asserting owner-session gating and 401 on absent session.
- [x] 7.3 CLI tests with a stub HTTP server matching the route shape — both formats, confirmation prompt, --yes bypass.
- [x] 7.4 `pnpm --dir reference-implementation typecheck`.
- [x] 7.5 Targeted reference test pattern: `node --test reference-implementation/test/operations/ref-client-event-subscriptions-*.test.js`.
- [x] 7.6 `pnpm --dir packages/cli test`.

## 8. Coordination

- [x] 8.1 Note in the workstream report which spec lines moved, since both `route-ref-operations-tranche` and this branch edit `server/index.js`.
