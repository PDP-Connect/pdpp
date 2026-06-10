# Design — add-operator-stream-reach-diagnostics

## Problem

The client retry state machine in
`apps/console/src/app/dashboard/runs/[runId]/stream/stream-viewer.tsx` opens the
SSE channel with `new EventSource(viewerUrl, { withCredentials: false })`. The
server returns the pre-attach failure status *before* `res.hijack()`:

- `401 invalid_token`, `409 session_consumed`, `410 session_expired` from
  `streamingSessions.attach()` (`reference-implementation/server/streaming/routes.js:724-727`);
- `410 companion_unavailable` when `getCompanion()` is null (`routes.js:729-731`).

`EventSource` exposes none of this to the client — the spec gives the page a
single `error` event with no status, no body, no code. After
`MAX_RECONNECT_ATTEMPTS` pre-attach failures across re-mints the client gives up
with the generic message (`stream-viewer.tsx:2254-2266`). A `companion_start_failed`
*mid-stream* error is already surfaced distinctly, so the give-up specifically
covers the pre-attach and raw-unreachable classes.

There is exactly one durable failure mode that the give-up cannot name today,
and naming it is the whole point of this change.

## Approach

Read the status the browser hid, by doing one ordinary HTTP request the browser
does expose.

1. **Status probe.** On give-up, issue one `fetch(viewerUrl, { method: 'GET',
   cache: 'no-store' })`. Because the non-2xx attach checks return a normal JSON
   error response *before* the SSE hijack, a plain `fetch` reads the real HTTP
   status and the `error.code` body that `EventSource` discards. The probe reads
   the response head, then aborts so it never holds an SSE stream open.

2. **Pure classifier.** `classifyStreamReachFailure({ probeStatus, probeCode,
   probeError })` maps the probe result to one typed reason in a closed set and
   the matching operator message. It lives in a standalone module with its own
   test, mirroring the existing replayable stream modules
   (`playground-event-dedupe`, `stream-viewport-classifier`). This satisfies the
   existing "Stream viewer control policy is replayable" requirement and keeps
   the React component responsible only for DOM/side effects.

3. **Typed beacon.** The client fires one best-effort
   `reportStreamReachFailureAction({ runId, interactionId, reason, httpStatus })`.
   The owner-authenticated reference route validates the run/interaction, clamps
   `reason` to the closed set (anything else → `unknown`), and emits
   `run.stream_reach_failed` via the spine. Beacon failure never changes the UI
   give-up — the operator message is already set from the local classification.

## Why the probe is safe

The token is reconnect-safe, not consumed-on-first-GET.
`reference-implementation/test/run-interaction-stream-store.test.js` proves
`attach()` "marks `attached_at` on first attach and is idempotent on re-attach".
Therefore:

- If the token is genuinely dead (the give-up case in practice — it already
  failed `MAX_RECONNECT_ATTEMPTS` times), the probe returns the same non-2xx the
  `EventSource` got. No session is created or mutated.
- If the token were somehow still valid, the probe would briefly open a real SSE
  stream (and `companion.start()` could fire). The client aborts immediately
  after reading the status head, and the existing per-connection close handler
  (`routes.js:807-821`) tears down only that probe connection without
  invalidating the session. This is the same teardown the viewer's own socket
  drop already exercises on every reconnect.

The probe is therefore strictly a read of an already-failing path. It does not
widen authority: it uses the token the client already holds, against the route
the client already targets.

### Cross-origin degrades honestly

The streaming routes set no CORS headers; the standard deployment serves the
console and the reference behind the same public origin, which is why the
existing `EventSource` works at all. If a deployment is genuinely cross-origin,
the `EventSource` would already be failing — and the probe `fetch` would be
blocked by CORS and throw, which the classifier maps to `unreachable_origin`.
That is the correct, honest classification for an origin/proxy misconfiguration,
not a bug to special-case. The status server emits `run.stream_reach_failed`
with `reason: unreachable_origin` and no HTTP status, which is exactly what
happened.

### Diagnostic status is not a run failure

The beacon emits `run.stream_reach_failed` with `status: 'stream_reach_failed'`,
a descriptive sub-resource status — never `failed`/`rejected`. A connector run
can succeed even when the operator's stream viewer gave up reaching the surface,
and `summarizeEvents` flags any `failed`/`rejected` event as a terminal run
failure. Using a non-failure status keeps the give-up out of run-summary status,
mirroring `run.browser_surface_probe_failed` (`status: 'surface_failed'`).

## Closed reason set

| reason | probe result | operator message |
|---|---|---|
| `invalid_token` | HTTP 401 | "The browser stream link is no longer valid. Start the browser step again." |
| `session_consumed` | HTTP 409 | "The browser stream was already opened elsewhere. Start the browser step again." |
| `session_expired` | HTTP 410 + code `session_expired` | "The browser stream link expired. Start the browser step again." |
| `companion_unavailable` | HTTP 410 + code `companion_unavailable` | "The browser session is no longer running on the server. Start the browser step again." |
| `unreachable_origin` | fetch threw (DNS/TLS/connection) or non-classifiable | "Couldn't reach the browser stream. Check that the reference server is reachable, then try again." |
| `unknown` | a probe status outside the set above (e.g. 5xx, proxy error) | "Couldn't reach the browser stream after several tries." |

`unknown` preserves the current message verbatim so no occurrence regresses to a
worse string than today. Every other reason strictly improves on it.

## Honesty constraints

- The diagnostic explains the *failure class*; it does not retry, recover, or
  claim the stream succeeded. The give-up is still a give-up.
- The beacon and the operator copy never include the token, the proxy cookie, or
  the raw viewer URL. The beacon carries only `reason` (closed set), `http_status`
  (a small integer or null), and the existing `run_id` / `interaction_id`.
- The route clamps `reason` server-side so a malformed or hostile client cannot
  write an arbitrary string into the spine.

## Out of scope

- No change to n.eko allocation, leases, or browser runtime behavior.
- No change to the attach / backoff / re-mint state machine, thresholds, or TTL.
- No streaming rewrite, no new transport, no server-push of the failure reason
  (the server cannot push it — the channel is already gone at give-up; the client
  is the only party that holds the token to probe).
- No connector-side surface-loss handling — that is the adjacent
  `detect-midwait-browser-surface-loss` / browser-session-watchdog work.

## Acceptance checks

1. `openspec validate add-operator-stream-reach-diagnostics --strict` passes.
2. `classifyStreamReachFailure` unit test covers all six reasons, including the
   401/409/410-by-code split and the raw-fetch-failure fallback. Runs under
   `node --test` without `node_modules`.
3. The give-up path sets the reason-specific operator message and fires the
   beacon exactly once; a beacon-call failure does not change the message
   (covered by the stream-viewer give-up test).
4. The reference route emits `run.stream_reach_failed` with a sanitized reason on
   a valid beacon, rejects an unknown run/interaction, and clamps an
   out-of-set reason to `unknown` (route test).
5. No token, cookie, or raw URL appears in the beacon payload or the spine event
   data (asserted in the route test).
