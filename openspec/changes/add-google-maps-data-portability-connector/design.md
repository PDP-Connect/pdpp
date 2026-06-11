## Context

The reference now has a Google Maps Timeline import connector for owner-provided files. That connector is useful, but it is not the source the owner asked for when he said "over api like Gmail." It cannot honestly be presented as a live Google Maps account connection.

Research captured in `docs/research/google-maps-data-portability-api-timeline-2026-06-11.md` shows the current split:

- Google Data Portability API supports OAuth and time-based exports for several Maps resource groups.
- The documented Maps scopes include places and contribution/activity resources, but not raw Google Maps Timeline points/segments.
- Google's Timeline help documents mobile/device export for Timeline data.

The SLVP ideal is therefore not "make Takeout prettier" and not "pretend Timeline has an API." It is a two-source model:

- **Google Maps Timeline Import** for Timeline location points/segments from owner-provided files.
- **Google Maps Data Portability** for API-backed Maps resources Google exposes through Data Portability.

## Design

### Source identity

The API-backed connector uses a distinct connector key, for example `google-maps-data-portability`, and a display name such as "Google Maps Data Portability." It is not an alias for `google-maps` / `google_maps`, and it does not emit `timeline_points` or `timeline_segments` unless Google later documents equivalent Data Portability resource groups.

The current `google-maps` source remains "Google Maps Timeline Import." Add source must show these as different options if both are registered.

### Setup modality

The connector is `provider_authorization`:

- deployment-level config supplies the Google OAuth/Data Portability app material;
- owner account authorization happens through the owner-session provider-auth flow;
- provider tokens are sealed per connection;
- connection activation happens only after callback/token exchange and a connection test or first archive inventory succeeds.

The connector must not ask for a Gmail app password, Google password, or any owner bearer token. Gmail app passwords are IMAP mailbox credentials and are unrelated to Data Portability API authorization.

### Runtime model

The runtime does not perform browser automation. It uses the Data Portability API lifecycle:

1. Initiate or schedule an export/archive request for the connector's granted Maps resource groups.
2. Poll archive state until ready, failed, or expired.
3. Download archive URLs within their validity window.
4. Parse supported Maps resource files into manifest-declared streams.
5. Persist state so repeated runs request only the allowed time-based export window when supported.

The connector must preserve archive/export provenance per record: resource group, source file, export job id when available, and capture/export time.

### Streams

The first tranche should model only documented Maps resources. Candidate streams include:

- `starred_places`
- `labeled_places`
- `commute_routes`
- `commute_settings`
- `reviews`
- `photos_videos`
- `questions_answers`
- `my_maps`
- `maps_activity`

Each stream must be backed by documented scopes and sample archive shapes before being advertised as collected. Unsupported or unapproved scopes should remain absent or explicitly coverage-gated, not silently empty.

### Partial consent and account identity

Google Data Portability can return partial-scope consent outcomes. The connection setup and run coverage must expose which requested resource groups are authorized, skipped, unavailable, or failed.

If Google's OAuth/Data Portability flow does not provide a reliable account email/subject to this app, the setup surface must not invent one. It may use a user-supplied owner label or a provider-returned opaque account id, clearly distinguished from verified account identity.

### Scheduling and rate posture

The connector's refresh policy must respect Google's Data Portability cadence and archive limits. It should default to a conservative automatic cadence only after provider docs and live proof show that repeated time-based export is allowed for the selected scopes.

## Alternatives Considered

- **Rename Timeline import to Google Maps and call it done**: rejected. It fails the user's explicit API-backed expectation and hides the manual export burden.
- **Use Google Maps Platform APIs**: rejected. Those APIs serve application map/place features, not owner data portability for the user's saved/contributed Maps data.
- **Scrape Google Maps Timeline in a browser**: rejected for this change. Browser automation remains a polyfill for missing APIs, and Google's current Timeline guidance points to mobile/device export.
- **Merge Data Portability resources into `google_takeout`**: rejected. Data Portability is an account-authorization source with refresh and partial-consent semantics, not a manually downloaded Takeout archive.

## Acceptance Checks

- `openspec validate add-google-maps-data-portability-connector --strict`
- Add a manifest that the shared setup planner classifies as `provider_authorization`, not `manual_or_upload` or `static_secret`.
- Add source, owner-agent, and CLI setup projections show the same deployment-blocked / proof-gated / supported state from the shared setup planner.
- A missing Google provider app configuration blocks setup before owner authorization.
- A successful callback creates distinct connection ids for two authorized Google accounts or labels.
- Provider tokens never appear in console, owner-agent, MCP, REST read, CLI read, audit, or run timeline responses.
- Data Portability archive runs emit documented Maps records, coverage for partially authorized scopes, and no Timeline point/segment claims.
