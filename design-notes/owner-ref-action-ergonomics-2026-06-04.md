# Owner ref-action ergonomics: a secret-safe owner-authenticated caller

Status: decided/implemented
Owner: reference implementation owner
Created: 2026-06-04
Related: packages/cli/src/ref/commands/call.js, packages/cli/src/ref/auth.js,
  design-notes/full-context-refresh.md,
  reference-implementation/server/owner-auth.ts,
  reference-implementation/server/owner-csrf.ts,
  reference-implementation/server/routes/run-cancel.ts

## Question

RI owners repeatedly rediscover how to perform owner-only actions against a
reference deployment. Dataset reconcile, run cancel, and schedule pause/resume
each forced a worker to re-derive the auth model: which routes want an owner
**session cookie**, which want an owner **bearer**, and whether a POST needs a
CSRF token. The friction shows up as wrong-auth 401s, stale-path 404s, and
hand-rolled `curl` with `_csrf` scraping. We want a safe, non-secret-printing
helper so future owner lanes can call these routes without re-learning the trap.

## Findings (verified in code, not inferred)

Two owner surfaces, two auth modes — this is the whole gap:

- `/_ref/*` (operator/diagnostics control plane) → **owner session cookie**.
  Every mutating `/_ref/*` route is guarded by `requireOwnerSession` *alone*.
  Verified: `requireCsrf` is attached in exactly three route files
  (`as-authorize.ts`, `as-consent.ts`, `as-device-ui.ts` — the hosted HTML
  forms) and nowhere under `/_ref/*`. See e.g.
  `routes/run-cancel.ts:52`, `routes/ref-dataset.ts:414`,
  `routes/web-push.ts:117`.
- `/v1/owner/*` (owner control machine API) → **owner bearer**
  (`Authorization: Bearer <owner token>`).

The CSRF "requirement" is the load-bearing misconception. `owner-auth.ts`
exempts any POST whose `Content-Type` is exactly `application/json`
(`isJsonRequest`, lines 517-547): a JSON body cannot be forged into a
cross-origin browser POST without a CORS preflight, so CSRF is required only for
browser-submittable form encodings. **A JSON owner-cookie POST to `/_ref/*`
never needs a CSRF token.** The correct fix is therefore not "parse CSRF
better" — it is "always send JSON and never parse CSRF at all."

The 401-vs-404 trap (from the live route map, `project_owner_ref_api_route_map_v1`):
401 = wrong auth on a real route; 404 = wrong path even with a valid session.
Pointing cookie auth at `/v1/owner/*`, or bearer auth at `/_ref/*`, yields a
confusing status that reads like a missing route. The helper must refuse that
mix up front instead of emitting the ambiguous request.

## Decision

Add `pdpp ref call` — a generic owner-authenticated HTTP caller in the existing
`pdpp ref` namespace. It is reference-implementation CLI convenience that
consumes already-existing routes; it changes no server contract, so no OpenSpec
change is required (classified UI/operator tooling per the workstream playbook
work-categories table).

Behavior:

- `pdpp ref call <method> <path> [--as-url <url>] [--data <json> | --data-stdin]`
- Auth mode is chosen by path prefix and is overridable:
  - `/_ref/*` → cookie auth (cached session, `--owner-session`, or
    `PDPP_OWNER_SESSION_COOKIE`).
  - `/v1/owner/*` → bearer auth (`--owner-token-stdin` or `PDPP_OWNER_TOKEN`).
  - `--auth cookie|bearer` overrides the inference.
- Mismatch guard: cookie auth at `/v1/owner/*` or bearer auth at `/_ref/*` is
  rejected before any request, with the corrective hint. This is the encoded
  form of the 401-vs-404 rule.
- Bodies are always sent as `Content-Type: application/json` so the server's
  CSRF exemption always applies. No `_csrf` handling exists anywhere in the
  helper.
- Secrets never reach stdout/stderr: the cookie is read from the 0600 cache or
  env; the bearer is read from stdin/env, never argv; neither is echoed. Only
  the response body and a `METHOD path → status` line (on stderr) are printed.

Why source the bearer from `PDPP_OWNER_TOKEN`/stdin rather than the onboarded
`owner-agent` credential store: the owner bearer that authorizes `/v1/owner/*`
is the deployment owner token (`$PDPP_OWNER_TOKEN` in the live route map), a
distinct concept from a device-flow-onboarded owner-agent credential. Keeping
the source explicit avoids conflating the two and keeps the helper a thin,
auditable transport.

## Out of scope

- No new server routes, no contract change, no `_csrf` token issuance.
- No live mutating action performed in this lane (constraint of the lane).
- Does not replace `pdpp owner-agent` (device-flow onboarded automation) or the
  typed read commands (`ref run timeline`, `ref connectors`, etc.); those stay
  as the ergonomic path for their specific shapes. `ref call` is the
  escape hatch for the long tail of owner POST/GET routes.

## Acceptance

- An owner can reconcile dataset summary/size, cancel a run, or pause/resume a
  schedule via one command, without parsing CSRF or guessing the auth mode.
- The helper distinguishes `/_ref` cookie auth from `/v1/owner` bearer auth and
  refuses the mismatched pairing.
- Validation is offline: the auth-mode inference, mismatch guard, secret
  redaction, JSON content-type, and method/path plumbing are all unit-tested
  with an injected fetch double. The only optional live check is a harmless
  `GET /_ref/deployment` (read-only), never a mutation.
