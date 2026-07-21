## Why

Owners expect "Google Maps" in Add source to mean a live Google-account authorization flow when Google exposes one. The current Google Maps work only imports owner-provided Timeline files, and presenting that as a Gmail-like connection would be dishonest.

Google's Data Portability API does expose some Maps resource groups through OAuth and time-based export, but not documented Timeline point/segment data. The reference needs a separate provider-authorization connector for those API-backed Maps resources.

## What Changes

- Add a separate Google Maps Data Portability connector design for Google-exposed Maps resources such as starred/labeled places, pinned trips/settings, reviews, photos/videos, Q&A, Maps activity, and My Maps.
- Keep Google Maps Timeline as a file/import source unless Google documents Timeline point/segment export through Data Portability.
- Require provider-authorization setup, deployment-level Google OAuth/Data Portability app readiness, encrypted per-connection token storage, archive initiate/poll/download handling, partial-scope reporting, and time-based refresh posture.
- Require Add source / owner-agent / CLI setup answers to come from manifests and the shared setup planner, not source-specific UI branches.

## Capabilities

Modified:
- `polyfill-runtime`
- `reference-connector-instances`
- `reference-implementation-architecture`

Added:
- None.

Removed:
- None.

## Impact

- Creates the implementation plan for an API-backed Google Maps Data Portability source.
- Does not change PDPP Core semantics.
- Does not make the Timeline import connector API-backed.
- Does not mark the API-backed source supported until the real Google exchanger, archive runtime, and owner setup proof are implemented and verified.
