## 1. Configuration And Storage

- [ ] 1.1 Add server-only VAPID private-key configuration and authenticated dashboard exposure of the VAPID public key.
- [ ] 1.2 Add owner-authenticated subscription create/list/delete surfaces for dashboard Web Push subscriptions.
- [ ] 1.3 Store push subscriptions with revocation, failure, platform, and last-used metadata.

## 2. Dashboard And Service Worker

- [ ] 2.1 Add dashboard feature detection for Push API, Notification API, service worker support, permission state, secure context, and VAPID availability.
- [ ] 2.2 Add explicit owner opt-in, unsubscribe, and status UI with PWA/iOS caveat copy.
- [ ] 2.3 Add a service worker push handler that renders safe notifications and handles click-through to the run/interaction UI.

## 3. Notification Delivery

- [ ] 3.1 Fan out pending connector-interaction notifications to subscribed Web Push endpoints without replacing ntfy/current channels.
- [ ] 3.2 Ensure push payloads carry only non-secret routing/display metadata.
- [ ] 3.3 Disable, prune, or mark subscriptions when push providers report expired or rejected endpoints.

## 4. Security, Privacy, And Tests

- [ ] 4.1 Add tests proving unauthenticated subscription mutations are rejected when owner auth is enabled.
- [ ] 4.2 Add tests proving push payloads omit credentials, OTPs, tokens, cookies, raw connector data, and interaction answers.
- [ ] 4.3 Add service worker or browser-facing tests for unsupported-feature, denied-permission, and click-through behavior.
- [ ] 4.4 Add fallback tests proving Web Push failure does not block dashboard visibility or ntfy/current notification delivery.

## 5. Checks

- [ ] 5.1 Run targeted dashboard notification tests.
- [ ] 5.2 Run relevant reference implementation tests.
- [ ] 5.3 Run `openspec validate add-dashboard-web-push-notifications --strict`.
