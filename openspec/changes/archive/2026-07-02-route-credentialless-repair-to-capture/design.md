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

Keep the `browser_collector` session-reuse happy path (a valid reusable session needs no stored
credential). Route repair by the connection's binding, not by the connector's global capabilities:

1. **Browser-session-bound connections repair by browser session.** When an owner-present run for a
   browser-session-bound connection finds no reusable session and no stored credential, the runtime
   SHALL use the owner-operated secure browser to re-establish that session. It SHALL NOT route the
   connection to static-secret credential capture merely because the connector can support static
   credentials for other connections.

2. **Static-secret-bound connections repair by credential capture.** When a static-secret-bound
   connection has no usable stored credential, the run SHALL fail closed before starting the connector
   and the owner action SHALL be credential capture/rotation for that same connection.

3. **Credential evidence is scoped to static-secret bindings.** Connection health SHALL distinguish
   `credential_required` (no usable stored credential for a static-secret-bound connection) from
   `credential_rejected` (a stored credential the provider rejected), derived from durable
   credential-presence evidence passed into the health computation. A browser-session-bound
   connection with no credential row SHALL NOT project `credential_required`.

4. **Browser-session repair has an explicit pre-assistance state.** A launched browser-session repair
   can have `run.started` and a ready browser surface before it emits `run.assistance_requested`.
   During that interval owner-facing stream surfaces SHALL show that the secure browser is being
   prepared and continue checking for browser-surface assistance, not a generic "no browser action"
   fallback.

5. **No age-only healing.** A credential/session repair condition SHALL NOT project healthy/idle
   merely because a credential-shaped run reason code aged out. It stays derived from durable
   credential-presence + session-readiness evidence until readiness is proven (a successful run or an
   active credential/session), consistent with the archived "closed by proof, not by age" rule.

## Why This Is SLVP-Aligned And Generic

Plaid update-mode, Nylas `invalid_grant`, Zapier/Airbyte all repair the existing connection over
observed credential/session state and separate connector auth *configuration* from each connection's
current state. The durable primary for a connection that can hold a credential is "provide/rotate the
credential," and session re-establishment is an explicit alternative — not a silent per-run login.
This change is connector-agnostic: it keys on the connection's binding
(`browser_collector`/`browser_enrollment_shell` vs. static-secret), not on ChatGPT, Google SSO, or
provider-page vocabulary. Hybrid connectors can support both mechanisms without forcing every
connection into the same repair path.

## Scope Boundaries

- Does NOT add provider-specific auth semantics or a ChatGPT-specific branch.
- Does NOT change the `browser_collector` session-reuse happy path or the browser-collector
  enrollment primitive (separate open change `add-browser-collector-enrollment-primitive`).
- Does NOT change PDPP Core. Console visual layout is owned by
  `redesign-owner-console-product-experience`; this change only requires the shared projection and
  copy to route browser-session repair to a usable browser-session handoff.

## Alternatives Considered

- **Fail the resolver closed for all `browser_collector` bindings on missing credential.** Rejected:
  it would break the legitimate session-reuse happy path and the browser-collector enrollment
  primitive.
- **Route all static-secret-capable connectors to credential capture.** Rejected: connector-level
  capability is not connection-level state. A browser-session-bound SSO connection may have no
  password to capture.
- **Copy-only fix.** Rejected as insufficient: it leaves the repair route and stream fallback capable
  of sending the owner to the wrong or dead-end surface.

## Acceptance Checks

- A browser-session-bound connection with no reusable session and no stored credential starts
  browser-session repair, not static-secret credential capture.
- The same connection with a valid reusable session runs without prompting for a credential.
- A static-secret-bound connection with no usable stored credential routes to credential capture and
  fails closed before connector start.
- Connection health reports `credential_required` only for a static-secret-bound connection with no
  usable stored credential, and `credential_rejected` only when a stored credential was actually
  rejected.
- A browser-session repair run that has started but has not yet emitted assistance shows a
  browser-preparing state and transitions into the stream once browser-surface assistance appears.
- After a credential-shaped run failure, the connection does NOT project healthy/idle once the run
  reason code ages out; the credential/session repair state persists until proof of readiness.
- A scheduled/unattended run for the same connection defers (records repair-required evidence) and
  does not open any interactive login. (Already implemented; guarded by a regression test.)
- Browser-session repair never silently stores a password typed into the provider page.
- A non-ChatGPT static-secret pattern still fails closed / routes to capture, proving the rule is not
  ChatGPT-specific.

## Residual Risks

- Owner-only live verification: capturing a credential for `dondochaka` and confirming a run clears the
  reauth verdict is an owner action on the live stack; recorded as residual risk, not blocking.
- The precise UI treatment of the secondary "re-establish session" action is a product-design layer on
  top of this contract, owned by the console redesign change.
