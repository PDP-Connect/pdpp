## Context

The root Collection Profile says connectors may collect through APIs, browser
automation, local files, uploaded artifacts, or future portability APIs using the
same START/RECORD/STATE/DONE protocol. That abstraction is directionally right
but incomplete for owner-provided and multi-path sources.

The missing durable facts are not source-specific. They recur across:

- Google Maps Timeline: owner exports historical Timeline data from the mobile
  app, while a later connector might collect newer data through another path.
- WhatsApp: chat text exports, media-folder sync, and future backup import can
  all contribute related records with different provenance strength.
- Apple Health and Takeout-like archives: repeated full or partial exports are
  normal; duplicate and out-of-order uploads should be safe.
- Browser polyfills: a daily browser-backed pass may append current records to
  streams that historical archive import also populated.

Prior-art synthesis is captured in
`docs/research/acquisition-coverage-profile-slvp-evaluation-2026-06-13.md`.
The decisive pattern is that mature systems preserve acquisition provenance and
coverage rather than pretending every source is a live OAuth connection.

## Decision

Introduce `acquisition_batch` as the Collection Profile concept for one bounded
acquisition event: an API window, owner artifact upload, device sync pass,
device backup import, or browser/session polyfill pass.

An acquisition batch is not a grant, not a source connection, and not a stream.
It is evidence about how records reached the personal server and what coverage
that bounded acquisition claims.

The essential invariants:

- Acquisition method is orthogonal to trigger/setup posture.
- Acquisition method is orthogonal to stream identity; different methods may
  emit to the same stream.
- Coverage claims are evidence, not success marketing.
- Partial, repeated, stale, overlapping, duplicate, and media-incomplete batches
  are expected inputs.
- Cross-method identity merge requires explicit connector-declared or
  implementation-approved identity rules.
- PDPP Core remains collection-method agnostic.

## Vocabulary

Initial acquisition methods:

- `provider_api`: provider API or platform portability API acquisition.
- `owner_artifact`: owner-provided file/archive/export artifact.
- `device_sync`: enrolled local device or app pushes records from local state,
  folders, or app-visible device data.
- `device_backup`: acquisition from an owner-provided device backup or database
  export where extraction has distinct provenance and risk from ordinary device
  sync.
- `browser_polyfill`: browser/session automation used as a portability polyfill.

This list is intentionally small. "Manual", "scheduled", "watched folder",
"share target", "one shot", and "requires owner action" are trigger/setup
postures, not acquisition methods.

## Same-Stream Multi-Acquisition

A connection may populate the same stream through several acquisition methods.
For example, Google Takeout or a Timeline export may hydrate historical
`timeline_points`, while a daily browser or provider-API polyfill may append
newer `timeline_points`. That is allowed only when:

- each batch records its acquisition method and provenance;
- stream records have stable keys or explicit merge rules;
- duplicate and overlapping records are idempotent;
- coverage windows and gaps remain attributable to the batch that produced them;
- owner surfaces do not collapse the source to a single unqualified "synced"
  state.

This is essential complexity. It prevents a false choice between "one live
connector" and "one import connector" while avoiding source-specific branching.

## UX Standard

The owner experience should be a coverage assistant:

1. Show how to acquire the data using connector-authored instructions.
2. Validate before commit when possible.
3. Preview parsed records, duplicates, accepted records, time range, and media or
   parser gaps.
4. Commit idempotently.
5. Show a coverage receipt.
6. Explain the next useful action: re-export, add another archive, sync media,
   run the current-data path, or do nothing.

Do not show:

- `connected` for an inert owner artifact.
- `sync failed` for an export that is merely stale.
- a green success state that hides missing media or partial coverage.
- developer-oriented setup instructions in owner flows.
- connector-specific React branches for acquisition flows.

## UI/UX SLVP Validation

SLVP means the Stripe, Linear, Vercel, and Plaid quality bar: calm,
authoritative, low-cognitive-load product design that makes the right next
action obvious without hiding important state.

The SLVP ideal is not a catalog of connector implementation states. It is a
manifest-driven source journey where the owner understands:

- what data source they are adding;
- which acquisition path is recommended now;
- what action they must take outside PDPP, if any;
- what PDPP found before it commits records;
- what coverage was added after commit;
- what remains missing, stale, duplicated, or partial.

The concrete screen choreography is:

1. **Source catalog.** The owner sees one card per source, generated from
   connector manifests. A card shows the source name, the best available next
   action, the latest coverage fact if any, and a secondary affordance for
   other acquisition paths. It does not expose developer maturity labels as the
   primary information architecture.
2. **Acquisition path choice.** When a source has multiple valid paths, the UI
   presents them as owner jobs such as "Import history from an export" or "Keep
   recent data current from this device", not as internal methods. The
   recommended path is first; advanced or less-proven paths are behind one
   level of disclosure.
3. **Instruction handoff.** The setup page uses connector-authored instructions
   and links. It never asks the owner to run a monorepo command, know package
   paths, infer IDs from JSON, or distinguish `connection_id` from
   `source_instance_id`. If a local collector is required, the owner receives a
   stable install command or app handoff for their operating system.
4. **Pre-commit validation.** For uploads, archives, backups, and pasted
   credentials, the UI validates before durable commit where possible. The
   preview states the parsed source, date range, candidate record count,
   duplicate count, skipped/failed count, missing media facts, and warnings.
5. **Commit progress.** Import or sync progress is shown as phases that map to
   the shared runtime: received, parsed, deduplicated, committed, indexed, and
   health-projected. Cancellation and retry copy states whether records were
   already committed.
6. **Coverage receipt.** Completion produces a durable receipt, not a generic
   success banner. The receipt states the new records accepted, duplicates
   skipped, coverage window, gaps, warnings, and the next useful action.
7. **Source detail after setup.** Existing connections stay manageable. The
   detail page shows acquisition lanes and recent batches under one source:
   historical import, current API/browser/device sync, media sync, or backup
   import. Same-stream multi-acquisition is visible as coverage provenance, not
   as duplicate confusing connectors.

The critical edge states are part of the ideal UI, not polish:

- repeated upload of an already-known artifact returns the previous receipt;
- stale manual export is shown as stale coverage, not a failed sync;
- missing media is shown as incomplete media coverage, not a broken connector;
- partial chat exports and out-of-order uploads remain importable;
- unsupported, encrypted, malformed, or wrong-account artifacts fail before
  commit with source-specific recovery instructions from the manifest;
- overlapping historical import plus current sync can populate the same stream
  only with explicit provenance and idempotent keys;
- revoked or paused connections remain visible with a re-connect or resume path.

This interaction model is the part validated against prior art. Final visual
craft, exact copy, animation, and responsive behavior remain implementation
acceptance gates; they cannot be honestly declared SLVP ideal until a working
prototype is reviewed with real connector manifests and representative fixtures.

## Layering

PDPP Core owns grants, disclosure, record and stream semantics, and query
enforcement. It does not own acquisition batches.

Collection Profile owns acquisition-batch semantics, connector manifest
declarations, coverage claims, and connector/runtime obligations.

The reference implementation owns storage tables, upload endpoints, local
collector packaging, UI components, background jobs, and exact health projection
payloads.

## Alternatives

### One generic `file_import`

Rejected. It hides important distinctions between owner-provided artifacts,
device media sync, backup extraction, and watched folders. That smaller noun
would increase connector-local incidental complexity.

### Source-specific setup pages

Rejected. WhatsApp, Google Timeline, Apple Health, and Takeout-like sources need
different copy and validators, but the flow shape is shared. Connector manifests
should provide instructions, accepted formats, warnings, and validators; the RI
should provide the shared upload/share/coverage experience.

### Automatic cross-method merge

Rejected for the first tranche. Prior art does not support safe universal
cross-method merge. The system may surface overlaps and may merge when explicit
identity rules prove equivalence, but it must not silently infer that all methods
are equal evidence.

### Large workflow engine

Rejected. The essential model is bounded acquisition evidence plus existing run
and health machinery. A general workflow engine would be incidental complexity
until proven necessary.

## Acceptance Checks

- `openspec validate define-collection-acquisition-coverage --strict`
- OpenSpec requirements distinguish acquisition method from trigger/setup
  posture.
- Requirements allow same-stream multi-acquisition while requiring provenance
  and explicit identity rules.
- Requirements keep PDPP Core out of scope.
- Tasks track the first narrow reference-implementation tranche and keep
  remaining owner-acceptance work explicit.
- UI implementation can be tested against the screen choreography above with
  real Google Timeline, WhatsApp, Gmail, and browser-polyfill style fixtures.
