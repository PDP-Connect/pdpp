## 1. Auth And Theme Polish

- [x] 1.1 Add CSS-only dark-mode support for hosted owner pages.
- [x] 1.2 Add explicit owner-session TTL env parsing and update default lifetime.
- [x] 1.3 Document the owner-session TTL tradeoff.

## 2. PWA And Notification Readiness

- [x] 2.1 Verify the existing manifest is not duplicated.
- [x] 2.2 Tighten tests for install metadata, icon handlers, service worker registration, and notification caveats.

## 3. Checks

- [x] 3.1 Run targeted owner-session, owner-auth, hosted UI, and web push tests.
- [x] 3.2 Run `openspec validate polish-dashboard-auth-pwa-ux --strict`.
