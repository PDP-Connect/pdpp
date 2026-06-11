# Google Maps Data Portability API vs Timeline Data

Status: captured
Owner: reference implementation owner
Created: 2026-06-11

## Question

Can PDPP offer a Gmail-style API-backed Google Maps connection for Google Maps
Timeline location history, or is the existing owner-provided export/import
connector the only honest path?

## Sources

- Google Data Portability API developer introduction, accessed 2026-06-11:
  https://developers.google.com/data-portability/user-guide/introduction
- Google Data Portability API OAuth configuration, accessed 2026-06-11:
  https://developers.google.com/data-portability/user-guide/configure-oauth
- Google Data Portability API time-based access, accessed 2026-06-11:
  https://developers.google.com/data-portability/user-guide/time-based
- Google Data Portability API OAuth scopes, accessed 2026-06-11:
  https://developers.google.com/data-portability/user-guide/scopes
- Google Data Portability API method guide, accessed 2026-06-11:
  https://developers.google.com/data-portability/user-guide/methods
- Google Data Portability REST reference, accessed 2026-06-11:
  https://developers.google.com/data-portability/reference/rest
- Google Data Portability `portabilityArchive.initiate` reference, accessed
  2026-06-11:
  https://developers.google.com/data-portability/reference/rest/v1/portabilityArchive/initiate
- Google Data Portability `archiveJobs.getPortabilityArchiveState` reference,
  accessed 2026-06-11:
  https://developers.google.com/data-portability/reference/rest/v1/archiveJobs/getPortabilityArchiveState
- Google Data Portability `accessType.check` reference, accessed 2026-06-11:
  https://developers.google.com/data-portability/reference/rest/v1/accessType/check
- Google Data Portability API Maps schema reference, accessed 2026-06-11:
  https://developers.google.com/data-portability/schema-reference/local_actions
- Google Maps Help: Manage your Google Maps Timeline, Android and desktop
  variants, accessed 2026-06-11:
  https://support.google.com/maps/answer/6258979?co=GENIE.Platform%3DAndroid&hl=en
  https://support.google.com/maps/answer/6258979?co=GENIE.Platform%3DDesktop&hl=en

## Findings

Google does expose a Data Portability API with OAuth and time-based exports.
The API supports Maps resource scopes such as starred places, labeled places,
commute routes/settings, vehicle profiles, reviews, photos/videos, Q&A, Maps
activity, and My Maps. The documented flow is OAuth consent, optionally check
access type, initiate archive, poll archive state, then download signed archive
URLs. Google documents the concrete REST endpoints as:

- `POST https://dataportability.googleapis.com/v1/accessType:check`
- `POST https://dataportability.googleapis.com/v1/portabilityArchive:initiate`
- `GET https://dataportability.googleapis.com/v1/archiveJobs/{job}/portabilityArchiveState`

Time-based access can support repeated exports, but Google documents a 24-hour
cadence floor and requires a refresh token for later exports.

This is not the same as Google Maps Timeline location history. The Maps schema
reference enumerates Maps export objects, but it does not document raw Timeline
point or Timeline segment resources equivalent to PDPP's current
`timeline_points` and `timeline_segments` streams.

Google's Timeline help page says Timeline data is saved on signed-in devices,
backup is an encrypted server copy for device restore/import, desktop Timeline
is not available because Timeline comes from the device, and the documented
export path is a mobile export action. That matches an owner-provided artifact
flow, not a Gmail/IMAP-style background API connector.

Data Portability API scopes also carry platform constraints that matter for an
RI deployment: the app must be approved before release, Data Portability scopes
cannot be mixed with non-DPAPI scopes such as userinfo email, and the app must
handle partial scope consent. The OAuth token is opaque; Google explicitly says
the app does not know which Google Account was used from the OAuth flow alone.

## Conclusion

The SLVP ideal for Google Maps splits two products:

- **Google Maps Timeline Import**: owner-provided Timeline export files,
  manual/import refresh posture, no password/app-password, no claim of
  continuous API access. This is the only currently documented path for
  Timeline location points/segments.
- **Google Maps Data Portability**: future provider-authorization connector for
  the Maps resource groups that Google actually exposes via the Data
  Portability API. This can be API-backed and time-based, but it is not a
  substitute for Timeline location history unless Google adds Timeline resource
  groups.

Therefore the current `google_maps` import connector must not be presented in
Add source as "Google Maps connect" or as a Gmail-style live connection. It
should be labeled as an import/manual source, and any API-backed Maps connector
should be modeled as a separate provider-authorization source with deployment
readiness and scope/approval caveats.
