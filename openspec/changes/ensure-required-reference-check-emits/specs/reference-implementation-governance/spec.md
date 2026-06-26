## ADDED Requirements

### Requirement: Required status checks emit terminal results

Branch-protection-required status checks SHALL emit a terminal success or failure result for every pull request and merge-group that is eligible to merge, even when heavy validation is intentionally skipped because the changed files do not affect that check's scope.

#### Scenario: A pull request changes only non-reference files

- **WHEN** a pull request changes files outside the reference-implementation required check scope
- **THEN** the `typecheck + full test suite` required context SHALL still be emitted
- **AND** it SHALL complete successfully with an explicit skip reason instead of remaining missing or pending

#### Scenario: A pull request changes reference-impacting files

- **WHEN** a pull request changes files inside the reference-implementation required check scope
- **THEN** the `typecheck + full test suite` required context SHALL run the reference typecheck and test suite before reporting success

#### Scenario: A merge queue validates a candidate merge group

- **WHEN** GitHub creates a merge-group candidate for the default branch
- **THEN** the required reference-implementation workflow SHALL support the `merge_group` event
- **AND** it SHALL emit the same required context name used for pull requests
