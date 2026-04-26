## Why

The reference already has schedule persistence and run control, but the UX is not good enough for real connector operations. Owners need to see connectors in one place, understand freshness, and choose refresh behavior that respects platform-specific auth friction, OTP prompts, session length, rate limits, and bot-detection sensitivity.

Connector authors also need a way to recommend safe defaults without making those defaults normative PDPP protocol behavior.

## What Changes

- Add connector-declared refresh policy hints to first-party polyfill manifests.
- Improve the reference schedule control plane and dashboard UX around recommended cadence, manual-only posture, freshness, interactions, backoff, and pausing.
- Keep refresh policy as reference/runtime metadata unless a future interoperability need justifies promoting it into a Collection Profile or root PDPP companion spec.

## Capabilities

Modified:
- `reference-implementation-runtime`
- `polyfill-runtime`

## Impact

- Touches schedule persistence, dashboard run/schedule views, connector manifest validation, first-party manifests, and scheduler tests.
- Does not require changing the public records/search query contract.
- May expose future profile-candidate semantics around connector-declared operational hints.
