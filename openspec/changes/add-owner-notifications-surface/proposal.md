## Why

The reference console has Web Push backend routes and a tested setup component, but no current owner route renders it. Owners cannot find the PWA/browser notification setup path, and stale installed PWAs can open removed `/dashboard/*` routes as raw 404s after the clean-route migration.

## What Changes

- Add a first-class owner Notifications surface for per-device browser/PWA notification setup.
- Link Notifications from navigation and command palette so it is discoverable.
- Preserve the clean-route topology while giving stale installed PWA launches a bounded repair page instead of a raw 404.

## Capabilities

Modified:

- `reference-dashboard-notifications`
- `reference-surface-topology`

## Impact

- Affects owner-console UI only.
- Reuses existing `/_ref/web-push/*` routes and the existing `WebPushSettings` client component.
- Does not change push payload privacy, subscription storage, or connector behavior.
