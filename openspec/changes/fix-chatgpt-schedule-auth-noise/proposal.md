## Why

ChatGPT scheduled runs were historically quiet when a browser session was already usable. After stored credentials began reaching scheduled runs, a scheduled run with an expired or rejected ChatGPT session could submit username/password, trigger ChatGPT app approval, and create owner push notifications on an hourly path.

That violates the intended automatic-refresh posture. A background schedule may reuse an already-valid session, but interactive auth repair belongs to an owner-started run.

## What Changes

- Thread run trigger and automation metadata to connector child processes.
- Make ChatGPT automatic/scheduled runs session-reuse-only: if the initial session probe fails, the connector exits with a typed auth-required failure before credential login, assistance, or manual action.
- Keep manual ChatGPT runs able to use stored credentials, app approval, OTP, and browser handoff to repair auth.
- Update the ChatGPT refresh policy copy so automatic refresh no longer promises owner assistance during background runs.
- Add tests covering scheduled no-prompt behavior and manual auth-repair behavior.

## Capabilities

Modified:

- `polyfill-runtime`

## Impact

- Prevents recurring ChatGPT push notifications from automatic refresh attempts.
- Preserves owner-initiated auth recovery and collection.
- Does not change PDPP Core protocol semantics or grant behavior.
