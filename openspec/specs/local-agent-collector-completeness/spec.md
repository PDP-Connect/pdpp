# local-agent-collector-completeness Specification

## Purpose
TBD - created by archiving change complete-local-agent-collectors. Update Purpose after archive.
## Requirements
### Requirement: Local agent completeness is inventory-based
The reference implementation SHALL define complete local Claude Code and Codex collection as coverage of every known store under the configured source home. Each known store SHALL be collected, collected with redaction, inventoried without payload, excluded, deferred, missing, or unsupported with a machine-readable reason.

#### Scenario: Declared streams succeed but stores remain unaccounted
- **WHEN** a local Claude Code or Codex run emits all requested declared streams but discovers a mounted known store that is not collected, inventoried, excluded, deferred, missing, or unsupported
- **THEN** the reference SHALL NOT report the run as 100% complete local collection
- **AND** it SHALL expose a safe coverage diagnostic naming the unaccounted store class

#### Scenario: A store is intentionally excluded
- **WHEN** a known local store is classified as excluded for privacy or security reasons
- **THEN** the reference SHALL count that store as accounted for in completeness diagnostics
- **AND** it SHALL NOT emit that store's payload as records or blobs

### Requirement: Claude Code local stores have durable stream contracts
The Claude Code connector SHALL define durable contracts for approved local stores beyond transcript-derived sessions, messages, attachments, skills, memory notes, and slash commands. Approved stream names SHALL include `file_history`, `debug_artifacts`, `downloads`, `cache_inventory`, `backup_inventory`, and `config_inventory`, with risky payload classes defaulting to inventory-only, redacted, excluded, or deferred until reviewed. User-specific local tool state, including `context-mode`, SHALL NOT be part of the general Claude Code connector surface unless a later explicit opt-in source contract approves it.

#### Scenario: Standalone file history exists
- **WHEN** the configured Claude Code source home contains `file-history/**`
- **THEN** the connector SHALL either emit approved `file_history` records or report the store as deferred, excluded, missing, unsupported, or inventory-only with a reason
- **AND** transcript-only file-history references SHALL NOT be treated as complete standalone file-history collection

#### Scenario: Auth-adjacent Claude configuration exists
- **WHEN** Claude Code configuration, auth-like files, cache, debug, downloads, or backups are discovered
- **THEN** the connector SHALL apply the approved privacy classification before emitting payload content
- **AND** auth-adjacent files SHALL default to exclusion unless a later explicit security review approves a narrower contract

### Requirement: Codex local stores have durable stream contracts
The Codex connector SHALL define durable contracts for approved local stores beyond sessions, messages, function calls, rules, prompts, and skills. Approved stream names SHALL include `history`, `session_index`, `logs`, `shell_snapshots`, `config_inventory`, and `cache_inventory`, with risky payload classes defaulting to inventory-only, redacted, excluded, or deferred until reviewed. User-specific local tool state, including `context-mode`, and unproven memory directories SHALL NOT be part of the general Codex connector surface unless a later explicit opt-in source contract approves them.

#### Scenario: Codex history files exist
- **WHEN** the configured Codex source home contains `history.jsonl` or `session_index.jsonl`
- **THEN** the connector SHALL either emit `history` and `session_index` records or report those stores as deferred, excluded, missing, unsupported, or inventory-only with a reason

#### Scenario: Codex shell, log, private memory, context, config, or cache stores exist
- **WHEN** Codex shell snapshots, logs SQLite, private memory directories, context-mode state, configuration, auth-adjacent files, or cache directories are discovered
- **THEN** the connector SHALL apply the approved privacy classification before emitting payload content
- **AND** auth-adjacent files SHALL default to exclusion unless a later explicit security review approves a narrower contract
- **AND** private memory directories and context-mode state SHALL be accounted for through safe diagnostics, not default general connector streams

### Requirement: Local collector coverage diagnostics are safe and explicit
The reference implementation SHALL emit safe coverage diagnostics for full local Claude Code and Codex runs. Diagnostics SHALL distinguish collected, collected-redacted, inventory-only, excluded, deferred, missing, unsupported, and unaccounted stores without exposing secrets or raw auth material.

#### Scenario: A new tool release adds an unknown store
- **WHEN** a local source home contains a store that the collector does not recognize
- **THEN** the reference SHALL report the store as unaccounted or unsupported in coverage diagnostics
- **AND** it SHALL NOT silently treat declared-stream success as complete local collection

#### Scenario: Diagnostics are displayed to an owner or operator
- **WHEN** coverage diagnostics are shown through dashboard, `_ref`, logs, or run timelines
- **THEN** the reference SHALL avoid raw secrets, auth file contents, browser cookies, and raw local absolute paths unless a local-only debug mode explicitly permits them

### Requirement: Local source homes are connector-instance scoped
The reference implementation SHALL bind every local Claude Code and Codex source home to a connector instance before accepting new local collector records, blobs, checkpoints, schedules, health, or diagnostics. Record identity and checkpoint identity SHALL include the connector instance namespace so multiple devices or source homes cannot collide.

#### Scenario: Two devices collect the same connector type
- **WHEN** two local source homes collect Claude Code or Codex records with the same connector-local key
- **THEN** the reference SHALL store them as distinct records under distinct connector instances
- **AND** schedules, active-run leases, checkpoints, diagnostics, and owner actions SHALL operate on the connector instance rather than `connector_id` alone

#### Scenario: Existing single-device state is migrated
- **WHEN** existing connector-keyed local Claude Code or Codex state is migrated
- **THEN** the reference SHALL create or resolve one connector instance per owner, connector type, and source home
- **AND** connector-only compatibility operations SHALL fail clearly if more than one matching instance exists

### Requirement: Codex rollout collection uses an append-safe per-file source cursor

The Codex connector SHALL track rollout JSONL files with a per-file source cursor
that is cursorable by file identity, a committed byte offset, and an integrity
guard — not by whole-file modification time alone. The cursor for a tracked file
SHALL carry at least its last-observed modification time and size, the byte offset
at the end of the last fully-parsed line, the parser line counter at that boundary,
the session id and the cumulative message and function-call counts parsed up to
that boundary, and an integrity guard over a bounded file prefix sufficient to
detect truncation or replacement before tailing.

When a tracked rollout file has grown since its cursor was written and its prefix
integrity guard still matches, the connector SHALL parse only the appended byte
suffix beginning at the committed offset and SHALL emit only the records contained
in that suffix. The connector SHALL continue the parser line counter from the
committed boundary so appended record keys do not collide with keys already emitted
for that file. The connector SHALL NOT load the whole rollout file into memory to
tail it.

A rollout file whose size and modification time both match its cursor SHALL be
skipped without reparsing. A rollout file with no cursor SHALL be parsed in full. A
rollout file that has shrunk, whose committed offset is past end of file, or whose
prefix integrity guard no longer matches SHALL be treated as truncated or replaced
and SHALL be reparsed in full from offset zero rather than skipped or tailed from a
stale offset, so no appended data is silently lost.

The per-file cursor SHALL be backward-compatible with the legacy whole-file
modification-time cursor. A rollout file present only in legacy modification-time
state whose modification time has changed MAY be reparsed in full once on first
upgrade; the run SHALL then write the per-file cursor so subsequent appends tail
instead of reparsing.

After an append-only delta parse, a session's emitted `message_count` and
`function_call_count` SHALL equal the full prior-plus-delta totals for that session,
not the suffix-only counts. The delta counts from the tailed suffix SHALL be added
to the counts carried on the prior file cursor; an append-only parse SHALL NOT
overwrite a correct prior count with a suffix-only count.

The connector SHALL continue to defer rollout files modified inside the active
quiet window so a partial in-flight line is not committed, and the committed byte
offset SHALL always end on a line terminator so a trailing partial line is re-read
on a later run rather than committed mid-write.

The per-file cursor's recorded size SHALL equal its committed byte offset, never
the raw on-disk size, because the rollout file may grow while it is being parsed
(the source is actively appended). Recording the larger raw size would let a later
run observe a matching size for a file that still has an uncommitted tail and skip
it, losing the tail. The cursor's modification time SHALL be observed after the
parse completes so it reflects any append that landed during the parse.

#### Scenario: First run full-parses a rollout file and writes a rich per-file cursor

- **WHEN** a rollout file has no prior per-file cursor and is collected this run
- **THEN** the connector SHALL parse the whole file and emit its records
- **AND** the emitted `messages` STATE cursor SHALL carry a per-file cursor for that
  path with its size, the committed end-of-file byte offset, the parser line count,
  the session id, the cumulative message and function-call counts, and a prefix
  integrity guard

#### Scenario: Unchanged rollout file emits no rollout records

- **WHEN** a rollout file's size and modification time both match its prior per-file
  cursor
- **THEN** the connector SHALL skip the file
- **AND** it SHALL emit no `messages` or `function_calls` records for that file
- **AND** it SHALL carry the prior per-file cursor forward unchanged

#### Scenario: Appended rollout file emits only the appended records

- **WHEN** a long-lived rollout file under an old date directory has grown since its
  per-file cursor was written and its prefix integrity guard still matches
- **THEN** the connector SHALL parse only the appended byte suffix from the committed
  offset and SHALL emit only the records contained in that suffix
- **AND** the appended record keys SHALL continue the file's line-counter sequence so
  they do not collide with records already emitted for that file
- **AND** the file SHALL NOT be reparsed from the beginning

#### Scenario: Truncated or replaced rollout file falls back to a full reparse

- **WHEN** a tracked rollout file has shrunk below its cursor size, or its committed
  offset is past end of file, or its prefix integrity guard no longer matches
- **THEN** the connector SHALL reparse the file in full from offset zero
- **AND** it SHALL NOT tail from the stale offset and SHALL NOT silently skip the file

#### Scenario: Session counts stay correct after an append-only delta parse

- **WHEN** a session's rollout file is tailed and only its appended suffix is parsed
- **THEN** the session's emitted `message_count` and `function_call_count` SHALL equal
  the full prior-plus-delta totals for that session
- **AND** the suffix-only counts SHALL NOT overwrite the correct prior counts

#### Scenario: Legacy mtime cursor upgrades to the per-file cursor

- **WHEN** a rollout file is present only in the legacy whole-file modification-time
  cursor and its modification time has changed
- **THEN** the connector MAY reparse the file in full once
- **AND** the run SHALL write a per-file cursor for that path so a later append tails
  from the committed offset instead of reparsing the whole file

#### Scenario: Cursor size never exceeds the committed boundary on a partial tail

- **WHEN** a rollout file's last line is unterminated (a partial in-flight append),
  so the file's raw byte size is greater than the committed offset
- **THEN** the per-file cursor's recorded size SHALL equal the committed offset, not
  the raw byte size
- **AND** the next run SHALL observe the file as grown (uncommitted tail present) and
  re-read from the committed offset rather than skipping it
