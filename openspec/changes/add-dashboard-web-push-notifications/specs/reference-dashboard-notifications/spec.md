## ADDED Requirements

### Requirement: Dashboard Web Push SHALL be VAPID-configured and optional

The reference dashboard SHALL treat browser Web Push as an optional owner notification channel for pending connector interactions. Web Push delivery SHALL require valid VAPID configuration. The VAPID private key SHALL remain server-only, while the VAPID public key MAY be exposed to authenticated dashboard pages for subscription setup.

#### Scenario: VAPID is not configured

- **WHEN** the reference dashboard starts without complete valid VAPID configuration
- **THEN** dashboard Web Push subscription and delivery SHALL be reported as unavailable
- **AND** pending connector interactions SHALL remain visible in the dashboard
- **AND** ntfy/current notification channels SHALL remain eligible for delivery.

#### Scenario: VAPID is configured

- **WHEN** valid VAPID public and private keys are configured
- **THEN** authenticated dashboard pages MAY expose the public key for browser subscription
- **AND** the private key SHALL NOT be exposed to browser bundles, service workers, diagnostic responses, logs, or notification payloads.

### Requirement: Web Push subscriptions SHALL require authenticated owner opt-in

The reference dashboard SHALL persist browser push subscriptions only after explicit opt-in by an authenticated owner. Subscription management SHALL be owner-scoped and revocable.

#### Scenario: Unauthenticated subscription creation is attempted

- **WHEN** owner authentication is enabled and a request creates, updates, lists, or deletes a Web Push subscription without a valid owner session
- **THEN** the request SHALL be rejected
- **AND** no subscription endpoint SHALL be persisted, disclosed, updated, or deleted.

#### Scenario: Authenticated owner opts in

- **WHEN** an authenticated owner grants browser notification permission and submits a Push API subscription
- **THEN** the reference SHALL persist the endpoint and push keys as an owner-scoped delivery target
- **AND** the record SHALL include revocation or deletion state and operational metadata sufficient to troubleshoot delivery without storing notification secrets.

#### Scenario: Owner revokes a subscription

- **WHEN** an authenticated owner disables Web Push for a browser or device
- **THEN** the reference SHALL stop sending to that subscription
- **AND** it SHOULD delete or mark the subscription revoked
- **AND** it SHOULD ask the browser to unsubscribe when the active browser context still has access to the subscription.

### Requirement: Push payloads SHALL be non-secret and interaction-scoped

Dashboard Web Push notifications for pending connector interactions SHALL include only non-secret display and routing metadata. The payload SHALL be sufficient to route the owner to the relevant dashboard run or interaction UI, but SHALL NOT carry sensitive connector or interaction values.

#### Scenario: Pending interaction notification is sent

- **WHEN** a connector run enters a pending interaction state and Web Push delivery is attempted
- **THEN** the push payload MAY include a title, body, connector display label, run id, interaction id, interaction kind, timestamp, and dashboard-relative URL
- **AND** the URL SHALL route to the run or interaction UI protected by normal dashboard owner authentication.

#### Scenario: Sensitive interaction data exists

- **WHEN** the pending interaction concerns credentials, OTP, cookies, account data, raw connector output, tokens, or an interaction answer
- **THEN** the push payload SHALL NOT include those values
- **AND** the notification text SHALL NOT require the owner to infer or expose secret values on a lock screen.

### Requirement: Service worker behavior SHALL be safe and click-through oriented

The dashboard service worker SHALL handle push events by showing safe notifications and SHALL handle notification clicks by focusing or opening the dashboard run/interaction URL.

#### Scenario: Push event arrives with a valid payload

- **WHEN** the service worker receives a dashboard Web Push event for a pending connector interaction
- **THEN** it SHALL render a notification using non-secret title/body data
- **AND** it SHALL preserve routing metadata needed for click handling.

#### Scenario: Owner clicks the notification

- **WHEN** the owner clicks a pending-interaction notification
- **THEN** the service worker SHALL focus an existing matching dashboard client when practical or open a new dashboard window
- **AND** the target URL SHALL resolve to the relevant run/interaction UI
- **AND** normal owner authentication SHALL still guard any live dashboard state.

#### Scenario: Malformed push payload is received

- **WHEN** the service worker receives a malformed or unknown dashboard push payload
- **THEN** it SHALL fail closed by avoiding secret disclosure and avoiding navigation to untrusted URLs.

### Requirement: Dashboard opt-in UI SHALL feature-detect browser and PWA support

The dashboard SHALL expose Web Push only when the current browser context can support it and SHALL communicate unsupported states, denied permissions, insecure contexts, and PWA/iOS caveats without blocking other notification paths.

#### Scenario: Browser support is missing

- **WHEN** the browser lacks required Notification API, Push API, service worker, secure-context, or permission support
- **THEN** the dashboard SHALL show Web Push as unavailable for that browser context
- **AND** it SHALL continue to show pending interactions and ntfy/current notification options.

#### Scenario: Permission is denied

- **WHEN** the owner has denied browser notification permission
- **THEN** the dashboard SHALL not repeatedly prompt for permission
- **AND** it SHALL explain that notification permission must be changed in browser or OS settings.

#### Scenario: iOS or PWA constraints apply

- **WHEN** the owner uses a platform where Web Push requires an installed PWA, specific browser support, or OS-level notification permission
- **THEN** the dashboard SHALL present that limitation as a caveat or setup requirement
- **AND** it SHALL not imply that Web Push delivery is guaranteed before those platform requirements are met.

### Requirement: Web Push SHALL augment rather than replace existing channels

The reference implementation SHALL treat Web Push as a best-effort additional channel. Web Push failure, expiration, unavailability, or rejection SHALL NOT hide pending interactions and SHALL NOT prevent ntfy/current notification channels from being used.

#### Scenario: Web Push send fails

- **WHEN** a push provider rejects a subscription or a send attempt fails
- **THEN** the reference SHALL record or expose the failure for operator troubleshooting
- **AND** it SHALL disable, prune, or mark expired subscriptions when appropriate
- **AND** the pending interaction SHALL remain visible through the dashboard.

#### Scenario: Multiple notification channels are configured

- **WHEN** ntfy/current channels and Web Push subscriptions are both configured
- **THEN** a pending connector interaction SHALL remain eligible for delivery through the existing channels
- **AND** Web Push delivery SHALL NOT be the sole source of operator awareness.

### Requirement: Dashboard notification storage and delivery SHALL protect owner privacy

The reference dashboard SHALL minimize stored subscription data and notification content. Subscription endpoints and push keys SHALL be treated as sensitive delivery metadata, and notification delivery SHALL not disclose owner data beyond the authenticated dashboard context.

#### Scenario: Subscription records are inspected

- **WHEN** subscription records are logged, displayed in diagnostics, or returned to dashboard management UI
- **THEN** endpoint and key material SHALL be redacted or scoped to authenticated owner management views
- **AND** public docs, sandbox pages, and unauthenticated surfaces SHALL NOT disclose push subscription material.

#### Scenario: A notification is displayed on a shared device

- **WHEN** a browser or operating system displays a dashboard notification outside the authenticated dashboard page
- **THEN** the notification content SHALL remain limited to non-secret pending-interaction metadata
- **AND** live connector data, credentials, tokens, and interaction answers SHALL remain accessible only after normal dashboard authentication.
