## ADDED Requirements

### Requirement: Local JSONL cursors SHALL commit only stable LF boundaries

The local JSONL cursor SHALL persist a committed byte offset ending immediately after an LF, a SHA-256 over every byte before that offset, and observed size and mtime. It SHALL expose only complete LF-terminated lines to its consumer and SHALL not advance a cursor over an unterminated final line. JSON parsing is consumer policy: after delivering a malformed but LF-terminated line, the consumer MAY reject that logical record and the physical cursor SHALL still advance past its complete byte boundary.

#### Scenario: An incomplete line is completed later

- **WHEN** a scan ends with an unterminated line and a later scan appends its remainder plus LF
- **THEN** the first scan SHALL not commit that line
- **AND** the later scan SHALL deliver it once as a complete line.

### Requirement: Local JSONL cursors SHALL reject unsafe reuse of a committed offset

When observed size or mtime differs, the cursor SHALL verify the full committed prefix from an open file handle. Before returning a cursor, it SHALL prove that the LF-terminated bytes delivered to its consumer still equal the committed prefix. A shrink, invalid cursor, changed prefix, path replacement during scan, or non-append source mutation SHALL select rebuild or fail without returning advanced cursor state.

#### Scenario: A mutation occurs beyond a bounded head prefix

- **WHEN** a byte after 64 KiB and before the committed offset changes
- **THEN** the cursor SHALL not tail from the saved offset
- **AND** it SHALL select a rebuild.

#### Scenario: The path changes while scanning

- **WHEN** the pathname no longer resolves to the opened file or the source mutates without append-only growth during a scan
- **THEN** the scan SHALL fail
- **AND** its caller SHALL receive no advanced cursor.

#### Scenario: A committed-prefix rewrite races with append growth

- **WHEN** a writer rewrites bytes already delivered to the consumer and grows the same open file during a scan
- **THEN** the scan SHALL fail rather than commit a cursor over the rewritten prefix
- **AND** a retry SHALL rebuild from the current source bytes.
