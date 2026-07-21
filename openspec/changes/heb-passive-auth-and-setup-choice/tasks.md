## 1. Research / spec

- [x] Capture official H-E-B login, passkey, verification-code, and redirect facts in the research corpus.
- [x] Write an OpenSpec change that keeps the browser-session lifecycle intact and adds the generic dual setup choice.

## 2. Runtime implementation

- [x] Add H-E-B auto-login with a live-session probe, verified-form fill, challenge handoff, and post-handoff re-probe.
- [x] Wire H-E-B into the existing encrypted static-secret injection path.
- [x] Update the H-E-B manifest with credential capture and honest human-interaction metadata.

## 3. Console implementation

- [x] Surface the browser-session vs saved-sign-in-details choice generically for browser-bound connectors with static-secret capture.
- [x] Keep non-browser static-secret connectors on the existing single-path setup.

## 4. Tests / validation

- [x] Add fixture-driven H-E-B auto-login tests.
- [x] Add console tests for H-E-B and a synthetic browser-bound static-secret connector.
- [x] Run the focused connector, console, OpenSpec, typecheck, and diff checks.
