# Tasks — add-operator-stream-reach-diagnostics

## 1. Pure classifier

- [ ] 1.1 Add `apps/console/src/app/dashboard/runs/[runId]/stream/stream-reach-diagnostics.ts`
  exporting `STREAM_REACH_REASONS`, `classifyStreamReachFailure({ probeStatus,
  probeCode, probeError })` → `{ reason, troubleMessage }`, and a
  `sanitizeStreamReachReason(value)` helper reused by the server route shape.
- [ ] 1.2 Add `stream-reach-diagnostics.test.ts` covering all six reasons,
  the 410-by-code split (`session_expired` vs `companion_unavailable`), the
  raw-fetch-failure fallback, and reason sanitization.

## 2. Stream viewer give-up wiring

- [ ] 2.1 In `stream-viewer.tsx` `handlePreAttachFailure`, on the
  `totalAttempts >= MAX_RECONNECT_ATTEMPTS` branch, run one `fetch(viewerUrl, {
  method: 'GET', cache: 'no-store' })`, read status + JSON `error.code`, abort the
  response body, and classify via `classifyStreamReachFailure`.
- [ ] 2.2 Set the reason-specific `troubleMessage` from the classifier; keep the
  generic message only for `unknown`.
- [ ] 2.3 Fire `reportStreamReachFailureAction` best-effort (never block or change
  the UI message on beacon failure); keep the existing `logDebug` line.

## 3. Server action + reference route

- [ ] 3.1 Add `reportStreamReachFailureAction` to the stream `actions.ts` (owner
  dashboard access gate, forwards reason + httpStatus).
- [ ] 3.2 Add `reportRunInteractionStreamReachFailure` to
  `apps/console/src/app/dashboard/lib/operator-runs.ts` (`fetchAs` POST).
- [ ] 3.3 Add route `POST /_ref/runs/:runId/run-interaction-stream/reach-failure`
  in `reference-implementation/server/streaming/routes.js`: owner-auth, validate
  run/interaction, clamp reason to the closed set, emit `run.stream_reach_failed`.

## 4. Spine event registration

- [ ] 4.1 Register `run.stream_reach_failed` wherever run stream events are
  enumerated (`reference-implementation/lib/spine.ts` and any event-type
  allowlist), keeping it a non-terminal diagnostic event.

## 5. Tests

- [ ] 5.1 Extend `reference-implementation/test/run-interaction-stream-routes.test.js`:
  valid beacon emits `run.stream_reach_failed` with sanitized reason + http status
  and no token/cookie/URL in data; out-of-set reason clamps to `unknown`;
  run/interaction mismatch rejected with no emit.
- [ ] 5.2 Add or extend a stream-viewer give-up test asserting the probe →
  reason-specific message mapping and best-effort beacon (beacon failure does not
  change the message).

## Acceptance checks

- [ ] `openspec validate add-operator-stream-reach-diagnostics --strict` — pass.
- [ ] `node --test apps/console/.../stream/stream-reach-diagnostics.test.ts` — pass
  (runs without `node_modules` on Node ≥ 23's type stripping).
- [ ] From the `main` worktree (`/home/user/code/pdpp`, has `node_modules`):
  `node --test reference-implementation/test/run-interaction-stream-routes.test.js
  reference-implementation/test/run-interaction-stream-store.test.js` — pass.
- [ ] From the `main` worktree: the stream-viewer give-up test — pass.
- [ ] Grep the beacon payload and event data for `token`, `cookie`, raw URL — none
  present.
