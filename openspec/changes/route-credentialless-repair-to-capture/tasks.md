## 1. Spec And Design

- [x] 1.1 Diagnose the live + code gap: repair selection keyed on connector static-secret capability instead of the connection binding (dondochaka = browser_collector + SSO, no credential).
- [x] 1.2 Add/refine the OpenSpec change to the connection-binding-first model, citing the archived repair-routing contract.
- [x] 1.3 Validate with `openspec validate route-credentialless-repair-to-capture --strict`.

## 2. Health Projection: binding-scoped, honest credential evidence

- [x] 2.1 Add credential-presence evidence to `ComputeConnectionHealthInput` (present/rejected), and a distinct `credential_required` reason vs `credential_rejected`.
- [x] 2.2 Gate credential-presence evidence on the CONNECTION BINDING: only a static-secret-bound connection gets it. A browser-session-bound (`browser_collector`/`browser_enrollment_shell`) connection with no credential row does NOT project `credential_required`.
- [x] 2.3 A credential/session repair condition does not heal merely because a run reason aged out.
- [x] 2.4 A credential-store READ FAILURE is evidence-unavailable (not "no credential") — never fabricates `credential_required`.
- [x] 2.5 Dedup the double-verb remediation label to "Reconnect this account" (converges with PR #164).

## 3. Server + Console: binding-first repair routing

- [x] 3.1 `ref-control.ts`: derive binding-scoped credential evidence (`connectionIsStaticSecretBound`), read the credential store only for static-secret-bound connections, and expose `source_kind` + `source_binding_kind` on the connection summary.
- [x] 3.2 Console `records/[connector]/page.tsx`: route the repair destination binding-first — a browser-session-bound connection reconnects its session; only a non-session connection routes to static-secret capture. Suppress the static-secret update affordance for session-bound connections.
- [x] 3.3 Shared `isBrowserSessionBoundConnection` classifier (console) mirrors the server `BROWSER_SESSION_BINDING_KINDS`.
- [x] 3.4 Connector session-repair branch (`auto-login/chatgpt.ts`) is UNCHANGED behaviorally: a browser-session connection with no reusable session and no stored credential correctly performs the interactive browser login (its session repair); a static-secret-bound connection fails closed in `resolveStaticSecretRunEnv` before the run starts.
- [x] 3.5 Run-stream fallback: while a browser-session repair run has an active browser surface but has not yet emitted the assistance request, show a browser-preparing state and poll the timeline for browser-surface assistance instead of showing the generic "no browser action" fallback.

## 4. Verification

- [x] 4.1 Health/projection tests: static-secret-BOUND no-credential -> `credential_required`; rejected -> `credential_rejected`; both -> owner reauth/capture.
- [x] 4.2 Binding-first test: a browser_collector + no-credential connection does NOT project `credential_required`; a static-secret account connection DOES.
- [x] 4.3 Store-read-failure test: getMetadata failure does NOT project `credential_required` or a reauth CTA.
- [x] 4.4 Age-only-healing preserved; absent-evidence backcompat preserved.
- [x] 4.5 Console routing invariant: detail-page repair routing is binding-first (session before static-secret); `isBrowserSessionBoundConnection` unit test.
- [x] 4.6 Run focused reference/polyfill/console tests plus `openspec validate --strict`.
- [x] 4.7 Stream regression tests: active browser-surface events keep the page in browser-preparing state; the no-assistance poller detects current browser-surface assistance and reloads into the stream.

## Acceptance checks

- Reproducible: run the focused suites in Verification; all pass.
- Live (owner-only, residual risk): for `dondochaka` (browser_collector, SSO) the owner repair is browser/session repair, not credential capture; for a static-secret account connection with no credential, it is credential capture. Confirm on the deployed fix; do not print secrets.
