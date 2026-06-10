# Google Drive Connector Parity

Status: captured
Owner: reference implementation owner
Created: 2026-05-23
Updated: 2026-06-04
Related: openspec/changes/archive/2026-05-29-canonicalize-public-read-contract, design-notes/connection-first-collection-identity-2026-05-18.md, design-notes/source-authority-vs-schema-identity-2026-04-30.md, design-notes/full-context-refresh.md

## Question

Should the reference implementation ship a first-party Google Drive
connector that reads files via the Drive API, in addition to the existing
Google Takeout import path? If so, how does it cohabit with Takeout
without confusing owners about scope, coverage, freshness, or grant
semantics?

## Context

Today, Drive-ish data reaches the reference implementation through
Google Takeout exports. Takeout is bulk, owner-driven, and lossy on
metadata that the live Drive API exposes (per-file permissions,
revision history, share links, parent folder semantics). It also has no
incremental notion: each Takeout is a full new artifact.

A Drive API connector would give incremental access, richer per-file
metadata, and a real connection model (per Google account, per
device). It also imposes new responsibilities:

- OAuth scope choices (drive vs drive.readonly vs drive.metadata).
- Per-file consent disclosure (the Drive grant surface is large and
  shared resources can re-expand the visible set after consent).
- Freshness story (push notifications vs polling, plus delta tokens).
- Inventory-vs-collection semantics for non-text Google-native files
  (Docs, Sheets, Slides) — what is the canonical record content?

## Stakes

If Drive and Takeout both ship without a clean separation, the owner
UX collapses: two sources of the same files, ambiguous freshness, and
duplicated retention policy decisions. If Drive ships alone, we lose
the existing Takeout coverage for accounts that cannot grant Drive API
scopes. If Drive is deferred indefinitely, the reference implementation
keeps presenting Drive as "supported via Takeout" while real owners
want live freshness.

## Current Leaning

Defer the Drive API connector until the connection model and Collection
Profile coverage semantics can express the Drive/Takeout split honestly:

- One `connector_id` per *capability surface*, not per source vendor.
  Drive API and Takeout are different surfaces with different scope and
  freshness shapes; collapsing them under a single `google_drive` id
  would force the manifest to either lie about freshness or fan out
  per-instance.
- Coverage should report which records came from which surface so the
  owner UX can render "live API" vs "Takeout import" without scraping
  spine events.
- Grants should reference connector + surface, not just connector, so
  revocation can shut off one surface without invalidating the other.

The Drive connector belongs in the same tranche that promotes
connection-first collection identity (`design-notes/connection-first-collection-identity-2026-05-18.md`)
and source-authority-vs-schema-identity work
(`design-notes/source-authority-vs-schema-identity-2026-04-30.md`).

## Promotion Trigger

Promote to an OpenSpec change when any of the following is true:

- An owner with an existing Takeout import asks to enable live Drive
  freshness and the answer is not yet "configure both, coverage is
  honest about each."
- The Collection Profile spec advances on per-surface coverage so the
  Drive/Takeout split can be expressed without overloading
  `connector_id`.
- A standards reviewer asks how PDPP handles vendor surfaces that
  expose the same records through multiple APIs.

## Decision Log

- 2026-05-23: Captured during the read-surface analytics-capabilities
  closeout. Filed out-of-scope from that change because the read-surface
  capability extensions are connector-agnostic and the Drive parity
  decision rides the connection-first collection identity work, not the
  per-request read affordance work.
- 2026-06-04: Re-filed onto current `main` from the now-closed PR
  vana-com/pdpp#3 (`decomplect-ri-construction-boundaries`), which was
  closed as superseded. Only the `Related:` pointer changed: the
  read-surface analytics work this note rode alongside has since landed
  and was archived as
  `openspec/changes/archive/2026-05-29-canonicalize-public-read-contract`
  (plus `2026-05-29-add-aggregate-time-buckets-and-distinct`). Google
  Drive remains served only via the `google_takeout` connector on main;
  no Drive API connector exists yet, so the deferral and its promotion
  triggers still stand.
