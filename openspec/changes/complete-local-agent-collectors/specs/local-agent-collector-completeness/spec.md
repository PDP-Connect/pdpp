## ADDED Requirements

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
