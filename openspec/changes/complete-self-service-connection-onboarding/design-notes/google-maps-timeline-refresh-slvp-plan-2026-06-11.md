# Google Maps Timeline Refresh SLVP Plan

Status: decided
Owner: reference implementation owner
Created: 2026-06-11
Confidence: >95% for the target owner experience, based on current Google
documentation and prior art; <95% for any claim that Google offers a raw
Timeline OAuth/API path.

## Question

What is the SLVP-ideal setup and refresh experience for Google Maps Timeline
data in the reference implementation, given that owners want regular updates
with minimal friction but Google no longer exposes raw Timeline history as a
normal server-side API?

## Inputs

- `docs/research/google-maps-timeline-setup-ux-prior-art-2026-06-11.md`
- `docs/research/google-maps-data-portability-api-timeline-2026-06-11.md`
- `openspec/changes/add-google-maps-timeline-import/`
- `openspec/changes/add-google-maps-data-portability-connector/`
- `openspec/changes/complete-self-service-connection-onboarding/`

## Decision

The SLVP-ideal Google Maps Timeline source is a **phone-first guided refresh
assistant** for owner-supplied Timeline exports. It is not a fake Gmail-style
OAuth connector, and it is not a developer runbook.

The source card should be "Google Maps Timeline" or "Google Maps Timeline
Import" and should lead with the most reliable path:

1. Open the flow on the phone that has Timeline.
2. Follow exact Android/iOS export steps from connector-authored setup metadata.
3. Share or upload the exported Timeline JSON to the personal server.
4. Validate the file immediately.
5. Show detected format, record/segment estimate, dedupe/coverage, and next
   freshness state.
6. Start the import and route to a source status page with an obvious payoff:
   records imported, date range, and "explore timeline" affordance.

Google Takeout is allowed only as an advanced/probe lane. It may become a
best-effort recurring backup lane when the first imported archive proves that
the owner's account still emits current Timeline records. It must fall back to
phone export/share when the archive has no Timeline data, stale Timeline data,
or only encrypted-backup metadata.

Google Data Portability remains a separate provider-authorization source. It
can import documented Google Maps resource groups when deployment-level OAuth
app configuration exists, but it must not be presented as raw Timeline
points/segments unless Google documents that resource group.

## Owner Experience

### First setup

The owner sees one source card, not a taxonomy of setup states. The setup page
answers one question first: "Do you already have the Timeline export file?"

- If yes, the owner drops or selects the file.
- If no, the owner opens platform-specific instructions next to the drop zone.
- If the owner is on desktop, the page offers a QR/deep link to continue on
  the phone.
- If the owner is on Android and the PWA/share target is available, the page
  explains that PDPP can appear in the share sheet after installation.
- If the owner has a large archive, the page offers a server import-folder
  handoff with deployment-safe language, not monorepo commands.

The first validation happens before a long import. The validation result says:

- detected source format, such as phone Timeline export, Semantic Location
  History, legacy `Records.json`, or unsupported archive;
- estimated points, segments, and date range;
- whether the file looks duplicate, incremental, stale, or empty;
- exactly what to do next if the wrong file was supplied.

### Refresh

After the first import, the source detail page becomes the primary refresh
surface. It shows:

- last imported through date;
- last file/import method;
- coverage and freshness state;
- current run state when importing;
- one primary "Refresh from phone" action;
- optional "Try Takeout recurring backup" only when the account has not already
  disproven it.

The refresh action should preserve the same connection/source identity while
recording acquisition provenance per run. A new file is not a new source unless
the owner explicitly creates a separate account/source binding.

### Takeout probe

Takeout is useful when it works, but it is not the default promise.

The setup page may offer "Try a scheduled Takeout backup" behind an advanced
or secondary action. That action should be framed as a probe:

- Google may place exports in Drive/Dropbox/OneDrive/Box or send download links.
- Scheduled exports are every two months for one year, not continuous sync.
- Some accounts no longer include current Timeline records in Takeout.
- PDPP will validate the first archive and either enable recurring import or
  mark the Takeout lane unavailable for this source.

The ideal recurring Takeout lane watches a destination such as Drive once the
owner has authorized that destination. It should not depend on scraping expiring
email links as the normal path.

## Data Model And Provenance

Multiple acquisition methods may populate the same Timeline stream definitions
when they are genuinely the same owner source and format family:

- phone export upload;
- Android PWA/native share target upload;
- server import-folder handoff;
- legacy Takeout location archive import;
- scheduled Takeout archive import, only after validation proves current
  Timeline records exist.

Each run and record batch should carry non-secret provenance such as:

- acquisition method;
- source format;
- original archive/file family;
- detected date range;
- imported-through timestamp;
- duplicate/skipped counts;
- connector instance/source binding identity.

Do not coalesce Google Data Portability API records into the Timeline source
unless an explicit future proof shows they are the same semantic resource. Until
then, Data Portability records are a sibling Google Maps source with its own
streams, coverage, and provider-authorization lifecycle.

## Automation Boundary

PDPP should automate everything after the owner obtains or shares the file:
upload, validation, parse, dedupe, ingest, progress, status, and exploration.

PDPP should not claim to automate the protected device/app export step from the
server. Current public documentation and prior art do not support a durable
server-side raw Timeline export API or a third-party Timeline backup target.

The allowed automation hierarchy is:

1. Connector-authored export instructions and official help links.
2. QR/deep-link phone handoff.
3. Android PWA share target or native mobile helper for receiving the exported
   file.
4. iOS upload / Files share handoff as the reliable baseline.
5. Server import-folder handoff for large archives.
6. Scheduled Takeout probe when applicable.
7. Supervised Android UI automation only as an experimental power-user lane,
   not the default SLVP product contract.

## Manifest And Setup Engine Contract

The Console must remain connector-generic. The Timeline connector should declare
setup guidance in manifest/setup metadata, including:

- setup modality: `manual_or_upload`;
- acquisition methods and platform labels;
- accepted file names/extensions;
- official export/help URLs;
- validation expectations;
- large-file fallback copy;
- whether a method is primary, secondary, advanced, or experimental.

The setup engine then projects the next step. Console, owner-agent REST, CLI,
and future SDK helpers render or serialize the same plan. No source-specific
React branch should be required to add the phone-first Timeline experience.

## Rejected Designs

- **OAuth as the Timeline solution**: rejected. Google Data Portability is real
  OAuth, but current Maps schemas do not document raw Timeline history.
- **Desktop browser scrape of Timeline**: rejected. The prior Timeline web
  surface is degraded/removed for this use, and browser scraping would be less
  honest than the official mobile export.
- **Default unattended Android UI automation**: rejected. It is brittle,
  source-hostile, device-state dependent, and not the right foundation.
- **Developer runbook setup**: rejected. Normal owner UI must not mention a repo
  checkout, `pnpm --dir`, package-internal paths, or internal id substitution.
- **Separate source identity per upload method**: rejected. Acquisition method
  is provenance, not a different source, when the records are the same owner
  Timeline export family.

## Acceptance Bar

Implementation is not complete until a self-host owner can:

- find Google Maps Timeline from Add source;
- understand immediately that this is an import/refresh source, not live OAuth
  sync;
- get exact Android/iOS export guidance without leaving the setup context;
- upload/share a valid export and see validation before import;
- get a useful, non-generic error for wrong/stale/empty files;
- see date-range/count/freshness after import;
- refresh the same connection with another file;
- optionally probe Takeout without being promised continuous sync;
- use CLI/owner-agent setup plan outputs that match the Console;
- complete all of the above without PDPP developer vocabulary or connector UI
  hardcoding.

Owner live proof with a contemporary Timeline export remains the final
confidence gate for exact parser coverage, but it does not change the setup UX
decision unless Google exposes a new official Timeline API.
