## ADDED Requirements

### Requirement: Batched refactor integrations SHALL land as exact source commits with a single baseline regeneration

A batched integration of owner-accepted internal decomplecting refactors from multiple worker lanes SHALL cherry-pick each accepted commit individually onto the curated tree, never merging a lane's `rc-*` branch as a unit, and SHALL regenerate `reference-implementation/scripts/quality-ratchet/mass-baseline.json` exactly once, from the fully composed tree, after every accepted commit has landed.

#### Scenario: A lane's own regenerated baseline reaches the integration branch

**WHEN** cherry-picking an accepted commit whose diff includes a change to
`mass-baseline.json`
**THEN** the integration SHALL discard that lane's baseline change and keep
the integration branch's current baseline
**AND** the integration SHALL NOT commit any intermediate baseline value
produced by a pre-commit hook's own auto-tightening side effect
**AND** the final baseline SHALL be produced by one dedicated regeneration
command, committed separately from every source commit.

#### Scenario: An accepted commit conflicts with curated-tree behavior added after the commit was authored

**WHEN** a cherry-picked commit's diff conflicts with a non-baseline file
because the curated tree gained new behavior (new fields, new control flow)
after the source lane branched
**THEN** the conflict SHALL be resolved by preserving every curated-tree
behavior, field, and code path
**AND** applying the incoming commit's structural decomposition on top of
that preserved behavior
**AND** the resolution SHALL be verified against that file's existing test
suite and a full typecheck before the conflict commit is made
**AND** no test file SHALL be modified to make the resolution pass.
