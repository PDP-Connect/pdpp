## Why

A live connection (`ChatGPT - dondochaka`) is `source_kind: account` with
`source_binding.kind: browser_collector` and no `connector_instance_credentials` row. It
logs in via Google SSO through the browser — it has no username/password to store. Yet the
owner-facing repair routed toward **static-secret credential capture** because the *connector*
(ChatGPT) has connector-level username_password support, even though this *connection* is
bound as a browser session. Routing an SSO/browser-session connection to "capture a
credential" is wrong: there is no credential to capture; its repair is browser/session repair.

The defect is a **connection-binding-first** gap: repair selection keyed on the connector's
static-secret *capability* instead of the connection's *binding*. The archived change
`2026-07-01-define-connection-repair-routing` already requires repair state to come from
connection-scoped evidence, not connector capability — so this is implementation drift, not a
new contract.

## What Changes

- **Connection-binding-first repair selection.** A connection bound as a browser session
  (`source_binding.kind ∈ {browser_collector, browser_enrollment_shell}`) SHALL repair by
  browser/session repair, NOT static-secret credential capture — even when the connector also
  supports a username_password static secret. Static-secret credential capture SHALL be the
  repair only for a connection actually bound as static-secret (or if the owner explicitly
  converts the connection's auth mode).
- **Credential-presence evidence is connection-binding-scoped.** Connection health SHALL
  derive stored-credential-presence evidence only for a connection that is static-secret-bound.
  For a browser-session-bound connection, an absent credential row is normal (its auth is the
  session), so it SHALL NOT project `credential_required` / an owner credential-capture action.
- **Honest no-usable-credential state for static-secret-bound connections.** For a
  static-secret-bound connection, health SHALL model "no usable stored credential" as durable
  evidence distinct from "stored credential rejected," derived from credential-presence
  evidence rather than a transient run reason code alone; both project an owner reauth/capture
  action with honest, non-conflated copy.
- **No age-only healing.** A credential/session repair condition SHALL NOT flip to
  healthy/idle merely because a credential-shaped run reason code aged out.
- **No fabricated repair from unavailable evidence.** A credential-store read *failure* SHALL
  be treated as evidence-unavailable (fall back to run-reason behavior), never as
  "no credential" — so a transient store error cannot fabricate a false reconnect prompt.
- No Google/SSO-specific manifest semantics are added; the discriminator is the connection's
  binding kind, a connection-scoped fact.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `polyfill-runtime`: Clarifies binding-first repair selection — a browser-session-bound
  connection repairs by browser/session repair even when the connector supports a static secret.
- `reference-connection-health`: Credential-presence evidence is connection-binding-scoped;
  adds durable "no usable credential" (static-secret-bound only) distinct from rejection;
  forbids age-only healing and fabricating repair from unavailable evidence.
- `reference-run-assistance`: A browser-session connection's owner-mediated repair is
  browser/session repair, not static-secret credential capture.

## Impact

- Affects the connection-health credential/session projection (`connection-health.ts`), the
  server summary projection (`ref-control.ts`, binding-scoped credential evidence + exposing
  `source_binding_kind`), and the console repair-destination router
  (`records/[connector]/page.tsx`, binding-first `credentialUpdateHref`).
- Does NOT change the connector session-repair branch: a browser-session connection with no
  reusable session and no stored credential correctly performs the interactive browser login
  (that IS its session repair); a static-secret-bound connection with no usable credential
  still fails closed in `resolveStaticSecretRunEnv` before the run starts.
- Does not change PDPP Core semantics; browser automation remains a reference/polyfill mechanism.
- Governed by the archived `2026-07-01-define-connection-repair-routing` contract; this change
  is the implementation-refining follow-up it anticipated.
