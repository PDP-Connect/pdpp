## ADDED Requirements

### Requirement: Filesystem connector reads are bounded

The reference implementation SHALL collect filesystem-backed and local-database-backed connector state without retaining whole stream-eligible user files, whole unbounded local database result sets, or source-size-proportional parser state in process memory before record-level bounds apply. Connectors MAY read a whole file only when the file is a reviewed small per-artifact input or the code carries an explicit bounded exception with a reason. Local database connectors SHALL iterate unbounded user-data result sets row by row rather than materializing the full result in memory.

#### Scenario: Local database records stream row by row

- **WHEN** a filesystem-class connector reads records from a local SQLite database whose result size can grow with the owner's history
- **THEN** it SHALL iterate rows without materializing the full query result in memory
- **AND** any `.all()` use on that database SHALL be limited by a bounded query or a reviewed exception.

#### Scenario: Large local export files are streamed or bounded

- **WHEN** a connector reads a user-controlled export file whose size can grow with the owner's history
- **THEN** it SHALL parse that file through a streaming or explicitly bounded reader
- **AND** it SHALL NOT read the whole source file into memory before applying parser or record-level bounds.

#### Scenario: Small per-artifact file reads are reviewed

- **WHEN** a connector intentionally reads a whole per-artifact file into memory
- **THEN** the connector SHALL carry a reviewed reason that the artifact is bounded enough for process memory or that a later streaming migration is explicitly deferred
- **AND** the bounded-read regression guard SHALL fail if that exception is removed, renamed, or broadened without review.

#### Scenario: Logical-unit accumulators stay bounded

- **WHEN** a filesystem-class connector accumulates state across parsed records before emitting a summary stream
- **THEN** the accumulator SHALL retain only bounded scalar fields, timestamps, counters, or previews needed for that summary
- **AND** it SHALL NOT retain raw source lines, transcript bodies, message arrays, tool-output arrays, or other payloads proportional to source byte size
- **AND** a connector-local regression test SHALL pin the reviewed accumulator shape or explicit cap/eviction behavior.
