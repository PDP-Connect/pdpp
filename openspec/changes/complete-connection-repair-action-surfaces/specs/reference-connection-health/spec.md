## MODIFIED Requirements

### Requirement: Connection Health SHALL Preserve Evidence Before Projection

The reference implementation SHALL model connection health as raw facts normalized into typed conditions and then into a derived projection.

Stored-credential-presence evidence SHALL be connection-binding-scoped: it applies only to a connection that is bound as static-secret. For such a connection the credential-readiness condition SHALL distinguish "no usable stored credential" from "stored credential rejected" as durable connection evidence, derived from credential-presence evidence rather than inferred solely from a transient run reason code; both project as an owner reauth/capture action, with honest, non-conflated reason and copy. A connection bound as a browser session SHALL NOT project a "no usable stored credential" condition from an absent credential row, because it authenticates by owner-authenticated browser session rather than a stored credential. A credential-readiness or session-readiness condition SHALL NOT project the connection healthy or idle merely because a credential-shaped run reason code aged out; it SHALL remain derived from durable evidence until readiness is proven.

Credential/session remediation metadata SHALL include a bounded owner-action surface that tells owner surfaces which repair path to open. Stored-credential missing or rejected evidence SHALL project the stored-credential surface. Session-required evidence SHALL project the browser-session surface unless stronger evidence proves the stored credential itself was rejected.

#### Scenario: Browser-session-required failure routes to browser-session repair

**WHEN** a run failure reason proves that the provider browser session is required or inactive
**AND** there is no stronger evidence that the stored credential itself was provider-rejected
**THEN** the reference implementation SHALL record a `CredentialsValid` readiness condition with an owner-action surface of `browser_session`
**AND** the projected required action SHALL carry the same surface
**AND** owner surfaces SHALL route the action to browser/session repair rather than static-secret credential capture.

### Requirement: Owner Surfaces SHALL Share One Projection Contract

Dashboard, CLI, and owner-control-plane API surfaces SHALL consume the same connection health projection and condition contract.

Owner-console surfaces that classify connection status or owner actionability SHALL use a shared actionability projection over the server-owned rendered verdict. A surface MAY render a different layout or join additional surface-specific data, but it SHALL NOT independently decide whether the primary action is owner-satisfiable, whether the connection requires owner action now, or whether a source belongs in owner-required, review, system-issue, or checking work.

Owner surfaces that render a repair link for a required action SHALL use the rendered action's owner-action surface when it is present. They SHALL NOT choose between static-secret credential capture, browser-session repair, provider interaction, or local-device recovery from connector-level manifest capability alone. A surface MAY keep a compatibility fallback for older reference payloads that do not include the action surface.

#### Scenario: Repair link uses the rendered action surface

**WHEN** a rendered required action has `kind=reauth` and an owner-action surface of `stored_credential`
**THEN** the owner console SHALL route the action to stored credential update/capture for the existing connection.

**WHEN** a rendered required action has `kind=reauth` and an owner-action surface of `browser_session`
**THEN** the owner console SHALL route the action to browser-session repair for the existing connection.
