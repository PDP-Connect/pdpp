## Context

Research in `docs/research/pwa-web-push-notification-setup-prior-art-2026-07-05.md` establishes the product boundary:

- notification permission must be owner-initiated;
- PWA install and Web Push subscription are separate states;
- Web Push subscription is per browser profile/device;
- setup belongs in a settings-style surface, not an incidental dashboard widget;
- stale installed PWA launch paths need migration so the app does not appear down.

The current implementation already has:

- `apps/console/src/app/(console)/components/web-push-settings.tsx`;
- `/_ref/web-push/config`, `/_ref/web-push/subscriptions`, and `/_ref/web-push/test`;
- `apps/console/public/pdpp-dashboard-sw.js`;
- manifest `start_url: "/"` and `scope: "/"`.

The missing product layer is route ownership and discoverability.

## Design

### Notifications route

Add `/notifications` under the owner console. The page fetches Web Push config and current owner subscriptions server-side, then renders `WebPushSettings`. The page copy frames the surface as "enable this device" rather than "enable notifications globally" because browser subscriptions are per device/profile.

The route is owner-authenticated through the existing console layout and data access layer. It does not expose any unauthenticated state.

### Discoverability

Add Notifications to:

- the Server navigation group;
- the command palette navigation list;
- the overview page as a small utility block below source attention.

This keeps notifications globally discoverable without making it a source, grant, or sync setting.

### Stale PWA route repair

Keep the clean-route topology: normal owner navigation and generated links must not emit `/dashboard/*`. However, an installed PWA can retain old launch metadata or restore its last route. Add a small `/dashboard` catch-all route that renders a repair page with links to clean routes and a reinstall note. It is not a redirect and is not a legacy content surface.

This is a bounded compatibility surface for installed-client repair, not permission to add new `/dashboard/*` links.

## Alternatives

- Re-add broad redirects from `/dashboard/*` to clean routes. Rejected: the clean-route migration intentionally removed legacy URLs, and broad redirects hide stale-client bugs.
- Put the setup widget back on overview only. Rejected: notification setup is a device-level setting and should be addressable directly.
- Require owners to reinstall the PWA manually with no app-side repair path. Rejected: a stale installed app should not look like the instance is down.

## Acceptance Checks

- `/notifications` renders the Web Push setup component.
- Live nav and command palette include Notifications.
- Generated live owner routes still do not include `/dashboard`.
- `/dashboard` and `/dashboard/*` render a repair/migration page, not raw 404 and not a redirect.
- OpenSpec validates strictly.
- Targeted console tests pass.
