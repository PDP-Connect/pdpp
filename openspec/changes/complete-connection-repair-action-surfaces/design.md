## Context

Archived change `define-connection-repair-routing` established the boundary: manifests declare stable setup and automation mechanisms; live repair routing comes from observed runtime evidence and connection-scoped health conditions. The implementation has part of that boundary already:

- browser-session-bound connections do not fabricate `credential_required` from an absent stored credential row;
- static-secret-bound connections still route missing/rejected credentials to credential capture;
- connection detail pages prefer browser-session binding before connector-level static-secret capability.

The missing piece is the shared rendered action. `RequiredAction.kind = "reauth"` is too coarse for routing and labeling. It says the owner must repair authentication, but not whether the repair surface is stored credential capture, browser session, provider interaction, local device, or another bounded surface.

## Decision

Add a small, stable owner-action surface discriminator to the shared projection:

- `stored_credential`: the owner provides or rotates a stored credential for this existing connection.
- `browser_session`: the owner re-establishes an authenticated browser/session proof for this existing connection.
- `provider_interaction`: the owner completes provider-side interaction such as an approval, OTP, consent, or challenge.
- `local_device`: the owner acts on a local collector/device.
- `runtime_retry`, `schedule`, `maintainer`, and `none`: non-secret non-navigation classifications for existing action families.

The discriminator is evidence-derived, not manifest-derived. Manifests can still declare setup mechanisms; they do not decide the live route for a current repair request.

## Preserve Existing Improvements

Do not revert the static-secret repairs that were added for true missing/rejected stored credentials. A static-secret-bound connection with no usable credential still needs credential capture. A browser-session-bound connection with no credential row still needs browser-session repair. A static-secret-capable mixed connector whose run reason says `session_required` needs browser/session repair for that failure, not a password update.

## UI Rule

Owner console surfaces SHALL use the rendered action surface when present. They may keep fallback route inference only for compatibility with older reference payloads.

## Acceptance Checks

- Stored credential missing/rejected conditions project `surface.kind = "stored_credential"`.
- Session-required failures project `surface.kind = "browser_session"` and do not assert provider credential rejection.
- Rendered `reauth` actions carry the selected surface.
- Connection detail primary repair links route to static-secret capture for `stored_credential` and browser-session repair for `browser_session`.
- Static-secret repair copy says credential update/capture rather than generic reconnect.
