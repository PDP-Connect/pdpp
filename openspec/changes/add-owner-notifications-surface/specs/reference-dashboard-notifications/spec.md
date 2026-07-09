## MODIFIED Requirements

### Requirement: Owner-console opt-in UI SHALL feature-detect browser and PWA support

The owner console SHALL expose Web Push only when the current browser context can support it and SHALL communicate unsupported states, denied permissions, insecure contexts, and PWA/iOS caveats without blocking other notification paths. The owner console SHALL expose this setup as a first-class owner Notifications surface, reachable from normal owner navigation, rather than only as an incidental overview widget.

#### Scenario: Browser support is missing

- **WHEN** the browser lacks required Notification API, Push API, service worker, secure-context, or permission support
- **THEN** the owner console SHALL show Web Push as unavailable for that browser context
- **AND** it SHALL continue to show pending interactions and ntfy/current notification options.

#### Scenario: Permission is denied

- **WHEN** the owner has denied browser notification permission
- **THEN** the owner console SHALL not repeatedly prompt for permission
- **AND** it SHALL explain that notification permission must be changed in browser or OS settings.

#### Scenario: iOS or PWA constraints apply

- **WHEN** the owner uses a platform where Web Push requires an installed PWA, specific browser support, or OS-level notification permission
- **THEN** the owner console SHALL present that limitation as a caveat or setup requirement
- **AND** it SHALL not imply that Web Push delivery is guaranteed before those platform requirements are met.

#### Scenario: Owner installs the owner console

- **WHEN** the owner opens the owner console from a mobile browser that supports installable web apps
- **THEN** the web application manifest SHALL identify the owner console as a standalone installable app
- **AND** the manifest SHALL start installed sessions at the owner console root rather than at public documentation, marketing pages, or removed route prefixes.

#### Scenario: Owner wants to enable notifications

- **WHEN** an owner opens the owner console
- **THEN** the console SHALL expose a first-class Notifications surface reachable from normal navigation
- **AND** the surface SHALL explain that notification setup applies to the current browser, profile, or installed app
- **AND** permission prompting SHALL require an explicit owner action on that surface.

#### Scenario: Owner has no subscribed browser

- **WHEN** an owner has no active browser push subscription
- **THEN** the console SHALL provide a discoverable path to the Notifications surface
- **AND** it SHALL NOT imply that installing the PWA alone enables push delivery.

#### Scenario: Current owner navigation is generated

- **WHEN** the console renders navigation, command palette entries, service-worker click targets, or owner action links
- **THEN** those generated links SHALL use clean owner routes
- **AND** they SHALL NOT emit `/dashboard/*` links.
