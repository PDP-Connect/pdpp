## Why

Pending connector interactions can block collection runs while the owner is away from the dashboard. The reference already supports ntfy/current notification channels, but installed dashboard/PWA users need a browser-native prompt that can deep-link back to the exact run interaction without replacing ntfy.

## What Changes

- Add reference-dashboard Web Push/PWA notifications for pending connector interactions.
- Store push subscriptions only after authenticated owner opt-in.
- Send non-secret payloads that deep-link to the run/interaction UI.
- Define service worker, feature-detection, PWA/iOS caveat, fallback, and security/privacy constraints.

## Capabilities

Added:

- `reference-dashboard-notifications`

## Impact

- Affects the reference dashboard operator surface and reference-only pending-interaction notification delivery.
- Requires VAPID public/private key configuration before browser push can be enabled.
- Does not modify connector/runtime Chase code.
- Does not replace ntfy or existing channels; Web Push is an additional best-effort channel.
