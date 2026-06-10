## MODIFIED Requirements

### Requirement: Local agent completeness is inventory-based

The reference implementation SHALL define complete local Claude Code and Codex collection as coverage of every known store under the configured source home. Each known store SHALL be collected, collected with redaction, inventoried without payload, excluded, deferred, missing, or unsupported with a machine-readable reason.

An inventory metadata record (an `inventory_only` or `defer` store's path/type/classification/reason record, with no payload content) SHALL NOT be re-versioned by a change limited to the incidental file-stat fields `mtime_epoch` and `size_bytes`. The connector SHALL gate inventory-record emission with a fingerprint that excludes those two fields, so a store whose inventory meaning (its `relative_path`/`path_hash`, `type`, `classification`, and `reason`) is unchanged does not append a new version when only the underlying file or directory's modification time or size moved. A real inventory transition — a store appearing or disappearing, a file becoming a directory, a path-hash move, or a classification/reason change — SHALL still produce a new version. The store's freshness (whether it exists and when the collector last looked) SHALL be carried by the coverage diagnostics and the per-stream collection state, not by re-versioning the inventory record.

#### Scenario: Declared streams succeed but stores remain unaccounted

- **WHEN** a local Claude Code or Codex run emits all requested declared streams but discovers a mounted known store that is not collected, inventoried, excluded, deferred, missing, or unsupported
- **THEN** the reference SHALL NOT report the run as 100% complete local collection
- **AND** it SHALL expose a safe coverage diagnostic naming the unaccounted store class

#### Scenario: A store is intentionally excluded

- **WHEN** a known local store is classified as excluded for privacy or security reasons
- **THEN** the reference SHALL count that store as accounted for in completeness diagnostics
- **AND** it SHALL NOT emit that store's payload as records or blobs

#### Scenario: An unchanged inventory store is re-observed on a later run

- **WHEN** a later local run re-observes an `inventory_only` or `defer` store whose path, type, classification, and reason are unchanged but whose underlying file or directory `mtime_epoch` (and, for a file, `size_bytes`) has moved
- **THEN** the connector SHALL NOT emit a new version of that store's inventory record
- **AND** the run's coverage diagnostics SHALL still account for the store
- **AND** a subsequent run in which the store's type, path, classification, or reason changes SHALL emit a new version of the inventory record
