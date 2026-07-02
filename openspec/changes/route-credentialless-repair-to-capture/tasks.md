## 1. Spec And Design

- [x] 1.1 Diagnose the live + code gap (browser_collector escape hatch; no-credential vs rejected conflation; age-only healing).
- [x] 1.2 Add OpenSpec proposal, design, tasks, and spec deltas citing the archived repair-routing contract.
- [x] 1.3 Validate with `openspec validate route-credentialless-repair-to-capture --strict`.

## 2. Health Projection: honest, durable credential/session evidence

- [x] 2.1 Add credential-presence evidence to `ComputeConnectionHealthInput` (present/absent/rejected + captured/rotated timestamps), sourced from the connector-instance credential store, and thread it through the health computation callers.
- [x] 2.2 In `credentialsValidCondition`, emit a distinct `credential_required` reason + honest message/remediation when there is no usable stored credential (for a connector that can store one), separate from `credential_rejected`. Keep both projecting an owner reauth/capture action.
- [x] 2.3 Ensure a credential/session repair condition does not project healthy/idle merely because a credential-shaped run reason code aged out; keep it derived from durable credential-presence + session-readiness evidence.
- [x] 2.4 Align the rendered-verdict copy and any duplicated remediation label so surfaces show one honest action for the credential-required vs credential-rejected cases (no "Reconnect or update" double-verb; no "rejected" when nothing was stored).

## 3. Runtime Routing: no-credential repair goes to capture, not a silent browser login

- [x] 3.1 In the browser-bound + static-secret connector session-repair branch (e.g. `auto-login/chatgpt.ts`), when interactive repair is allowed but there is no usable stored credential, record repair-required evidence naming credential capture as the primary owner action instead of silently driving a one-off browser login.
- [x] 3.2 Preserve the reusable-session happy path (valid session → run proceeds without prompting) and the scheduled-run deferral (no interactive login on the automatic path).
- [x] 3.3 Keep any browser-session hand-off available only as an explicit, separately-labeled secondary session-repair action.
- [x] 3.4 Do not change the invariant-tested routing PRIORITY (stored-credential repair before browser fallback).

## 4. Verification

- [x] 4.1 Health/projection tests: no-usable-credential → `credential_required` (not `credential_rejected`) with honest copy; stored-credential rejection → `credential_rejected`; both → owner reauth/capture action.
- [x] 4.2 Age-only-healing test: after a credential-shaped run reason ages out with no readiness proof, the connection still projects the unresolved credential/session condition (not healthy/idle).
- [x] 4.3 Runtime routing tests: owner-present run, static-secret-capable connection, no session + no credential → repair-required-for-capture evidence, no silent one-off browser login; reusable session → happy path; scheduled → defers.
- [x] 4.4 Non-ChatGPT pattern: a static-secret connector with no browser binding and no credential row fails closed / routes to capture (proves the rule is not ChatGPT-specific).
- [x] 4.5 Browser-session repair never silently stores a password typed into the provider page (regression preserved).
- [x] 4.6 Run focused reference/polyfill/console tests plus `openspec validate --strict`.

## Acceptance checks

- Reproducible: run the focused suites in Verification; all pass.
- Live (owner-only, residual risk): capture a credential for `dondochaka` and confirm a run clears the reauth verdict and the connection projects healthy; do not print secrets.
