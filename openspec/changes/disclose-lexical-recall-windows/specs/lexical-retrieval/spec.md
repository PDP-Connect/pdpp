## ADDED Requirements

### Requirement: Lexical search responses SHALL disclose count accuracy and recall scope

`GET /v1/search` responses SHALL include a `meta` object with response-level recall metadata. The metadata SHALL include `count`, `count_accuracy`, and `recall`.

`meta.count_accuracy` SHALL be one of `exact`, `lower_bound`, `estimated`, or `not_counted`. When `count_accuracy` is `not_counted`, `meta.count` SHALL be `null`. When `count_accuracy` is `exact`, `lower_bound`, or `estimated`, `meta.count` SHALL be a non-negative integer whose interpretation is defined by `count_accuracy`.

`meta.recall` SHALL include `complete`, `ranking_scope`, and `truncated`. `ranking_scope` SHALL be one of `all_matches`, `candidate_window`, or `unknown`. `complete: true` SHALL mean the implementation ranked all known caller-visible matches for the query before pagination. `complete: false` SHALL mean additional caller-visible matches may exist outside the ranked set. `truncated: true` SHALL mean an implementation-applied candidate or source window prevented the ranked set from representing every caller-visible match.

#### Scenario: Exact complete lexical search
- **WHEN** a server can rank all caller-visible lexical matches and compute their count exactly
- **THEN** the `/v1/search` response SHALL include `meta.count_accuracy: "exact"`
- **AND** `meta.count` SHALL equal the exact number of caller-visible matches
- **AND** `meta.recall.complete` SHALL be `true`
- **AND** `meta.recall.ranking_scope` SHALL be `"all_matches"`
- **AND** `meta.recall.truncated` SHALL be `false`

#### Scenario: Bounded candidate window lexical search
- **WHEN** a server ranks only a bounded subset of caller-visible lexical candidates
- **THEN** the `/v1/search` response SHALL include `meta.recall.complete: false`
- **AND** `meta.recall.ranking_scope` SHALL be `"candidate_window"`
- **AND** `meta.recall.truncated` SHALL be `true`
- **AND** `meta.count_accuracy` SHALL NOT be `"exact"` unless the server separately proves the exact caller-visible match count
- **AND** the response SHALL include compact window facts under `meta.recall` when the implementation knows them

#### Scenario: Count is not computed
- **WHEN** a server cannot compute a useful caller-visible count without violating latency or implementation constraints
- **THEN** the `/v1/search` response SHALL include `meta.count_accuracy: "not_counted"`
- **AND** `meta.count` SHALL be `null`
- **AND** the server SHALL still disclose `meta.recall.complete`, `meta.recall.ranking_scope`, and `meta.recall.truncated` as honestly as possible

#### Scenario: Pagination is distinct from recall completeness
- **WHEN** a `/v1/search` response has `has_more: false`
- **AND** the search ranked only a bounded candidate window
- **THEN** `meta.recall.complete` SHALL remain `false`
- **AND** `meta.recall.truncated` SHALL remain `true`
- **AND** clients SHALL NOT infer global recall completeness from `has_more`

#### Scenario: Metadata remains grant-safe
- **WHEN** a caller's grant excludes a stream, field, connector, or record
- **THEN** excluded data SHALL NOT contribute to `meta.count`
- **AND** excluded data SHALL NOT contribute to `meta.recall` window facts
- **AND** the metadata SHALL NOT enumerate unavailable connectors, streams, fields, or records

### Requirement: Candidate-window facts SHALL be compact and implementation-honest

When an implementation uses a bounded candidate window and knows compact aggregate facts about that window, it SHALL expose those facts under `meta.recall` without dumping per-source internals. Allowed compact facts include `ranked_candidate_count`, `candidate_window_limit`, `sources_searched_count`, and `truncated_source_count`. Implementations MAY omit any fact they cannot prove cheaply and SHALL NOT fabricate a fact to make the response appear more complete.

#### Scenario: Server knows candidate-window facts
- **WHEN** a server ranks 200 caller-visible candidates from a configured candidate window and knows that at least one searched source was truncated
- **THEN** `meta.recall.ranked_candidate_count` SHALL be `200`
- **AND** `meta.recall.truncated_source_count` SHALL be a positive integer
- **AND** `meta.recall.ranking_scope` SHALL be `"candidate_window"`

#### Scenario: Server cannot prove a candidate-window fact
- **WHEN** a server cannot prove `truncated_source_count` for a windowed search
- **THEN** the server SHALL omit `meta.recall.truncated_source_count`
- **AND** SHALL NOT emit `0` as a guess

### Requirement: MCP lexical search SHALL mirror recall metadata

An MCP adapter that exposes PDPP lexical search SHALL preserve the RS response's recall metadata in structured output and SHALL summarize non-complete recall in its text output. The adapter SHALL NOT infer recall completeness from `has_more`, page size, or the number of hits returned.

#### Scenario: MCP mirrors complete recall
- **WHEN** `/v1/search` returns `meta.recall.complete: true`
- **THEN** the MCP search tool's structured output SHALL include the same recall metadata
- **AND** the text summary MAY omit an extra recall warning

#### Scenario: MCP warns on candidate-window recall
- **WHEN** `/v1/search` returns `meta.recall.ranking_scope: "candidate_window"`
- **THEN** the MCP search tool's structured output SHALL include the same recall metadata
- **AND** the text summary SHALL indicate that results were ranked over a bounded candidate window
