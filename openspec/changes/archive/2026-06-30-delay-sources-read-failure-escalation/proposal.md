## Why

The Sources route can surface a segment error banner during a transient server-component read failure. That is too alarming for a one-off refresh blip, and the existing copy overclaims by saying it is showing last-known status when the boundary itself does not render the prior source cards.

## What Changes

- Attempt one quiet automatic recovery before rendering explicit read-failure copy.
- Keep a persistent failure visible with retry controls.
- Rephrase final fallback copy around the last successful load timestamp, not "showing" a cached source list.

## Capabilities

Modified:

- `reference-connection-health`

## Impact

- Owners no longer see the "Couldn't refresh your connections" banner for the first transient refresh failure.
- Persistent read failures remain visible and actionable.
