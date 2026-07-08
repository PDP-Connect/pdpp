## Why

The reference health projection already distinguishes stored-credential evidence from browser-session-bound connections, but the rendered required action still exposes only a generic `reauth` action. Owner console surfaces then infer the repair route from connector-level manifest capabilities and connection binding, which is brittle for mixed connectors such as ChatGPT.

This leaves a real UX gap: a connection can say "reconnect" while routing the owner to static-secret credential capture even when the evidence says the browser/session path needs repair. The fix is to carry the bounded owner-action surface through the shared rendered verdict.

## What Changes

- Add a typed repair/action surface to rendered required actions and connection condition remediation.
- Classify session-required credential failures as browser-session repair, not stored-credential rejection.
- Update owner console connection detail actions to use the rendered action surface before falling back to legacy route inference.
- Keep existing static-secret credential capture/rotation behavior for connections whose evidence says the stored credential is missing or rejected.

## Capabilities

- Modified: `reference-connection-health`

## Impact

- Affects the reference connection-health projection and owner console repair routing.
- Backwards compatible for older rendered verdict payloads because the console retains a fallback route inference path when an action surface is absent.
