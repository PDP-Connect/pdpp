# PWA and Web Push notification setup prior art

Date: 2026-07-05
Status: research corpus
Scope: owner-console PWA install, browser notification permission, Web Push subscription, and notification-click routing

## Question

What is the SLVP-ideal owner experience for enabling PDPP push notifications now that the owner console is a clean-route PWA and the old dashboard surface has been removed?

## Sources

- MDN, "Using the Notifications API", retrieved 2026-07-05: https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API
- MDN, "Notification: requestPermission() static method", retrieved 2026-07-05: https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static
- MDN, "Push API", retrieved 2026-07-05: https://developer.mozilla.org/en-US/docs/Web/API/Push_API
- MDN, "ServiceWorkerRegistration: pushManager property", retrieved 2026-07-05: https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/pushManager
- web.dev, "Permission UX", retrieved 2026-07-05: https://web.dev/articles/push-notifications-permissions-ux
- Chromium Blog, "Introducing quieter permission UI for notifications", retrieved 2026-07-05: https://blog.chromium.org/2020/01/introducing-quieter-permission-ui-for.html
- WebKit, "Web Push for Web Apps on iOS and iPadOS", retrieved 2026-07-05: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- Apple Developer Documentation, "Sending web push notifications in web apps and browsers", retrieved 2026-07-05: https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
- W3C, "Push API", retrieved 2026-07-05: https://www.w3.org/TR/push-api/

Related local corpus:

- `docs/research/owner-console-recovery-and-liveness-prior-art-2026-06-18.md`
- `docs/research/owner-actionability-prior-art-2026-06-29.md`
- `docs/research/connector-setup-repair-routing-prior-art-2026-07-01.md`
- `docs/research/connector-credential-session-repair-prior-art-2026-07-01.md`

## Findings

### 1. Permission prompting must be owner-initiated and contextual

MDN says notification permission should be requested only in response to an owner gesture, and modern browsers increasingly enforce or penalize non-gesture prompts. web.dev recommends moving notification enablement into a settings panel instead of prompting on first load. Chromium's quieter-permission UI exists specifically because unsolicited permission prompts are a poor user experience.

Implication for PDPP RI: the owner console should not ask for notification permission on page load, during connector setup, or after a background event. It should expose a clear setup surface, explain why notifications matter, and request permission only when the owner clicks an explicit control.

### 2. PWA install and push subscription are separate states

The web platform separates app installation, notification permission, service-worker registration, and `PushManager` subscription. MDN documents Push API subscription through a service worker, while WebKit documents iOS/iPadOS Web Push specifically for Home Screen web apps. Installing the PWA gives an app shell and launch surface; it does not by itself subscribe the device or guarantee display of notifications.

Implication for PDPP RI: the UI must not imply "installed PWA" equals "notifications enabled." It needs to show each state separately: install/open correct device, browser permission, service worker, server subscription, and test delivery.

### 3. Subscription is per browser profile/device, not per account globally

Web Push subscriptions are browser/device artifacts exposed through `ServiceWorkerRegistration.pushManager`. They can be present, absent, revoked, stale, or blocked independently on each browser profile and installed app.

Implication for PDPP RI: notification setup should be framed as "enable this device/browser" rather than "enable notifications for this account." Multi-device owners need a list or at least clear copy that each phone, desktop browser, and installed PWA profile is configured separately.

### 4. The right product surface is a dedicated notifications/settings surface

web.dev explicitly recommends a settings-panel pattern for notification enablement. For PDPP, notifications are not a source, sync, grant, or deployment primitive; they are the owner-attention delivery channel across those surfaces.

Implication for PDPP RI: notification setup belongs on a first-class route such as `/notifications` or `/settings/notifications`, reachable from the owner overview and from any "needs owner action" state when no subscribed device is available. It should not be an orphaned overview widget, buried source detail control, or hidden test-only affordance.

### 5. Notification clicks should route to the concrete owner action

The Push API gives the service worker a delivery path even when the web app is inactive. For PDPP, the value of a push notification is not the alert itself; it is fast return to the exact owner-action surface: source reconnect, sync stream, approval, coverage review, or local collector recovery.

Implication for PDPP RI: fallback notification URLs may land on `/syncs` or `/`, but action notifications should carry a clean canonical route to the exact thing requiring attention. The service worker should allow only clean owner-console routes and reject stale or legacy paths.

### 6. Stale installed PWA launch paths need bounded migration, not indefinite legacy routing

The live PDPP manifest now advertises `start_url: "/"` and `scope: "/"`, but an already-installed PWA can retain older app metadata or restore its last window URL. Removing the legacy `/dashboard/*` route can therefore make the installed app appear down even when web routes work.

Implication for PDPP RI: a clean-route migration should account for installed-app state. The target is not permanent support for legacy URLs, but a bounded migration/repair path that prevents a stale installed PWA from opening to a raw 404. This can be a time-bounded route shim, a purpose-built migration page, or an install-repair affordance, but the owner experience should not be "the app is down."

## SLVP ideal for PDPP RI

The ideal owner experience is a first-class **Notifications** surface:

- It is reachable from navigation, overview source-attention cards, and notification-related failure hints.
- It shows the current device/browser/PWA as the primary object.
- It separates install state, permission state, service-worker/subscription state, server delivery state, and test delivery.
- It requests permission only after an explicit owner click.
- It offers `Enable this device`, `Disable this device`, and `Send test notification`.
- It explains that each browser profile and installed app must be enabled separately.
- It scopes notification intent to owner-action events by default, not general status noise.
- It routes notification clicks to the specific source, sync, approval, or recovery surface.
- It protects clean-route migration so old PWA installs do not strand the owner on a raw 404.

Confidence: high. The platform constraints are stable and sourced from MDN, W3C, WebKit/Apple, web.dev, and Chromium. The exact PDPP route name and visual placement still require product implementation, but the user experience boundary is clear: notifications are a device-level owner-attention channel, not a connector setting and not an incidental dashboard widget.

## Anti-patterns

- Prompting for notifications on first load.
- Treating PWA install as equivalent to notification subscription.
- Hiding notification setup inside an unrelated page.
- Showing a notification setup component only in tests while no route renders it.
- Sending notification clicks to generic home when a concrete action is known.
- Preserving broad legacy dashboard routes forever instead of creating a bounded PWA migration path.
- Removing legacy launch paths without any migration or repair path for already-installed PWAs.
