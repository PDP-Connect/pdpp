# WhatsApp Media Sync Deferred Path

Status: decided-defer
Owner: RI owner
Created: 2026-06-13
Updated: 2026-06-13
Related: openspec/changes/define-collection-acquisition-coverage

## Question

Should the first WhatsApp owner-artifact tranche import media files together
with chat text exports?

## Context

WhatsApp's official chat export flow is per-chat and can produce a text export
that references media, but the text artifact does not reliably provide the
media folder itself. Prior art favors honest coverage receipts over pretending
that a partial export is complete.

## Stakes

If media import is hidden inside the text-export path, owners can see a green
import while attachments are absent. If media sync is modeled separately, the
text import can be useful immediately while the missing-media fact remains
visible and actionable.

## Current Leaning

Defer media import as a separate `device_sync` acquisition path. The first
WhatsApp tranche accepts `.txt` chat exports as `owner_artifact`, records
referenced-media counts in the acquisition receipt, and warns that media files
are not included.

## Promotion Trigger

Promote when implementing a local/mobile/device helper that can enumerate a
WhatsApp media folder, match files to messages with explicit identity rules,
and preserve media coverage as a sibling acquisition batch.

## Decision Log

- 2026-06-13: Deferred media sync out of the owner-artifact text-export pilot.
  The manifest exposes it as an advanced future path, not a current import
  promise.
