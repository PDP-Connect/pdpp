## 1. Spec

- [x] 1.1 Capture prior-art synthesis in `docs/research/acquisition-coverage-profile-slvp-evaluation-2026-06-13.md`.
- [x] 1.2 Add OpenSpec proposal, design, tasks, and spec deltas for acquisition/coverage semantics.
- [x] 1.3 Validate with `openspec validate define-collection-acquisition-coverage --strict`.

## 2. First Implementation Tranche

- [x] 2.1 Add connector-manifest metadata for acquisition methods and trigger/setup posture without source-specific UI branching.
- [x] 2.2 Add an acquisition-batch recording shape carrying acquisition method, source format, parser version, artifact/content hash when applicable, event time range, parsed/accepted/duplicate/skipped/failed counts, media coverage facts, and safe warnings.
- [x] 2.3 Make repeated owner-artifact upload idempotent and return the existing batch receipt when content is already known.
- [x] 2.4 Add a generic pre-commit validation preview for owner artifacts where the parser can inspect before durable import.
  - [x] 2.4a Setup-status receipt down-payment: manual-upload validation evidence already stored in `source_binding.import_validation` is now projected through owner setup status as a non-secret `import_receipt` so the owner can review what the parser found after submission. This is not yet a separate validate-confirm-commit screen.
  - [x] 2.4b The manual-upload owner flow now calls a non-durable validation-preview endpoint before import, renders "What PDPP found", blocks import until validation succeeds when a parser exists, and returns duplicate-artifact status without creating another draft.
- [x] 2.5 Add a generic coverage receipt after commit with accepted, duplicate, skipped, failed, time-range, and gap facts.
  - [x] 2.5a Validation receipt down-payment: the setup-status page renders the uploaded file, validation status, detected format, estimated point/segment counts, coverage window, and acquisition method.
  - [x] 2.5b Acquisition-batch storage now carries committed accepted/duplicate/skipped/failed counts and setup status renders them in the durable receipt after ingest.
- [x] 2.6 Project owner-artifact and multi-acquisition coverage into the reference owner-control projection alongside connection health without labeling expected manual staleness or missing media as generic failure.
  - [x] 2.6a `_ref/connectors` now projects owner-only `acquisition_coverage` summaries, and the records list can link to the latest import receipt without exposing acquisition diagnostics on grant-scoped reads.
  - [x] 2.6b The source detail page renders acquisition batches as coverage receipts, not as scheduler/run failures.
- [x] 2.7 Ensure same-stream multi-acquisition keeps acquisition provenance and refuses silent cross-method merge without explicit identity rules.
  - [x] 2.7a Accepted records from batch-backed ingest now write a `record_acquisition_provenance` side table keyed by connector instance, stream, and record key. Stable record keys are the explicit identity rule for the first same-stream fixture; broader cross-method merge inference remains deferred.
  - [x] 2.7b Committed-count updates now scope to the latest active acquisition batch instead of mutating every historical batch for a connection.
- [x] 2.8 Replace source-specific owner setup branches with a manifest-driven source catalog and acquisition path chooser.
  - [x] 2.8a UI copy down-payment: the manifest-driven source catalog now presents a source journey (name, recommended next action, current support fact, low-noise detail disclosure) instead of "one status and one next action"; the manual/upload page orders primary acquisition methods first with advanced paths behind one disclosure. No source-specific React branches added.
  - [x] 2.8b Catalog entries now carry manifest-authored acquisition paths, and Add Source renders primary paths plus secondary/advanced paths through a generic source-acquisition-path renderer.
- [x] 2.9 Add the generic coverage-assistant UI flow: instructions, pre-commit preview, commit progress, durable receipt, and next-action copy.
  - [x] 2.9a Copy/framing down-payment: manual/upload page reads as a coverage-assistant start (manifest-generated, validate-before-commit language when a validator exists, import not "first sync" CTA for owner artifacts); setup status page uses import/receipt language for `manual_upload` and drops provider-credential semantics for imports.
  - [x] 2.9b Status receipt down-payment: manual-upload setup status now includes and renders a "What PDPP found" coverage preview, with copy explicitly distinguishing validation estimates from future acquisition-batch committed counts.
  - [x] 2.9c The manual/upload page now provides a two-step review/import interaction with manifest-authored accepted files, help links, validation expectations, duplicate receipt handoff, and source-neutral copy.
  - [x] 2.9d Setup status now renders generic import progress phases from existing setup-state and receipt facts: received, parsed, deduplicated, committed, indexed, and health-projected. No new lifecycle enum or source-specific branch was added.
- [x] 2.10 Add acquisition lanes and recent batch receipts to source/connection detail pages so historical import, current sync, media sync, and backup import remain visible under one source.
  - [x] 2.10a The records list now surfaces the latest import receipt as a compact cue linked to setup status.
  - [x] 2.10b The source detail page now renders recent acquisition batches as source-neutral coverage lanes with durable receipt links and warning/count/date facts.
- [x] 2.11 Add owner-journey fixtures for duplicate artifact upload, stale manual export, missing media, wrong-account artifact, parser failure, and same-stream historical-plus-current acquisition.
  - [x] 2.11a Fixture-backed tests now cover duplicate artifact upload, unsupported/parser-failure artifacts, WhatsApp missing-media warning facts, and Google Timeline stale/empty/too-large validation.
  - [x] 2.11b Wrong-source/account-report artifacts with accepted filenames now fail before commit and create no draft; true same-account matching remains explicitly impossible unless a future connector declares a verifiable identity extractor.
  - [x] 2.11c Same-stream historical-plus-current acquisition is covered by the owner-artifact plus provider-API fixture that preserves record-level acquisition provenance.
- [x] 2.12 Support owner-artifact variant parity for WhatsApp chat exports: `.txt` without media and `.zip` with media both validate through the connector parser, with media presence recorded as coverage evidence rather than overclaimed attachment.
- [x] 2.13 Allow repeat owner-artifact imports to target an existing manual/upload source while new account/profile/device/source identities create distinct owner-facing connections.

## 3. Connector Pilots

- [x] 3.1 Wire Google Maps Timeline import through acquisition batches and coverage receipts.
- [x] 3.2 Wire WhatsApp chat-export import through the same acquisition-batch and coverage-receipt substrate.
- [x] 3.3 Add a media-sync pilot or explicit deferred design note for WhatsApp media folder sync as `device_sync`, distinct from chat export `owner_artifact`.
- [x] 3.4 Add an acceptance fixture showing historical owner artifact plus current browser/API acquisition populating the same stream with preserved provenance.

## 4. Deferred

- [x] 4.1 Defer cross-method automatic merge beyond explicit identity rules.
- [x] 4.2 Defer parser-upgrade reprocessing queues until at least two owner-artifact connectors prove the batch model.
- [x] 4.3 Defer watched-folder automation until the manual/share/upload flow is owner-accepted.
- [x] 4.4 Defer device-backup extraction implementation until platform-specific support can be proven end-to-end.

## 5. Validation

- [x] 5.1 Run focused manifest/runtime tests after implementation.
- [x] 5.2 Run owner-journey acceptance checks for Add Source, upload validation, coverage receipt, stale manual source, and same-stream multi-acquisition.
- [x] 5.3 Verify dashboard, CLI, and owner API read the same health/coverage projection.
- [x] 5.4 Verify grant-scoped REST/MCP reads expose records, not owner-only acquisition diagnostics unless separately authorized.
  - [x] 5.4a Public `/v1` records read regression now proves an imported record is visible while `acquisition_coverage`, `import_receipt`, `artifact_sha256`, and `media_coverage` stay off the read envelope.
  - [x] 5.4b MCP canonical mirror regression now proves `query_records` returns grant-scoped records without adapter-added owner-only acquisition diagnostics.
- [x] 5.5 Review the implemented UI against the SLVP screen choreography in `design.md`, including cognitive-load, progressive-disclosure, copy, responsive behavior, and no developer-only instructions.
- [x] 5.6 Run fixture-backed UI checks for Google Timeline and WhatsApp-style owner artifacts before declaring the UX owner-accepted.
- [x] 5.7 Re-run focused WhatsApp text/zip validation and manual-upload route tests for media variants, malformed zip rejection, and existing-source repeat import.
