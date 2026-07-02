## Context

Proven live and in code on `main`:

- `ChatGPT - dondochaka` has `source_binding.kind: "browser_collector"` and no
  `connector_instance_credentials` row. `ChatGPT - everyone@appears.blue` (healthy) has
  `default_account`. Both share one manifest — different state comes from connection-scoped
  binding/credential evidence, exactly as the archived spec requires.
- `chatgpt` is BOTH static-secret-capable (`STATIC_SECRET_CONNECTOR_REGISTRY`) AND browser-bound.
- The run-credential resolver `resolveStaticSecretRunEnv`
  (`server/stores/static-secret-run-credentials.js:82-106`) returns `null` (rather than throwing
  `credential_not_found`) whenever `sourceBinding.kind ∈ {browser_collector, browser_enrollment_shell}`
  and the credential is absent. So a missing credential does NOT fail closed for a
  `browser_collector` connection; the run proceeds.
- The connector then reaches `ensureChatGptSession` (`auto-login/chatgpt.ts:1042-1074`): if a
  reusable session exists it returns; else on an owner-present (interactive-allowed) run with no
  stored credential (`!(email && password)`) it drives `repairWithManualBrowserLogin` — the
  one-off browser login. The scheduled/unattended path already defers correctly
  (`interactiveAuthRepairAllowed === false` → throws the non-interactive message;
  run-executor marks needs-human).
- `connection-health.ts credentialsValidCondition` (1731-1768) derives `CredentialsValid` only
  from a transient run reason code (`firstReasonCode` → `isCredentialReason`), collapsing every
  credential-shaped reason into `CREDENTIAL_REJECTED` ("The source rejected the configured
  credentials") and going `unknown` once the reason ages out. `ComputeConnectionHealthInput`
  carries no credential-presence evidence. Result: no-usable-credential is rendered as "rejected"
  (a lie when nothing was stored), and the repair state oscillates with run recency.

## Decision

Keep the `browser_collector` session-reuse happy path (a valid reusable session needs no
credential — correct, and central to the browser-collector enrollment primitive). Change only the
**no reusable session AND no usable credential** case for **static-secret-capable** connections:

1. **Primary repair is durable credential capture, not a silent one-off browser login.** When an
   owner-present run for a static-secret-capable connection finds no reusable session and no usable
   stored credential, the runtime SHALL surface credential capture for the existing connection as the
   primary owner action (repair-required evidence), rather than silently opening a throwaway
   interactive browser login. The secure browser hand-off remains available as an explicit, labeled
   secondary "re-establish session" path — never the default triggered purely by credential absence.

2. **Honest, durable credential evidence.** Connection health SHALL distinguish `credential_required`
   (no usable stored credential for a connector that can store one) from `credential_rejected` (a
   stored credential the provider rejected), derived from durable credential-presence evidence passed
   into the health computation — not inferred solely from a transient run reason code. Both project as
   an owner reauth/capture action; the copy and reason differ honestly.

3. **No age-only healing.** A credential/session repair condition SHALL NOT project healthy/idle
   merely because a credential-shaped run reason code aged out. It stays derived from durable
   credential-presence + session-readiness evidence until readiness is proven (a successful run or a
   captured/active credential), consistent with the archived "closed by proof, not by age" rule.

## Why This Is SLVP-Aligned And Generic

Plaid update-mode, Nylas `invalid_grant`, Zapier/Airbyte all repair the existing connection over
observed credential/session state and separate connector auth *configuration* from each connection's
current state. The durable primary for a connection that can hold a credential is "provide/rotate the
credential," and session re-establishment is an explicit alternative — not a silent per-run login.
This change is connector-agnostic: it keys on "static-secret-capable + no reusable session + no usable
credential," a class multiple connectors (chatgpt today; any hybrid browser+static-secret connector
tomorrow) fall into. No ChatGPT-specific branch, manifest enum, or provider-page vocabulary is added.

## Scope Boundaries

- Does NOT change the invariant-tested routing PRIORITY (stored-credential repair before browser
  fallback); it makes the *no-credential* case route to capture instead of a silent login.
- Does NOT change the `browser_collector` session-reuse happy path or the browser-collector
  enrollment primitive (separate open change `add-browser-collector-enrollment-primitive`).
- Does NOT change PDPP Core. Console visual layout is owned by
  `redesign-owner-console-product-experience`; this change only requires the shared projection and
  copy to be honest and to route to capture.

## Alternatives Considered

- **Fail the resolver closed for all `browser_collector` bindings on missing credential.** Rejected:
  it would break the legitimate session-reuse happy path (a valid session needs no credential) and
  contradicts the browser-collector enrollment primitive. The correct discriminator is "no reusable
  session AND no usable credential," which is only knowable after the session probe — so the routing
  fix lives at the connector session-repair branch and the projection, not only the resolver.
- **Copy-only fix (rename the remediation label).** Rejected as insufficient: it leaves the one-off
  browser login as the actual repair and leaves health projecting "rejected" for a never-stored
  credential and oscillating with run recency.

## Acceptance Checks

- A static-secret-capable connection with a `browser_collector` binding, no reusable session, and no
  stored credential, on an owner-present run, surfaces credential capture as the primary repair; it
  does not silently open a one-off interactive browser login as the default. (The secure browser
  hand-off, if offered, is an explicit secondary session-repair action.)
- The same connection with a **valid reusable session** runs without prompting for a credential
  (happy path preserved).
- Connection health reports `credential_required` (not `credential_rejected`) for a connection with no
  usable stored credential, and `credential_rejected` only when a stored credential was actually
  rejected; both yield an owner reauth/capture action.
- After a credential-shaped run failure, the connection does NOT project healthy/idle once the run
  reason code ages out; the credential/session repair state persists until proof of readiness.
- A scheduled/unattended run for the same connection defers (records repair-required evidence) and
  does not open any interactive login. (Already implemented; guarded by a regression test.)
- Browser-session repair never silently stores a password typed into the provider page.
- A non-ChatGPT static-secret pattern (e.g. a static-secret connector with no browser binding, no
  credential row) still fails closed / routes to capture — proving the rule is not ChatGPT-specific.

## Residual Risks

- Owner-only live verification: capturing a credential for `dondochaka` and confirming a run clears the
  reauth verdict is an owner action on the live stack; recorded as residual risk, not blocking.
- The precise UI treatment of the secondary "re-establish session" action is a product-design layer on
  top of this contract, owned by the console redesign change.
