## Why

WHOOP owners can inspect their health and activity history in WHOOP's web
application, but the polyfill connector package has no owner-controlled way to
collect that data into a Personal Server. Requiring a developer application or
a delayed export would make the owner's access depend on a provider-specific
integration path instead of the authenticated account they already control.

## What Changes

- Add a WHOOP browser connector that reuses an isolated persistent browser
  profile, asks the owner to sign in when needed, and never receives or stores
  the owner's WHOOP username or password.
- Collect directly observed profile, body, cycle, recovery, sleep, and workout
  records from WHOOP's authenticated web application endpoints.
- Treat authentication loss, upstream response drift, malformed data, and
  incomplete pagination as failures rather than successful empty collection.
- Add synthetic fixtures and hermetic behavioral tests. A live owner-account
  run remains the final acceptance step before public listing.

## Capabilities

- Added: `polyfill-runtime` (WHOOP-connector-scoped requirements only)

## Impact

- `packages/polyfill-connectors/connectors/whoop/`: connector, parsers,
  schemas, fixtures, and focused tests.
- `packages/polyfill-connectors/manifests/whoop.json`: browser runtime,
  collection streams, schemas, and manual-auth presentation.
- Existing connector registries and inventory documentation only where needed
  to run WHOOP through the package orchestrator.
- No PDPP Core, generic browser runtime, Desktop application, developer OAuth,
  provider credential storage, publishing, or live/realtime push change.
