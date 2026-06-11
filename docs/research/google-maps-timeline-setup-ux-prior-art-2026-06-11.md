# Google Maps Timeline Setup UX Prior Art

Status: captured
Owner: reference implementation owner
Created: 2026-06-11

## Question

What should the reference implementation learn from current Google Maps
Timeline import tools and Google Data Portability documentation when designing
the owner setup flow?

## Sources

- Google Maps Help, "Manage your Google Maps Timeline", accessed 2026-06-11:
  https://support.google.com/maps/answer/6258979?co=GENIE.Platform%3DAndroid&hl=en
- Google Account Help, "How to download your Google data", accessed
  2026-06-11:
  https://support.google.com/accounts/answer/3024190
- Chrome Developers, "Receiving shared data with the Web Share Target API",
  accessed 2026-06-11:
  https://developer.chrome.com/docs/capabilities/web-apis/web-share-target
- MDN, "share_target - Web app manifest", accessed 2026-06-11:
  https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target
- Android Developers, "Receive simple data from other apps", accessed
  2026-06-11:
  https://developer.android.com/training/sharing/receive
- Google Data Portability API product page, accessed 2026-06-11:
  https://developers.google.com/data-portability
- Google Data Portability API developer introduction, accessed 2026-06-11:
  https://developers.google.com/data-portability/user-guide/introduction
- Google Data Portability API OAuth configuration, accessed 2026-06-11:
  https://developers.google.com/data-portability/user-guide/configure-oauth
- Google Data Portability API Maps schema reference, accessed 2026-06-11:
  https://developers.google.com/data-portability/schema-reference/maps
- Google OAuth 2.0 overview, accessed 2026-06-11:
  https://developers.google.com/identity/protocols/oauth2
- Google OAuth brand verification, accessed 2026-06-11:
  https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification
- Dawarich home page, accessed 2026-06-11:
  https://dawarich.app/
- Dawarich vs Google Timeline comparison, accessed 2026-06-11:
  https://dawarich.app/docs/comparisons/vs-google-timeline/
- Dawarich "Best Google Timeline Alternatives in 2026", accessed 2026-06-11:
  https://dawarich.app/blog/best-google-timeline-alternatives-in-2026-ranked/
- Timelinize Google Location History data-source docs, accessed 2026-06-11:
  https://timelinize.com/docs/data-sources/google-location-history
- Timelinize importing data docs, accessed 2026-06-11:
  https://timelinize.com/docs/importing-data
- HPI README, accessed 2026-06-11:
  https://github.com/karlicoss/HPI
- google_takeout_parser README, accessed 2026-06-11:
  https://github.com/purarue/google_takeout_parser
- Dawarich migration guide, accessed 2026-06-11:
  https://dawarich.app/blog/migrating-from-google-location-history-to-dawarich/
- Dawarich Google Timeline visualizer, accessed 2026-06-11:
  https://dawarich.app/tools/timeline-visualizer/
- Dawarich Google Timeline converter, accessed 2026-06-11:
  https://dawarich.app/tools/google-timeline-converter/
- Google Maps Timeline Viewer, accessed 2026-06-11:
  https://github.com/kurupted/google-maps-timeline-viewer
- GoogleTimelineMapper, accessed 2026-06-11:
  https://github.com/ryangriggs/GoogleTimelineMapper
- MileageWise Google Timeline Trip Import docs, accessed 2026-06-11:
  https://www.mileagewise.com/help/importing-trips-from-google-maps-timeline-data/
- OwnTracks home page, accessed 2026-06-11:
  https://owntracks.org/
- MyGeodata TimelineJSON converter, accessed 2026-06-11:
  https://mygeodata.cloud/converter/timelinejson-to-gpx
- Arc App support thread on Google Timeline import, accessed 2026-06-11:
  https://support.bigpaua.com/t/google-timeline-import/920
- gog Google Workspace CLI docs, accessed 2026-06-11:
  https://gogcli.sh/
- Dawarich discussion, "Unable to export timeline data after recent timeline
  changes by google", accessed 2026-06-11:
  https://github.com/Freika/dawarich/discussions/598
- Stadly TimelineExtractor, accessed 2026-06-11:
  https://github.com/Stadly/TimelineExtractor
- Reddit, "Timeline location database file location on Android?", accessed
  2026-06-11:
  https://www.reddit.com/r/GoogleMaps/comments/1lprxuc/timeline_location_database_file_location_on/
- Android Enthusiasts, "How can I export my Location History now that this data
  is only stored locally?", accessed 2026-06-11:
  https://android.stackexchange.com/questions/257663/how-can-i-export-my-location-history-now-that-this-data-is-only-stored-locally-o

## Findings

Google's current official Timeline export path is not OAuth. Google documents
exporting Timeline data from Android settings under Location services >
Timeline > Export Timeline data. It also documents Timeline backup/import
between devices, but not a server-side API that returns raw Timeline points and
segments.

Google Data Portability is OAuth-backed, but it is a different product surface.
Google's flow is OAuth consent, initiate a portability archive, poll archive
state, then download signed archive URLs. It can support one-time or time-based
access, but the Maps schema lists Maps resource groups such as commute routes,
settings, reviews, photos/videos, questions/answers, and pinned/aliased places.
It does not document the raw Timeline point/segment data that the
`google_maps` import connector emits.

Timelinize treats Google Location History as a file import and gives concrete
human steps for exporting from Google Maps on the device. Timelinize's general
import model is a clear "+ Import" flow: choose/import the file, with the
important caveat that large imports copy data into the timeline folder.

Dawarich also treats Google Timeline as an import surface. Its public visualizer
is especially strong UX prior art: it has a drop zone, a "Don't have your data
yet?" affordance, explicit supported formats, and reassurance that processing
stays local. The migration guide distinguishes Semantic Location History files,
Records.json, and phone exports, and gives different paths for heavy files.

HPI and google_takeout_parser are developer-oriented prior art. They are useful
for parsing, caching, and unifying Takeout data, but they are not consumer-grade
setup UX. Their product lesson for PDPP is not copy; it is the construction:
hide parsing and locating details behind a stable data interface once the owner
has supplied the export.

The popular product set falls into four buckets:

1. **Google Timeline import/viewer products**: Dawarich, Timelinize, Dawarich
   visualizer/converter, Google Maps Timeline Viewer, GoogleTimelineMapper,
   MileageWise, and generic converters such as MyGeodata. These assume a file
   exists, but the best ones pair the upload target with clear export steps and
   accepted formats.
2. **Future continuous tracking products**: Dawarich mobile apps, OwnTracks,
   Overland, GPSLogger, and Traccar. These do not solve historical Google
   Timeline import by OAuth; they solve "collect from now on" through a mobile
   app or device protocol. Their setup UX lesson is QR/config handoff to a
   device, not archive import.
3. **Developer data libraries/CLIs**: HPI, google_takeout_parser, and gog.
   HPI/google_takeout_parser are useful for parsing/caching exported data.
   gog's relevance is the opposite path: where Google has real APIs, a good
   setup flow uses OAuth, stable JSON output, generated command docs, and
   multi-account state. gog does not appear to expose Google Maps Timeline
   import; it is not evidence that Timeline can be OAuth-connected.
4. **Adjacent travel/activity apps**: Arc, Life360, Strava, Komoot, Polarsteps,
   and similar products. Some are recommended as replacements, but they either
   do not import Google Timeline, only track deliberate activities, or keep the
   data in an app-specific silo. They are weak direct prior art for PDPP import
   UX.

Best UX patterns observed:

- **One obvious import affordance**: a drop zone or "Import" action, not a
  connector-status taxonomy first.
- **"Don't have your data yet?" right next to the drop zone**: export
  instructions sit where the failed user would look, not in a separate docs
  page.
- **Platform-specific paths**: Android and iOS instructions differ. Strong
  docs name the exact settings path instead of generic "download from Google".
- **Format empathy**: list supported file names and formats, then auto-detect
  after upload. Dawarich explicitly supports Records.json, Semantic Location
  History, and phone exports; Google Maps Timeline Viewer distinguishes
  on-device export from old Takeout.
- **Immediate local validation**: before a long import, detect format, show
  "this looks like phone export / Semantic Location History / Records.json",
  estimate counts, and fail with a concrete next action if the wrong file was
  supplied.
- **Privacy reassurance at the action point**: Dawarich's free tools emphasize
  browser-local processing. PDPP cannot always process only in browser if the
  goal is server ingestion, but it can be explicit: "This file will be uploaded
  to your personal server and parsed into these streams."
- **Large-file off-ramp**: Dawarich's guide avoids sending huge Records.json
  through a normal web upload path. PDPP should support a server import-folder
  handoff with operator-safe copy, not monorepo commands.
- **Post-import payoff**: the best tools show a map/timeline/stat immediately
  after import. PDPP should route to source status plus "Explore records" /
  "View timeline points" rather than a generic run page only.
- **Future tracking separation**: Dawarich separates importing history from
  starting fresh with mobile apps / OwnTracks. PDPP should likewise distinguish
  "import your existing Google Timeline export" from "set up continuous
  location capture from a device".

## Why PDPP Cannot Mint The Timeline File

"Mint" is the wrong verb for Google Timeline exports. The Timeline export file
is produced by Google Maps or Android/iOS from the user's device-local Timeline
store. Current Google help says Timeline data is on signed-in devices, backup is
encrypted, and export is a device/app action. PDPP cannot ask Google's server
for that raw Timeline file because Google does not document a server-side
Timeline export API.

Google Data Portability is the closest OAuth mechanism, but it is not a
Timeline-file minting API. It requires a Google-verified OAuth application,
user consent, initiating archive jobs, polling, and downloading signed URLs; its
documented Maps schema does not include raw Timeline points or Timeline
segments. Using it for Timeline would overclaim and likely return different
data.

Could PDPP automate file creation anyway? Only by changing the runtime class:

- A mobile companion app or local Android automation could guide/share the
  exported file into PDPP after the user creates it. That can reduce friction,
  but the export still originates on the user's device.
- Browser automation is a poor fit because Timeline web access has been removed
  or degraded, and Timeline data is not reliably available from desktop
  Takeout after the on-device transition.
- Device backups are encrypted and account/device-bound; PDPP should not try to
  bypass that boundary.

The right delight target is therefore "guided acquisition + immediate
validation", not pretending PDPP can generate the Timeline archive itself.

The same principle applies to static provider tokens such as GitHub PATs, but
for a different reason: providers intentionally require user-controlled
authorization/credential creation. PDPP can open the exact settings page,
specify scopes, validate the token immediately, and echo the account identity;
it should not try to create a PAT behind the user's back. For providers with
real OAuth support, the SLVP ideal is to replace PAT setup with provider
authorization instead.

## Mobile Helper / Share Target Feasibility

PDPP can improve the Timeline path without a full native app, but the quality
differs by platform.

On Android, an installed PWA can register as a system share target through the
Web Share Target manifest member, and native Android apps can receive files via
standard sharing intents. This supports an owner flow such as:

1. Owner opens the Google/Android Timeline export path.
2. Owner chooses a storage/share destination.
3. The PDPP installed web app or native helper appears as a share target.
4. PDPP receives the JSON file, validates it, uploads it to the personal
   server, and starts the import.

This is a local-collector-like pattern: the helper is a device-side acquisition
adapter, while the server keeps the same `manual_or_upload` ingestion contract.
It does not make Timeline server-side OAuth-backed.

On iOS, ordinary web upload is the reliable baseline. A native app or Shortcut
can provide a better share-sheet/deep-link experience, but current web-platform
share-target support is not strong enough to assume a cross-browser PWA can
receive arbitrary Timeline export files from the iOS share sheet. The SLVP
architecture should therefore model "mobile acquisition helper" as an optional
runtime binding with capability detection:

- `web_upload`: works everywhere, least delightful.
- `android_pwa_share_target`: good low-friction Android path.
- `native_mobile_helper`: best cross-platform path if PDPP later ships a mobile
  app.
- `ios_shortcut`: possible owner-power-user bridge, but not the default product
  path until proven.

The setup planner should project these as acquisition options for the same
Timeline import connector, not as separate source identities. The source
identity remains "Google Maps Timeline Import"; the acquisition method is
upload, Android share target, native helper, or server import folder.

## Automation Boundary

The human steps fall into three categories:

- **Automatable by PDPP today**: render exact platform instructions, deep-link
  where the OS/source permits, accept upload/share, validate format, estimate
  records, start the run, and show import payoff.
- **Automatable with a device helper**: register a share target, receive the
  exported file from the OS share sheet, keep device enrollment state, and
  upload to the personal server without asking for monorepo commands.
- **Not honestly automatable from the server**: opening the user's Android
  Settings/Google Maps app, tapping through the export flow, selecting a local
  save/share target, or extracting encrypted device backup contents. Those are
  deliberately user/device-mediated OS and Google app actions.

Trying to automate the final category would require brittle UI automation on
the user's phone or an unsupported attempt to access encrypted/private Google
Maps state. That is not SLVP-ideal. The better product move is to reduce the
human action to the smallest guided gesture: "Open export instructions on your
phone -> export/share to PDPP -> PDPP validates and imports."

## Scheduled Takeout Lane

Google Takeout is a separate, partially automatable historical-export lane.
Google documents:

- delivery by emailed download link;
- delivery into Google Drive, Dropbox, OneDrive, or Box;
- scheduled exports every two months for one year, with the first archive
  created immediately;
- archive expiry and download limits;
- URL parameters that can preselect products, cloud destination, and
  `frequency=2_months`.

This means a good PDPP owner flow can be:

1. Open a preconfigured Takeout URL for the Timeline product, Drive delivery,
   and scheduled export frequency when the account still offers Timeline in
   Takeout.
2. Use a supervised browser assistant to complete the remaining Google UI
   choices and account confirmation.
3. Watch the destination, preferably Drive, for new Takeout archives.
4. Import matching Timeline files, dedupe against prior imports, and show
   coverage/freshness.
5. Warn that scheduled Takeout is only every two months, expires after one year,
   and may not include device-local Timeline data.

It does not have to go only to email. Google sends an email notification for
archive completion, but the archive can be placed in cloud storage. For PDPP,
Drive delivery is the cleanest automation target because a Drive connector or
provider-auth file picker can ingest without scraping an emailed expiring
download link. The email link path is still usable as a fallback: Gmail can
detect the notification, but download may require an active Google session,
password re-entry, or 2FA, and the archive expires.

Scheduled Takeout should therefore be offered as "best-effort recurring
backups" rather than the sole Google Timeline sync mechanism. If a probe import
finds no Timeline records or stops advancing after the device-local migration,
the UI should fall back to the phone export/share assistant.

## Unofficial Workarounds Observed

The unofficial ecosystem has solved adjacent problems, not the backup-target
problem:

- Export-file viewers and converters are common. Examples include Dawarich,
  Google Maps Timeline Viewer, GoogleTimelineMapper, Mappit, and small gists
  that parse phone exports or legacy Takeout.
- Older scripts such as TimelineExtractor and KML range-download gists relied
  on the old web/cloud Timeline behavior. They are useful historical prior art,
  but they are not evidence of a current device-local Timeline backup API.
- Community threads after the device-local migration converge on the same
  workaround: export from Android/iOS device settings or Google Maps and parse
  the resulting JSON. Some Takeout exports now contain only encrypted-backup
  metadata such as `Encrypted Backups.txt`, `Settings.json`, and
  `Tombstones.csv`.
- Users are actively looking for the local database / encrypted backup format,
  but the public threads and tools I found do not provide a repeatable way to
  decrypt Google Timeline backups or register a third-party backup target.

Therefore, "someone figured it out" currently means "someone can parse exports"
or "someone used old web endpoints before the migration", not "someone can
silently pull current Google Timeline backups into a third-party service."

## OAuth Setup Automation Boundary

There are two different "OAuth setup" steps:

1. **Owner authorization for a configured provider app.** PDPP can and should
   automate almost all of this: show "Connect Google", redirect to Google,
   receive the callback, exchange the code, seal the refresh token, probe the
   connection, echo the account/identity evidence Google actually returns, and
   start the first run. The owner still has to choose an account and consent
   because Google's OAuth flow is explicitly user-mediated for private data.
2. **Operator registration of the Google OAuth/Data Portability app.** PDPP
   cannot honestly make this vanish for a self-hosted reference instance. Google
   requires OAuth client credentials from the Google API Console, a consent
   screen/brand configuration for external users, authorized domains, and
   verification in the relevant cases. PDPP can provide a generated checklist,
   validate the three env/config values, and eventually support a `gcloud` /
   Terraform helper for operators who want infrastructure-as-code, but the app
   identity, domain ownership, and Google review remain operator/provider
   steps.

For Google Data Portability specifically, OAuth setup still does not solve raw
Timeline history. It can only authorize the Data Portability API resources that
Google documents. Therefore "automate OAuth setup" is a good goal for the
`google_maps_data_portability` connector, but it does not replace the
Timeline-export import path.

Browser automation can assist the operator-registration step, but it should not
be the default durable contract. Google Cloud Console setup is a privileged
operator action with account login, 2FA/session state, project selection,
organization policies, API enablement, domain ownership, consent-screen
branding, external/testing audience choices, possible verification, and terms
acceptance. Those are all click/type operations, so a supervised Playwright
assistant can reduce toil for one operator. They are not stable provider APIs,
and some steps intentionally require owner judgment or Google review.

The SLVP hierarchy should therefore be:

1. Prefer official provider APIs / infrastructure-as-code when available.
2. Generate exact operator instructions, deep links, and copyable values.
3. Validate the resulting client id/secret/redirect URI before any owner tries
   to connect an account.
4. Optionally offer a supervised browser-assistant lane that opens Google Cloud
   Console and pre-fills what it can, but pauses at sign-in, consent,
   verification, terms, and any provider UI drift.

## Conclusion

The SLVP-ideal owner experience for Timeline is a guided import wizard, not a
fake OAuth flow:

- The source card should say "Google Maps Timeline Import" and should not imply
  background account sync.
- The first screen should answer "Do I have the file?" with one visible upload
  drop zone and one "show me how to export it" branch.
- The export branch should be generated from manifest metadata but can support
  platform-specific steps supplied by the connector manifest, for example
  Android and iOS instructions, official help links, and accepted file names.
- After upload, PDPP should validate the file shape immediately, show the
  detected format and estimated record/segment counts, then start the import.
- For large files, the UI should explicitly support a server-side import-folder
  path and explain exactly where to put the file without exposing repository or
  developer checkout assumptions.
- The API-backed "Google Maps Data Portability" connector should remain
  separate and should explain that it imports documented Data Portability Maps
  resources, not Timeline points/segments.
- For ongoing location data, PDPP should plan a separate mobile/local collector
  setup path that can be QR/deep-link driven and manifest-declared; do not make
  the Timeline import connector carry continuous tracking semantics.

The delightful path is not to hide Google's awkwardness. It is to make every
external step obvious, one-at-a-time, and verifiable, with no PDPP developer
language and no source-specific UI hardcoded outside connector-declared setup
metadata.
