## 1. Spec

- [x] 1.1 Capture prior-art synthesis in `docs/research/acquisition-coverage-profile-slvp-evaluation-2026-06-13.md`.
- [x] 1.2 Add OpenSpec proposal, design, tasks, and spec deltas for acquisition/coverage semantics.
- [x] 1.3 Validate with `openspec validate define-collection-acquisition-coverage --strict`.

## 2. First Implementation Tranche

- [ ] 2.1 Add connector-manifest metadata for acquisition methods and trigger/setup posture without source-specific UI branching.
- [ ] 2.2 Add an acquisition-batch recording shape carrying acquisition method, source format, parser version, artifact/content hash when applicable, event time range, parsed/accepted/duplicate/skipped/failed counts, media coverage facts, and safe warnings.
- [ ] 2.3 Make repeated owner-artifact upload idempotent and return the existing batch receipt when content is already known.
- [ ] 2.4 Add a generic pre-commit validation preview for owner artifacts where the parser can inspect before durable import.
- [ ] 2.5 Add a generic coverage receipt after commit with accepted, duplicate, skipped, failed, time-range, and gap facts.
- [ ] 2.6 Project owner-artifact and multi-acquisition coverage into reference connection health without labeling expected manual staleness or missing media as generic failure.
- [ ] 2.7 Ensure same-stream multi-acquisition keeps acquisition provenance and refuses silent cross-method merge without explicit identity rules.
- [ ] 2.8 Replace source-specific owner setup branches with a manifest-driven source catalog and acquisition path chooser.
- [ ] 2.9 Add the generic coverage-assistant UI flow: instructions, pre-commit preview, commit progress, durable receipt, and next-action copy.
- [ ] 2.10 Add acquisition lanes and recent batch receipts to source/connection detail pages so historical import, current sync, media sync, and backup import remain visible under one source.
- [ ] 2.11 Add owner-journey fixtures for duplicate artifact upload, stale manual export, missing media, wrong-account artifact, parser failure, and same-stream historical-plus-current acquisition.

## 3. Connector Pilots

- [ ] 3.1 Wire Google Maps Timeline import through acquisition batches and coverage receipts.
- [ ] 3.2 Wire WhatsApp chat-export import through the same acquisition-batch and coverage-receipt substrate.
- [ ] 3.3 Add a media-sync pilot or explicit deferred design note for WhatsApp media folder sync as `device_sync`, distinct from chat export `owner_artifact`.
- [ ] 3.4 Add an acceptance fixture showing historical owner artifact plus current browser/API acquisition populating the same stream with preserved provenance.

## 4. Deferred

- [ ] 4.1 Defer cross-method automatic merge beyond explicit identity rules.
- [ ] 4.2 Defer parser-upgrade reprocessing queues until at least two owner-artifact connectors prove the batch model.
- [ ] 4.3 Defer watched-folder automation until the manual/share/upload flow is owner-accepted.
- [ ] 4.4 Defer device-backup extraction implementation until platform-specific support can be proven end-to-end.

## 5. Validation

- [ ] 5.1 Run focused manifest/runtime tests after implementation.
- [ ] 5.2 Run owner-journey acceptance checks for Add Source, upload validation, coverage receipt, stale manual source, and same-stream multi-acquisition.
- [ ] 5.3 Verify dashboard, CLI, and owner API read the same health/coverage projection.
- [ ] 5.4 Verify grant-scoped REST/MCP reads expose records, not owner-only acquisition diagnostics unless separately authorized.
- [ ] 5.5 Review the implemented UI against the SLVP screen choreography in `design.md`, including cognitive-load, progressive-disclosure, copy, responsive behavior, and no developer-only instructions.
- [ ] 5.6 Run fixture-backed UI checks for Google Timeline and WhatsApp-style owner artifacts before declaring the UX owner-accepted.
