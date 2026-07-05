## MODIFIED Requirements

### Requirement: Dashboard opt-in UI SHALL feature-detect browser and PWA support

The dashboard SHALL expose Web Push only when the current browser context can support it and SHALL communicate unsupported states, denied permissions, insecure contexts, and PWA/iOS caveats without blocking other notification paths. The dashboard SHALL expose this setup as a first-class owner Notifications surface, reachable from normal owner navigation, rather than only as an incidental overview widget.

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

#### Scenario: Owner installs the dashboard

- **WHEN** the owner opens the dashboard from a mobile browser that supports installable web apps
- **THEN** the web application manifest SHALL identify the dashboard as a standalone installable app
- **AND** the manifest SHALL start installed sessions at the owner dashboard rather than at public documentation or marketing pages.

#### Scenario: Owner wants to enable notifications

- **WHEN** an owner opens the owner console
- **THEN** the console SHALL expose a first-class Notifications surface reachable from normal navigation
- **AND** the surface SHALL explain that notification setup applies to the current browser, profile, or installed app
- **AND** permission prompting SHALL require an explicit owner action on that surface.

#### Scenario: Owner has no subscribed browser

- **WHEN** an owner has no active browser push subscription
- **THEN** the console SHALL provide a discoverable path to the Notifications surface
- **AND** it SHALL NOT imply that installing the PWA alone enables push delivery.

## ADDED Requirements

### Requirement: Installed PWA stale launch paths SHALL fail into repair, not raw 404

The owner console SHALL account for installed PWA clients that retain old launch metadata or restore a removed route after a clean-route migration. Removed legacy route prefixes SHALL NOT be used for new navigation, but a stale installed app SHALL land on a bounded repair surface rather than a raw 404.

#### Scenario: Installed PWA opens removed dashboard route

- **WHEN** an installed PWA or browser window opens `/dashboard` or a child path after clean owner routes have replaced the old dashboard prefix
- **THEN** the console SHALL render an owner-readable repair surface
- **AND** the surface SHALL link to current clean owner routes such as `/`, `/sources`, `/syncs`, and `/notifications`
- **AND** it SHALL explain that reinstalling the PWA may clear stale launch metadata.

#### Scenario: Current owner navigation is generated

- **WHEN** the console renders navigation, command palette entries, service-worker click targets, or owner action links
- **THEN** those generated links SHALL use clean owner routes
- **AND** they SHALL NOT emit `/dashboard/*` links except for the stale-launch repair surface itself.
