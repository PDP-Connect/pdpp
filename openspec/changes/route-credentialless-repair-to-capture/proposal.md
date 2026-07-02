## Why

A live connection (`ChatGPT - dondochaka`, `source_binding.kind: browser_collector`, no
stored credential) routed toward a one-off interactive browser login as its steady-state
repair, even though the server-hosted browser profile was logged out. This is bad
steady-state UX: the durable repair for a static-secret-capable connection with no usable
credential is to capture a credential for the existing connection, not to re-drive a
throwaway browser login each time.

The archived change `2026-07-01-define-connection-repair-routing` already established the
governing boundary (manifests declare stable mechanisms; connection-scoped evidence decides
current repair; scheduled runs defer owner-mediated repair). This change closes the
implementation gap that boundary implies but the current specs still permit: the merged
`polyfill-runtime` scenario "Browser-session repair has no stored login credential"
explicitly allows the one-off browser hand-off as an acceptable no-credential manual repair,
and `reference-connection-health` models only *credential rejection*, not the distinct,
durable *no-usable-credential* state. So the honest primary repair is neither required nor
projected.

## What Changes

- For a connection whose connector is static-secret-capable, when there is no usable stored
  credential and no reusable session, owner-mediated repair SHALL route to durable
  credential capture for the existing connection as the primary action; a one-off interactive
  browser login SHALL NOT be the silent default. Browser-session repair remains available as
  an explicit, clearly-labeled secondary session-repair path.
- Connection health SHALL model "no usable credential" as durable connection evidence
  distinct from "stored credential rejected," derived from credential-presence evidence rather
  than a transient run reason code alone. Both project as an owner reauth/capture action, but
  with honest, non-conflated copy.
- Connection repair state driven by a credential/session condition SHALL NOT flip to
  healthy/idle merely because a credential-shaped run reason code aged out; it SHALL remain
  derived from durable credential/session evidence until proof of readiness.
- The one-off interactive browser-login branch SHALL emit repair-required evidence that names
  credential capture as the durable owner action instead of presenting the throwaway login as
  the default.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `polyfill-runtime`: Refines no-stored-credential browser-session repair so durable credential
  capture is the primary owner repair for static-secret-capable connections.
- `reference-connection-health`: Adds durable "no usable credential" evidence distinct from
  rejection and forbids age-only healing of the credential/session axis.
- `reference-run-assistance`: Requires the no-credential interactive-login branch to surface
  credential-capture repair evidence rather than a silent one-off browser login.

## Impact

- Affects the run-credential resolver escape hatch (`static-secret-run-credentials.js`), the
  browser-bound + static-secret connector session-repair branch (e.g. `auto-login/chatgpt.ts`),
  the connection-health credential/session projection (`connection-health.ts`), the rendered
  verdict copy, and owner-facing repair copy.
- Does not change PDPP Core semantics; browser automation remains a reference/polyfill mechanism.
- Does not change the invariant-tested routing PRIORITY (stored-credential repair before browser
  fallback); it makes the no-credential case route to capture rather than a silent browser login.
- Governed by the archived `2026-07-01-define-connection-repair-routing` contract; this change is
  the implementation-refining follow-up it anticipated.
