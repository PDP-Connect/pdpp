## Why

H-E-B is already browser-bound in the connector runtime and already has a generic browser-session enrollment path in the console. What it lacks is a low-maintenance owner choice between:

- session-only secure browser login, where PDPP stores only the browser/session state needed to keep collection alive, and
- saved sign-in details, where PDPP can repair the same connection automatically from encrypted credentials.

The runtime currently falls back to a manual browser handoff when H-E-B's session is dead. That is honest, but it is not low-maintenance when the connector can safely reuse stored sign-in details. The product should not invent connector-specific UI to solve this; the choice is generic for any browser-bound connector that also declares a static-secret capture capability.

## What Changes

- Add H-E-B browser auto-login that probes a live session first, fills only the verified login form when stored sign-in details are available, and waits for a bounded post-submit page-state transition before any re-probe.
- Treat optional passkey / one-time-code affordances as non-authoritative when a visible, enabled credential form is available; handle verification-code pages through structured OTP and only hand off when the normal credential path is absent, blocked, or actually challenged after submit.
- Route all H-E-B passkey, CAPTCHA, Incapsula, unknown-UI, timeout, and failed-auto-login cases to the secure browser with a precise owner handoff and a post-handoff re-probe.
- Declare H-E-B credential capture in the manifest only because the implementation exists, and keep the existing browser-session lifecycle intact.
- Expose the browser-session vs saved-sign-in-details choice in the shared console setup presentation for any browser-bound connector that also has static-secret capture.
- Preserve the existing generic static-secret capture path for non-browser connectors.

## Capabilities

- Modified: `browser-collector-session-repair`
- Modified: `reference-connector-settings`

## Impact

- H-E-B gains a low-maintenance session-repair path without a connector-specific UI fork.
- Other browser-bound connectors can reuse the same capability-derived choice when they also declare static-secret capture.
- Non-browser static-secret connectors keep their existing setup path unchanged.
