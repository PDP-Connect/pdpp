## Context

Google Maps Timeline has two relevant export paths:

- Google Maps mobile Timeline export. Google documents Android export under Settings > Location > Location services > Timeline > Export Timeline data, and iOS export from Google Maps Settings > Location & Privacy > Export Timeline data.
- Google Takeout archives. Google documents Takeout as an archive download path for Google Account data.

The implementation should therefore collect from owner-provided files. It should not attempt to automate Google Maps web sessions or mobile app state.

## Design

Add a dedicated `google_maps` connector instead of expanding the generic `google_takeout` product surface. The dedicated connector gives owners a clear "Google Maps Timeline" source in connection setup while still allowing the parser to accept legacy Takeout location files for compatibility with existing exports.

The connector emits two normalized streams:

- `timeline_points`: timestamped latitude/longitude observations from raw location records and timeline paths.
- `timeline_segments`: visits, activities, or movement segments when the export provides semantic Timeline entries.

Each record carries `source_format` so downstream users can distinguish legacy raw points from semantic Timeline exports. The connector keeps place names and addresses out of the first tranche; location coordinates and stable place IDs are already sensitive enough, and avoiding free-text place labels reduces accidental overexposure before a real owner export pilot.

## Runtime Posture

- Filesystem required.
- Network not required.
- Browser not required.
- Refresh policy is manual because the owner must export or place a fresh file.
- Public listing remains unproven until a live owner export pilot confirms the exact contemporary Android/iOS JSON shapes.

## Alternatives Considered

- **Browser scrape `maps.google.com/timeline`**: rejected. It is more fragile, more likely to trigger bot/captcha defenses, and misaligned with Google's current device/app export guidance.
- **Only extend `google_takeout`**: rejected for user experience. Owners looking for Maps should not need to infer that Timeline lives under Takeout, and newer mobile Timeline exports are not necessarily full Takeout archives.
- **Emit one raw JSON stream**: rejected. It would be easier, but it would not provide an agent-friendly read surface or stable cursor semantics.

## Acceptance Checks

- `openspec validate add-google-maps-timeline-import --strict`
- Google Maps parser tests cover legacy `Records.json`, Timeline path entries, visit segments, activity segments, bad coordinates, and stable IDs.
- Schema tests prove parser-built records are accepted and out-of-range coordinates are rejected.
- Connector registration smoke includes `google_maps`.
- No connector progress message includes an absolute local file path or raw place/address text.
