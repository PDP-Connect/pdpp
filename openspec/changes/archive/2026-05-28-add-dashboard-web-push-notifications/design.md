## Context

Interactive connector runs already surface pending actions in the dashboard and can use ntfy/current notification channels. That is sufficient for many local/server deployments, but it is weak for operators who primarily return through a browser or installed PWA. Browser Web Push can notify those operators and launch them directly into the pending run interaction.

This change is reference-only operator UX. It does not define PDPP protocol semantics and does not alter connector interaction behavior.

## Decision

Add Web Push as an opt-in dashboard notification channel for pending connector interactions. The dashboard will expose a feature-detected opt-in flow, register a service worker, subscribe through the browser Push API, and store the resulting subscription under the authenticated owner context.

The server side will require configured VAPID public/private keys before enabling browser push. Subscriptions will be stored as revocable owner-device delivery targets, not as public client state. Notification sends will contain only routing and display-safe metadata, such as connector display name, run id, interaction id, interaction kind, and a dashboard URL. Secret prompt values, credential material, OTP values, cookies, access tokens, and raw connector payloads will never be placed in push payloads.

Web Push augments ntfy/current channels. A failed, unavailable, expired, unsupported, or unconfigured browser push path must not prevent ntfy/current delivery or dashboard in-app visibility.

## Rationale

Web Push fits pending interactions because it supports out-of-page delivery and click-through. It is still less universal than ntfy: browser permission prompts are easy to deny, background delivery is best effort, and iOS support depends on an installed PWA and platform/browser versions. Treating Web Push as an optional channel keeps notification reliability tied to existing channels while improving the browser-native path.

Storing subscriptions only after an owner-authenticated opt-in prevents anonymous visitors or public documentation users from registering delivery targets. Using non-secret payloads limits damage if a push provider, browser notification center, lock screen, or shared device exposes notification text.

## Out Of Scope

- Replacing ntfy or changing current notification-channel behavior.
- Introducing a public PDPP notification API.
- Persisting connector credentials, OTP values, cookies, or interaction answers.
- Modifying connector/runtime Chase code.
- Guaranteeing Web Push delivery across all browsers, mobile OS versions, or notification-permission states.

## Implementation Notes

- The VAPID private key is server-only configuration and must not be exposed to client bundles, service workers, diagnostic JSON, logs, or push payloads.
- The VAPID public key may be exposed to authenticated dashboard pages for browser subscription.
- Subscription records should include enough metadata for operator management and cleanup: endpoint, keys, owner/device label when available, created timestamp, last-success timestamp, last-failure timestamp, failure reason, user agent/platform summary, and revoked/deleted state.
- Unsubscribe and delete flows should remove local subscription records and attempt browser-side unsubscribe when possible.
- Push click handling should focus or open the dashboard URL for the run interaction, then let normal owner authentication protect the page.

## Acceptance Checks

- With VAPID unset or invalid, the dashboard reports Web Push unavailable and pending interactions still appear in the dashboard and use ntfy/current channels.
- With owner auth enabled, unauthenticated subscription create/delete requests fail and do not persist push endpoints.
- A supported browser can opt in, create a subscription, receive a pending-interaction notification, and click through to the matching dashboard run/interaction UI.
- Notification payload inspection shows no credentials, OTPs, tokens, cookies, raw connector outputs, or interaction answers.
- Unsupported browsers, denied permissions, missing service workers, and iOS/PWA limitations are represented as actionable UI states rather than hard errors.
- Expired or rejected subscriptions are pruned or disabled without blocking other delivery channels.

## Open Questions

- Should the dashboard expose per-connector notification preferences in the first implementation, or only one owner-level Web Push toggle?
- Should notification text include the connector display name on lock screens by default, or should privacy mode hide source names until the owner opens the dashboard?
- Should subscription storage live in the existing reference database schema or in a separate dashboard/operator settings store?
