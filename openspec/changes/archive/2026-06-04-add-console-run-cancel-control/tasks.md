# Tasks — Console Run Cancel Control

## 1. Client wrapper

- [x] 1.1 Add an exported `cancelRun(runId: string)` to `apps/console/src/app/dashboard/lib/operator-runs.ts`, modeled on `submitRunInteraction`: `fetchAs(`/_ref/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" })`, then read/parse the body and throw a descriptive error on non-2xx. Owner-session cookie is attached by `fetchAs`/`withOwnerSessionCookie` (matches the route's `requireOwnerSession`).
- [x] 1.2 Return a typed result distinguishing the three outcomes (`cancel_requested` / `no_active_run` / `run_already_terminal`) so the caller can render outcome-specific copy instead of a generic throw, while still surfacing `ReferenceServerUnreachableError`.

## 2. Server action

- [x] 2.1 Add a `"use server"` `cancelRunAction(runId)` to `apps/console/src/app/dashboard/runs/[runId]/actions.ts`, modeled on `submitRunInteractionAction`: call `cancelRun(runId)`, then `revalidatePath(`/dashboard/runs/${runId}`)`.
- [x] 2.2 Return a discriminated union (`{ ok: true, status } | { ok: false, kind, message }`) so `409 run_already_terminal` / `404 no_active_run` / unreachable surface as in-place messaging.

## 3. Client component + page wiring

- [x] 3.1 Add a `"use client"` `CancelRunControl` component under `apps/console/src/app/dashboard/runs/[runId]/` using `useTransition` + `useState`, following `interaction-form.tsx`. It SHALL require an explicit confirmation step before issuing the cancel.
- [x] 3.2 Copy SHALL state the action stops only the current run and preserves already-collected records, schedule, grants, and configuration (distinct from revoke / delete).
- [x] 3.3 Render the control in `apps/console/src/app/dashboard/runs/[runId]/page.tsx` inside `beforeTimeline`, gated on the existing `active` computation (render only when no terminal event); never render for terminal runs.
- [x] 3.4 On a successful 202, reflect "cancellation requested — the run will stop shortly"; on `409`/`404` reflect that the run already reached a terminal state and refresh.

## 4. Tests

- [x] 4.1 Unit test the `cancelRun` client wrapper: 202 → `cancel_requested`; 404 → `no_active_run`; 409 → `run_already_terminal`; non-JSON / unreachable → typed error. (Mirror existing `operator-runs` test patterns; mock `fetchAs`.) — Implemented as a runtime unit test of the pure `(status, body, code)` classifier (`cancel-run-result.test.ts`), which the wrapper delegates to, plus a source-regex guard that `cancelRun` POSTs the cancel route and routes the response through that classifier without catching `ReferenceServerUnreachableError`. The wrapper itself can't be imported under `node --test` because `operator-runs.ts` transitively imports `owner-token.ts` → `import "server-only"`; this mirrors why the existing `operator-runs.test.ts` is source-regex rather than a runtime import.
- [x] 4.2 Component/integration test (jsdom, matching the console's existing test harness): the control renders only when `active`; clicking requires confirmation; confirming calls `cancelRunAction`; the three outcomes render their distinct copy. — The repo has no jsdom / testing-library harness; following the established `rename-connection.test.ts` convention for hook-bearing client components, this is a source-regex structural test (`cancel-run-control.test.ts`) asserting the page gates rendering on `active` inside `beforeTimeline`, the control requires an explicit confirm step (no cancel-on-first-click), confirming calls `cancelRunAction`, the non-destructive copy is present, and the three outcomes render their distinct copy.

## 5. Live verification (Playwright, worktree dev console)

- [x] 5.1 Deferred to a `Residual Risks` entry in `proposal.md` (owner-only live action). The owner-visible end-to-end check remains a commitment: start a real run (or use an active one), open its run detail page, confirm the Cancel control appears only while active, click → confirm → observe the run terminal as `run.cancelled` on the timeline, and the control disappear (screenshot before/after). Per `AGENTS.md`, this owner-only live verification is recorded as a residual risk rather than holding the change active; the contract is otherwise proven by the unit tests (5.x in section 4 / 6.2) and the shipped owner-session route `POST /_ref/runs/{run_id}/cancel`.

## 6. Validation

- [x] 6.1 `openspec validate add-console-run-cancel-control --strict`. — passes ("Change 'add-console-run-cancel-control' is valid").
- [x] 6.2 Targeted console test run (the new wrapper + component tests) green. — `node --import tsx --test` on `cancel-run-result.test.ts` (8 tests) + `cancel-run-control.test.ts` (10 tests) + existing `operator-runs.test.ts` (2 tests): all pass. `pnpm run types:check` (next typegen + tsc --noEmit) clean; `ultracite check` clean on all 7 touched files.
- [x] 6.3 `git diff --check`. — no whitespace errors.

## Acceptance checks

- The run detail page shows a **Cancel run** control only for active runs (4.2, 5.1).
- The control confirms before cancelling and states it stops only the current run (3.1, 3.2).
- Cancel issues `POST /_ref/runs/{run_id}/cancel` with the owner session and reflects the 202/404/409 outcomes honestly (1.1, 2.2, 4.1).
- Live: a cancelled run terminals as `run.cancelled` and the control disappears (5.1).
- No backend / route / catalog change (proposal scope).
