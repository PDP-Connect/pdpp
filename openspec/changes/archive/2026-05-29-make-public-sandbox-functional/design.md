## Status

Superseded by `add-mock-reference-demo-instance`.

This design intentionally built a scenario-first sandbox rather than a mock reference dashboard. That was the wrong
primary product target. The accepted direction is now:

- `/sandbox` is a concise launcher into mock-owner dashboard mode.
- `/sandbox/overview`, `/sandbox/records`, `/sandbox/search`, and adjacent primary pages reuse dashboard shell/chrome
  and feature components against deterministic mock AS/RS data.
- `/sandbox/api-examples` and `/sandbox/walkthrough` remain supporting educational surfaces.
- The public site header must not wrap mock-owner dashboard pages; otherwise the sandbox looks like a docs page
  nested around an operator dashboard.

Retain this file as historical context only. Future work should follow `add-mock-reference-demo-instance`.

Reconciled and archived with `--skip-specs` on 2026-05-28: the delta is not applied to canonical specs because its
unique scenarios are already canonical in the `reference-demo-instance` capability and it targets a since-renamed
`reference-surface-topology` requirement title. See `proposal.md` for the scenario-by-scenario mapping.

## Context

The current `/sandbox` route is intentionally honest but not useful: it says the sandbox is a future mock-backed educational surface. That satisfied the route-topology change, but it is not good enough for an internal demo or a public reviewer. A visitor should be able to click through a simulated PDPP story and understand why the protocol matters without reading the whole spec first.

The durable constraints remain unchanged:

- The sandbox is public and mock-backed.
- It must not ask for real platform credentials.
- It must not imply that Vana hosts a canonical live owner reference instance.
- It can reuse dashboard/reference visual primitives, but it needs distinct simulated chrome and copy.

## Goals / Non-Goals

**Goals:**

- Replace placeholder/future-work copy with a functional, end-user-facing sandbox.
- Demonstrate one coherent PDPP scenario end to end: app request, owner consent, grant, scoped records/search, revocation, and refusal evidence.
- Keep the interaction fully client-side or static so it works on Vercel with no reference server.
- Provide inspectable "API transcript" panels for each step, using representative PDPP-shaped JSON.
- Make reset semantics obvious and testable.
- Update the coverage matrix so sandbox-demonstrated claims point to the new flow.

**Non-Goals:**

- No real OAuth, owner auth, connector credentials, live AS/RS calls, or stored user data.
- No browser automation, Docker, or connector runtime integration.
- No new public protocol endpoint.
- No complete protocol conformance simulator. This tranche is a polished vertical slice, not every PDPP flow.
- No localStorage persistence unless it is intentionally resettable and clearly labeled as per-browser demo state.

## Decisions

### 1. Build a scenario-first sandbox, not a fake dashboard

The page should feel like a guided product demo for someone evaluating PDPP. It should answer: "What can an app ask for, what does the owner approve, what data is returned, and what happens after revocation?"

Alternative considered: reuse `/dashboard` components and show mock connector cards. That risks making the sandbox feel like an operator console with fake data. The sandbox should be closer to Stripe's interactive docs or a protocol playground: scenario, state, result, transcript.

### 2. Use deterministic seeded fixtures

Seeded data should live in repo-owned TS modules, not fetched from the live reference stack. Include a small set of mock connectors/streams/records that are credible but obviously fictional.

Alternative considered: mock API route handlers. That adds a server boundary without user benefit for this tranche. A static/client fixture is simpler, testable, Vercel-safe, and easier to inspect.

### 3. Use local client state only for the walkthrough

The visitor can approve/revoke/reset within the page. State may live in React state; if persistence is added, it must be resettable and named as local sandbox state.

Alternative considered: server-side sessions. That would create operational questions for a public site and blur artifact categories. Avoid it until the sandbox needs shareable sessions or multi-page state.

### 4. Show API-shaped evidence beside the UI

Each step should include an inspectable request/response panel: client request, authorization decision, query response, revocation, denied query after revocation. The JSON does not need to be byte-for-byte from a live reference run, but it must be plausible and labeled as simulated.

Alternative considered: prose-only educational cards. That is not a sandbox; it does not let technical reviewers see the shape of integration.

### 5. Keep the design polished but distinct from live operation

The sandbox should look like a public, inviting demo surface. It should avoid warning-heavy placeholder copy. It should still carry a persistent "Simulated / no credentials" label so a visitor cannot confuse it with `/dashboard`.

## Risks / Trade-offs

- **Risk: Simulated JSON drifts from real contracts** -> Keep examples small, link to `/docs` for normative detail, and add tests that pin expected labels/state transitions rather than pretending the sandbox is a conformance suite.
- **Risk: The sandbox overclaims implementation coverage** -> Update `/reference/coverage` only for flows actually demonstrated by this page; keep unimplemented concepts visible as gaps.
- **Risk: Client-side state gets mistaken for durable account data** -> Provide a visible reset button and copy that says the state is local, simulated, and disposable.
- **Risk: Worker overbuilds a full mock AS/RS** -> Limit this tranche to one polished vertical slice and inspectable examples.

## Acceptance Checks

- `/sandbox` loads without a running reference server.
- A visitor can complete the happy path and see the returned records/search results change after consent.
- A visitor can revoke and see an access-denied/refusal example.
- Reset returns the page to its initial state.
- The page no longer says the sandbox is merely planned or a placeholder.
- The page never requests real credentials.
- `pnpm --dir apps/web run types:check`, `pnpm --dir apps/web run check`, and `pnpm --dir apps/web run build` pass.
