## Why

The reference console has Web Push backend routes and a tested setup component, but no current owner route renders it. Owners cannot find the PWA/browser notification setup path after the clean-route migration.

## What Changes

- Add a first-class owner Notifications surface for per-device browser/PWA notification setup.
- Link Notifications from navigation and command palette so it is discoverable.
- Preserve the clean-route topology. Removed `/dashboard/*` paths are not restored as redirects or repair surfaces.

## Capabilities

Modified:

- `reference-dashboard-notifications`
- `reference-surface-topology`

## Impact

- Affects owner-console UI only.
- Reuses existing `/_ref/web-push/*` routes and the existing `WebPushSettings` client component.
- Does not change push payload privacy, subscription storage, or connector behavior.
