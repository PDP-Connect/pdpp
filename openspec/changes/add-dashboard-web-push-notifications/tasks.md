## 1. Configuration And Storage

- [x] 1.1 Add server-only VAPID private-key configuration and authenticated dashboard exposure of the VAPID public key.
- [x] 1.2 Add owner-authenticated subscription create/list/delete surfaces for dashboard Web Push subscriptions.
- [x] 1.3 Store push subscriptions with revocation, failure, platform, and last-used metadata.

## 2. Dashboard And Service Worker

- [x] 2.1 Add dashboard feature detection for Push API, Notification API, service worker support, permission state, secure context, and VAPID availability.
- [x] 2.2 Add explicit owner opt-in, unsubscribe, and status UI with PWA/iOS caveat copy.
- [x] 2.3 Add a service worker push handler that renders safe notifications and handles click-through to the run/interaction UI.
- [x] 2.4 Add an installable dashboard PWA manifest so mobile browsers can save the owner dashboard as a standalone app.

## 3. Notification Delivery

- [x] 3.1 Fan out pending connector-interaction notifications to subscribed Web Push endpoints without replacing ntfy/current channels.
- [x] 3.2 Ensure push payloads carry only non-secret routing/display metadata.
- [x] 3.3 Disable, prune, or mark subscriptions when push providers report expired or rejected endpoints.
- [x] 3.4 Add an owner-authenticated test-notification path so subscribed browsers can verify delivery without inducing a connector run.

## 4. Security, Privacy, And Tests

- [x] 4.1 Add tests proving unauthenticated subscription mutations are rejected when owner auth is enabled.
- [x] 4.2 Add tests proving push payloads omit credentials, OTPs, tokens, cookies, raw connector data, and interaction answers.
- [x] 4.3 Add service worker or browser-facing tests for unsupported-feature, denied-permission, and click-through behavior.
- [x] 4.4 Add fallback tests proving Web Push failure does not block dashboard visibility or ntfy/current notification delivery.

## 5. Checks

- [x] 5.1 Run targeted dashboard notification tests.
- [x] 5.2 Run relevant reference implementation tests.
- [x] 5.3 Run `openspec validate add-dashboard-web-push-notifications --strict`.
