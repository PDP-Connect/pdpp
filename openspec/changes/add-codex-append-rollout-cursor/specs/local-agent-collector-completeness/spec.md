## ADDED Requirements

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
