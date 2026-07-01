## Context

The live run history shows a clear owner-experience regression:

- From 2026-06-14 through 2026-06-24, ChatGPT scheduled collection was roughly 98% successful and quiet.
- On 2026-06-25, the usable session stopped being accepted and runs began failing fast.
- After stored credentials were injected into scheduled runs, the same scheduled path could submit ChatGPT credentials, trigger app approval, and page the owner.

Stored-credential parity is necessary for connectors that are safe to refresh with static secrets. For ChatGPT, credentials are not sufficient for unattended collection because login commonly triggers device approval or manual browser work.

## Decision

Separate "session reuse" from "auth repair."

Automatic ChatGPT runs will:

1. open/probe `https://chatgpt.com/`;
2. proceed only if the initial API session probe succeeds;
3. fail with a typed auth-required error if no usable session exists;
4. never submit credentials, request app approval assistance, request OTP, or emit manual browser action from a non-manual run.

Manual ChatGPT runs will keep the existing behavior:

1. probe the existing session first;
2. use stored credentials when needed;
3. wait for ChatGPT app approval when the source requests it;
4. fall back to OTP/manual browser interaction when necessary.

The runtime will expose run trigger and automation metadata to child connectors via bounded environment variables. This avoids connector-specific database coupling and lets a connector decide whether owner-interactive auth repair is allowed for the current run.

## Alternatives

### Revert stored credentials for ChatGPT schedules

Rejected. It would silence notifications but reintroduce scheduled/manual credential parity bugs and would not express the real invariant.

### Accept DOM-visible ChatGPT login as an active session

Rejected for this tranche. Existing diagnostics prove the API session check failed in noisy runs, but they do not prove that DOM-visible login is sufficient for ChatGPT data APIs. Changing the probe would be speculative.

### Disable ChatGPT scheduling entirely

Rejected as the durable fix. The reference should support quiet scheduled reuse of an authenticated browser session. Schedules should pause/degrade when auth repair is needed, not be removed as a capability.

### Let automatic runs prompt once, then suppress later ticks

Rejected. The first background prompt is already the user-visible regression. Owner-attended auth repair should start from an owner gesture.

## Acceptance checks

- A scheduled ChatGPT run with no active API session exits before opening the credential login path.
- The same scheduled path emits no `ASSISTANCE` and no `INTERACTION`.
- A manual ChatGPT run with no active API session still reaches the credential login path and can request app approval/OTP/manual action as before.
- Runtime-spawned connector children receive bounded trigger and automation metadata.
- The ChatGPT manifest copy no longer claims background runs may ask for owner help.
- Local targeted tests and OpenSpec strict validation pass.
- Live validation keeps the ChatGPT schedule off until a controlled trial proves no owner prompt is emitted by a scheduled/auth-missing run.
