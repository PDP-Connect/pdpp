## Context

Research in `docs/research/pwa-web-push-notification-setup-prior-art-2026-07-05.md` establishes the product boundary:

- notification permission must be owner-initiated;
- PWA install and Web Push subscription are separate states;
- Web Push subscription is per browser profile/device;
- setup belongs in a settings-style surface, not an incidental dashboard widget.

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

## Alternatives

- Re-add broad redirects from `/dashboard/*` to clean routes. Rejected: the clean-route migration intentionally removed legacy URLs, and broad redirects hide stale-client bugs.
- Put the setup widget back on overview only. Rejected: notification setup is a device-level setting and should be addressable directly.
- Add a bounded `/dashboard/*` repair page for stale installed PWA launches. Rejected: it preserves a removed route family and hides stale-client bugs. The manifest starts at `/`; stale installed-client state is a browser/device cleanup issue, not a reason to keep legacy owner routes alive.

## Acceptance Checks

- `/notifications` renders the Web Push setup component.
- Live nav and command palette include Notifications.
- Generated live owner routes still do not include `/dashboard`.
- `/dashboard` and `/dashboard/*` are not owner-console compatibility routes.
- OpenSpec validates strictly.
- Targeted console tests pass.
