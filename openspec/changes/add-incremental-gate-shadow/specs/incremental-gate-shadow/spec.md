## ADDED Requirements

### Requirement: Shadow selector schema SHALL be versioned and fail closed

The incremental gate shadow evaluator SHALL accept only a declared, versioned
selector schema. The selector SHALL record the repository head, the raw
NUL-delimited diff digest, the normalized changed-file identities, the advertised
file list, protected-path classification, and any typed fallback reason. Unknown
schema versions, malformed NUL input, unsupported path identities, or ambiguous
protected-path classification SHALL fail closed and SHALL NOT produce terminal
green shadow evidence.

#### Scenario: NUL-delimited diff input is parsed as data

- **WHEN** the changed input includes NUL-delimited paths with spaces, newlines,
  leading dashes, glob characters, shell metacharacters, or Unicode-normalization
  collisions
- **THEN** the selector SHALL parse the paths as data rather than shell tokens
- **AND** the shadow receipt SHALL record the exact diff digest and normalized
  file identities used for evaluation
- **AND** parsing ambiguity SHALL produce typed fallback instead of green shadow
  evidence

#### Scenario: Protected paths force fallback

- **WHEN** any changed input matches a protected path or the evaluator cannot
  prove whether a path is protected
- **THEN** the selector SHALL record a protected fallback state
- **AND** the evaluator SHALL report full-gate-needed shadow evidence
- **AND** it SHALL NOT claim an incremental pass for that input set

### Requirement: Shadow graph schema SHALL bound closure explicitly

The incremental gate shadow evaluator SHALL build dependency closure using a
declared, versioned graph schema. The graph SHALL record the root files, visited
nodes, traversed edges, ignored edges with typed reasons, closure limits, and
whether the closure is complete. If graph construction exceeds a configured node,
edge, time, or unsupported-language bound, the evaluator SHALL fail closed to a
bounded fallback state and SHALL NOT claim a complete closure.

#### Scenario: Closure exceeds a configured bound

- **WHEN** dependency closure exceeds the evaluator's configured node, edge,
  time, or unsupported-language bound
- **THEN** the graph SHALL record the observed bound that was exceeded
- **AND** the shadow receipt SHALL mark the closure as incomplete
- **AND** the evaluator SHALL require the full gate for authority

#### Scenario: Advertised files and honored files are exact

- **WHEN** the evaluator advertises a file list for an incremental shadow run
- **THEN** every advertised file SHALL be either honored in the selector/graph
  closure or rejected with a typed reason
- **AND** every honored file SHALL come from the advertised file list or from a
  graph edge recorded in the bounded closure
- **AND** any missing, extra, or silently skipped file SHALL fail the shadow check

### Requirement: Shadow receipts SHALL be authority-compatible but non-authoritative

The incremental gate shadow evaluator SHALL emit a versioned shadow receipt only
after selector parsing, graph construction, fallback classification, and report
matching complete. The receipt SHALL record the exact repository head, the exact
authority/full-gate report identity being compared, selector schema version,
graph schema version, receipt schema version, NUL diff digest, advertised file
list, honored file list, closure completeness, fallback state, terminal status,
and created timestamp.

A shadow receipt SHALL be authority-compatible evidence for comparison only. It
SHALL NOT replace acceptance, skip the full gate, change CI status, or grant merge
admission in this change.

#### Scenario: Crash occurs before receipt commit

- **WHEN** the shadow evaluator starts work and crashes before all required
  receipt fields are durably committed
- **THEN** no terminal success receipt SHALL exist for that evaluation
- **AND** any partial or resumable record SHALL be typed non-authoritative
- **AND** a later comparison SHALL NOT treat the partial record as green shadow
  evidence

#### Scenario: Receipt joins only on exact head and report identity

- **WHEN** a shadow receipt is compared with an authority or full-gate report
- **THEN** the comparison SHALL require the exact same repository head
- **AND** it SHALL require the exact authority/full-gate report identity recorded
  in the receipt
- **AND** a mismatched head, missing report, rewritten report, or ambiguous report
  selector SHALL fail closed instead of producing green shadow evidence

#### Scenario: Shadow mode remains unactivated

- **WHEN** a shadow run reports complete green evidence
- **THEN** CI status, merge admission, acceptance status, and full-gate execution
  SHALL remain unchanged
- **AND** the receipt SHALL be reported as shadow-only evidence
