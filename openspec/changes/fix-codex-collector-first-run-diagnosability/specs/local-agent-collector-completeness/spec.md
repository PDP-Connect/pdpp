## MODIFIED Requirements

### Requirement: Codex local stores have durable stream contracts

The Codex connector SHALL define durable contracts for approved local stores beyond sessions, messages, function calls, rules, prompts, and skills. Approved stream names SHALL include `history`, `session_index`, `logs`, `shell_snapshots`, `config_inventory`, and `cache_inventory`, with risky payload classes defaulting to inventory-only, redacted, excluded, or deferred until reviewed. User-specific local tool state, including `context-mode`, and unproven memory directories SHALL NOT be part of the general Codex connector surface unless a later explicit opt-in source contract approves them.

A requested store's local source directory SHALL be treated as a fatal
precondition (failing the entire run before any collection is attempted)
only when the store has no graceful empty-result path — i.e. the store's
own collection logic cannot represent "directory absent" as zero records
plus an honest `missing` coverage classification. `sessions` is the only
such store today: a Codex install with no session history has nothing to
report, and sessions are core to the connector's value, so its absence (and
the absence of its `state_db` fallback) SHALL remain fatal. `rules`,
`prompts`, and `skills` are user-authored directories that Codex itself
does not create until the user has written a rule, prompt, or skill; their
absence SHALL NOT fail the run — the connector SHALL emit zero records for
that store and rely on coverage diagnostics (see the coverage-diagnostics
requirement below) to report it honestly as `missing`.

#### Scenario: Codex history files exist
- **WHEN** the configured Codex source home contains `history.jsonl` or `session_index.jsonl`
- **THEN** the connector SHALL either emit `history` and `session_index` records or report those stores as deferred, excluded, missing, unsupported, or inventory-only with a reason

#### Scenario: Codex shell, log, private memory, context, config, or cache stores exist
- **WHEN** Codex shell snapshots, logs SQLite, private memory directories, context-mode state, configuration, auth-adjacent files, or cache directories are discovered
- **THEN** the connector SHALL apply the approved privacy classification before emitting payload content
- **AND** auth-adjacent files SHALL default to exclusion unless a later explicit security review approves a narrower contract
- **AND** private memory directories and context-mode state SHALL be accounted for through safe diagnostics, not default general connector streams

#### Scenario: A fresh Codex install has sessions but no rules, prompts, or skills yet

- **WHEN** a Codex source home has a readable `sessions` directory (or `state_db`) but no `rules`, `prompts`, or `skills` directory, because the user has never authored any of the three
- **AND** the run requests `sessions`, `rules`, `prompts`, and `skills`
- **THEN** the connector SHALL complete the run successfully (`DONE
  status: "succeeded"`), emitting zero records for `rules`, `prompts`, and
  `skills`
- **AND** the run SHALL NOT fail solely because `rules`, `prompts`, or
  `skills` directories are absent

#### Scenario: A Codex install has neither session rollouts nor a state database

- **WHEN** a run requests `sessions` and neither the sessions directory nor
  the state database is readable
- **THEN** the connector SHALL fail the run (`DONE status: "failed"`) with
  an error naming the missing `sessions`/state-db source
- **AND** this failure SHALL be unaffected by whether `rules`, `prompts`,
  or `skills` are present or absent in the same request
