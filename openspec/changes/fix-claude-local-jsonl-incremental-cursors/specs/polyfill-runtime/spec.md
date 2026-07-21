## ADDED Requirements

### Requirement: Claude transcript streams SHALL use independent rich cursors

Claude sessions and child transcript streams SHALL retain independent per-file local JSONL cursors. Each cursor SHALL retain only physical source state plus the minimum parser continuation needed by its stream, and SHALL retain legacy file mtimes during the bounded migration period. Rich session cursor maps and aggregate snapshots are one coherent snapshot: malformed or missing rich session cursor state, or a current legacy-tracked path missing its rich cursor, SHALL force a full current-source session rebuild. Dual-written mtime maps SHALL be reconstructed from current discovery and SHALL not retain removed paths.

#### Scenario: Sessions are requested after child records

- **WHEN** child transcript state is current and sessions are requested with no session rich cursor
- **THEN** the sessions stream SHALL build its own rich cursors and aggregate snapshot
- **AND** the child stream SHALL not advance its cursor.

### Requirement: Claude session output SHALL equal a clean current-source fold

The sessions stream SHALL persist one aggregate snapshot per session. A safe append SHALL update that snapshot from saved parser observations; an unsafe file, invalid aggregate state, or removed tracked file SHALL rebuild all current session aggregates before records or STATE are committed.

#### Scenario: One contributor changes and another does not

- **WHEN** a session has a top-level and subagent JSONL contributor and only one safely appends
- **THEN** the emitted aggregate SHALL include both contributors
- **AND** it SHALL equal a clean full-source fold.

#### Scenario: Rich session cursor state is partial or corrupt

- **WHEN** a persisted v1 session cursor map is missing, contains a malformed entry, or omits a path retained by its dual-written mtime map
- **THEN** the connector SHALL discard the persisted aggregate snapshot for that session pass
- **AND** it SHALL rebuild all current session contributors before committing replacement STATE.

### Requirement: Legacy Claude JSONL migration SHALL baseline per source

During the bounded legacy `file_mtimes` compatibility period, Claude SHALL scan every discovered current JSONL source before persisting a v1 cursor. A source MAY suppress child records only when a numeric legacy mtime from a pre-v1/mixed-version state map equals the mtime observed by that completed scan. A new, missing, malformed, or mismatched legacy entry SHALL collect that current source once; it SHALL NOT cause matching contributors to replay. The migration SHALL NOT invent committed offsets or prefix hashes from mtime state alone.

For sessions, Claude SHALL fold all current contributors before committing STATE. It SHALL emit complete aggregates only for session ids observed in a new or mtime-mismatched legacy contributor; aggregates formed only from matching contributors establish the baseline without records. Corrupt or partial v1 session snapshots remain subject to the existing all-current-source rebuild rule.

#### Scenario: One legacy contributor changed in a large checkpoint

- **WHEN** a pre-v1 checkpoint has legacy maps for many paths, most discovered sources match their saved mtimes, and one or more discovered sources are new or have a different mtime
- **THEN** matching sources SHALL be scanned and recorded as rich cursors without child transcript records
- **AND** only the new or mtime-mismatched sources SHALL emit child transcript records
- **AND** the staged v1 session and child cursors SHALL be committed only through the existing checkpoint barrier
- **AND** a later run with that v1 STATE and unchanged files SHALL emit no transcript records.

### Requirement: Claude local transcript state SHALL preserve checkpoint safety and privacy

The connector SHALL stage cursor state until its pass completes, preserving existing parent-first record ordering and runner checkpoint barriers. Its STATE SHALL not include credentials, raw transcript lines, previews, child record keys, or child-body fingerprints.

#### Scenario: A child-record pass crashes before STATE

- **WHEN** child RECORD output occurs and the run fails before its STATE message
- **THEN** the next run SHALL use the prior cursor
- **AND** replayed stable logical keys SHALL remain eligible for existing destination no-op handling.
