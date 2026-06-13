# Acquisition/Coverage Profile SLVP Evaluation

Date: 2026-06-13
Status: owner synthesis
Related:
- `docs/research/google-maps-timeline-setup-ux-prior-art-2026-06-11.md`
- `docs/research/google-maps-data-portability-api-timeline-2026-06-11.md`
- `docs/research/whatsapp-connector-prior-art-2026-06-12.md`
- `tmp/workstreams/ri-acquisition-profile-prior-art-v1-report.md`

## Question

Is the proposed generalized acquisition/coverage model the SLVP-ideal direction
for sources such as Google Maps Timeline, WhatsApp exports/media, Apple Health
exports, and future irregular owner-provided data sources?

SLVP means Stripe, Linear, Vercel, Plaid as the literal quality bar. It is not a
backronym. The evaluation also applies the owner's stated values: user empathy,
honest protocol boundaries, low incidental complexity, and Rich Hickey-style
essential complexity.

## Short Verdict

Yes, with one correction: the SLVP-ideal direction is a small
Collection Profile acquisition/coverage model, but the vocabulary should be
kept smaller than the worker's first pass.

The essential model is:

- a source connection can receive data through one or more acquisition methods;
- each upload/sync produces an acquisition batch with provenance and coverage;
- coverage is shown as a first-class user-facing fact;
- repeated, partial, stale, overlapping, and media-incomplete inputs are normal;
- PDPP Core remains unchanged.

I am >95% confident in that design center. I am not >95% confident that the exact
field names in the worker report should be accepted unchanged.

## Sources Checked

- Immich mobile backup: selected mobile albums are backed up to the server.
  Source: https://docs.immich.app/features/mobile-backup/ (accessed 2026-06-13)
- Immich external libraries: files already on disk are scanned into the main
  timeline and must be rescanned after external changes. Source:
  https://docs.immich.app/features/libraries/ (accessed 2026-06-13)
- Timelinize Google Location History: user exports Timeline data on the phone and
  shares/saves the file. Source:
  https://timelinize.com/docs/data-sources/google-location-history (accessed
  2026-06-13)
- Dawarich imports: supports Google Takeout, OwnTracks, GPX, CSV, and says
  duplicate points are avoided by coordinates and timestamp. Sources:
  https://dawarich.app/docs/getting-started/import-existing-data/ and
  https://dawarich.app/docs/features/imports/ (accessed 2026-06-13)
- Plaid update mode: recurring connections need a repair/update flow when the
  item enters a login/expiration/disconnect state. Source:
  https://plaid.com/docs/link/update-mode/ (accessed 2026-06-13)
- Plaid item status: status separates last successful update from last failed
  update. Source: https://plaid.com/docs/api/items/ (accessed 2026-06-13)
- Linear importers: import is an explicit admin flow with source-specific import
  steps and mapping. Source: https://linear.app/docs/import-issues (accessed
  2026-06-13)
- Stripe Tax imports: exported external data is uploaded as CSV, has limited
  scope/visibility, and can be used for ongoing monitoring. Source:
  https://docs.stripe.com/tax/imports (accessed 2026-06-13)
- WhatsApp export chat: official export is per-chat and offers include/without
  media. Source: https://faq.whatsapp.com/1180414079177245 (accessed
  2026-06-13)
- WhatsApp account information report: does not include personal messages.
  Source: https://faq.whatsapp.com/526463418847093 (accessed 2026-06-13)
- Google Maps Timeline: current user-facing Timeline management is device/app
  oriented, including backup import inside Maps. Source:
  https://support.google.com/maps/answer/6258979 (accessed 2026-06-13)

## What Prior Art Confirms

### Different acquisition channels need distinct provenance

Immich is the strongest example. Mobile backup and external libraries both
produce photos in one timeline, but their identity anchors and operational
semantics differ: app/device upload versus filesystem scan. This supports a
generic acquisition model where different acquisition methods can populate
related streams without being treated as the same evidence.

For PDPP, WhatsApp chat export and WhatsApp media folder sync should therefore
be complementary acquisition paths, not one fake "WhatsApp sync" state.

### Import/re-import is a normal product flow, not an error path

Dawarich and Timelinize both normalize owner-provided export files as first-class
inputs. Dawarich explicitly avoids duplicating points when the same file or
client point is ingested again. Stripe and Linear both treat imports as explicit
flows with source-specific guidance, mapping/validation, and scope caveats.

For PDPP, a duplicate WhatsApp export or older Timeline export should produce an
import receipt, not a scary failure.

### Coverage/freshness has to be visible and mechanism-specific

Plaid separates last success, last failure, and repair/update mode for live
provider connections. Manual exports need the analogous but different language:
"data covers up to X" and "re-export to refresh," not "connected" or "sync
failed."

This is the user-empathy core. The product should not make users infer whether a
source is complete, partial, stale, or waiting on them.

### Official WhatsApp and Google Timeline paths rule out fake OAuth/API

WhatsApp's official account report excludes personal messages, and the official
chat export is per-chat. Google Timeline is now device/app oriented, and
Timelinize's instructions match a phone export/share flow. These sources do not
support a Gmail-like live OAuth connector for the data we actually want.

The SLVP ideal cannot be "pretend it is API sync." That would be lower empathy
and worse protocol honesty.

## Critical Corrections To The Worker Recommendation

### Keep the acquisition method enum smaller

The worker report named `provider_api`, `owner_export_upload`, `device_sync`,
and `assisted_manual`, then said `assisted_manual` is not really a separate
method. I agree with the conclusion, not the presentation.

Normative vocabulary should likely be:

- `provider_api`
- `owner_artifact`
- `device_sync`
- `device_backup`
- `browser_polyfill` or `session_polyfill` only if we need to classify
  browser-automation provenance explicitly

Human-triggered, scheduled, watched-folder, share-target, and one-shot upload are
trigger/setup postures, not acquisition methods. Keeping them orthogonal avoids
switch statements and UI branches that multiply unnecessarily.

### Do not make `ingest_record` the normative noun too early

The durable concept is an acquisition batch. The reference may store it as an
`ingest_record`, `collection_batch`, or audit/event row. The Collection Profile
should define the required facts and invariants before blessing a storage-shaped
noun.

Recommended normative noun: `acquisition_batch`.

### Cross-method identity should be explicit, not automatic

Prior art does not support confident automatic merging across acquisition
methods. Immich keeps mobile backup and external library semantics distinct.
Dawarich dedupes by coordinate/timestamp but does not solve near-duplicate
multi-device overlap. Timelinize is closer to a rich merge model but still
requires source-specific identity rules.

PDPP should allow one logical source to have multiple acquisition batches, but
should not automatically assert that media from a device folder belongs to a
specific WhatsApp message unless the evidence supports it.

## Proposed Minimal Model

### Essential nouns

- `connection`: owner-facing configured source, already present.
- `acquisition_method`: how this batch was obtained.
- `acquisition_batch`: one upload, sync pass, backup import, or provider API
  window with provenance and coverage.
- `coverage_claim`: what this batch claims to cover, with confidence.
- `coverage_gap`: expected or observed absence, such as missing media, stale
  range, unsupported subformat, or partial export.

### Essential fields

Collection Profile-level facts should include:

- acquisition method;
- source format and parser version;
- source artifact/content hash when an artifact exists;
- earliest/latest source event timestamps;
- counts parsed, accepted, duplicate, skipped, and failed;
- declared media count and attached media count where applicable;
- warnings/gaps with advisory/error severity;
- whether another owner action is required to refresh.

Reference-only mechanics should include:

- exact storage table names;
- upload IDs;
- file paths;
- raw artifact retention policy;
- background job implementation;
- pre-commit preview implementation;
- UI component layout.

## UX Standard

The user should experience this as a coverage assistant:

1. "Add one export to start."
2. "We found N records, covering date A to date B."
3. "M records are already known and will be skipped."
4. "K media files were referenced but not included."
5. "Import now."
6. "Imported. Your data now covers up to date B. Add another export anytime."

The user should not see:

- "connected" for an inert export;
- "sync failed" for an export that is simply stale;
- developer instructions;
- connector-specific React branches;
- a green success state that hides missing media or partial coverage.

## Rejected Alternatives

### One generic `file_import` primitive

Rejected. It hides important differences between owner-provided artifacts,
device media sync, and device backup extraction. That would reduce the apparent
model size while increasing incidental complexity inside each connector.

### A large workflow engine

Rejected. The essential complexity is acquisition provenance and coverage, not a
general-purpose workflow system. The reference can implement upload, validation,
background parse, and receipt using existing run/status primitives.

### Source-specific setup pages

Rejected. Connector manifests should provide instructions, file types, validator
identity, and warnings. The RI should provide one shared upload/share/coverage
experience.

### Automatic "complete source" claims

Rejected. WhatsApp and Timeline cannot prove completeness from partial exports.
The honest claim is observed coverage plus gaps.

## Confidence

Confidence is >95% for:

- treating this as Collection Profile / RI work, not PDPP Core;
- defining acquisition batches and coverage claims as durable concepts;
- making partial/repeated/out-of-order uploads normal and idempotent;
- using one manifest-driven upload/share/validation/receipt substrate for
  Timeline, WhatsApp, Apple Health, and similar sources;
- avoiding fake OAuth/live-sync affordances for sources that do not provide the
  desired data that way.

Confidence is below 95% for:

- final enum names;
- whether `device_backup` is separate from `device_sync` in the first tranche;
- raw artifact retention defaults;
- whether parser-upgrade reprocessing belongs in the first implementation slice.

## Recommended Path

1. Draft an OpenSpec change for Collection Profile acquisition/coverage
   semantics before further implementation: likely
   `define-collection-acquisition-coverage`.
2. Keep the first tranche narrow: acquisition batch facts, idempotent upload,
   validation preview, coverage receipt, and advisory stale/missing-media states.
3. Implement through the existing self-service/manual-upload substrate, not as
   WhatsApp/Timeline-specific UI.
4. Defer cross-method auto-merge, backup extraction, parser-upgrade reprocess,
   and watched-folder automation until at least two owner-artifact connectors
   prove the primitive.
