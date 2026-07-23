## ADDED Requirements

### Requirement: Biome cleanup SHALL use a fingerprinted selection and diagnostic contract

The cleanup gate SHALL record and compare tool versions, config hashes, exact Biome
and Ultracite selections, exclusions, diagnostic tuples, test manifest, and generator
hashes. It SHALL fail on selection shrinkage or new untriaged findings.

#### Scenario: A config ignore removes selected authored files

**WHEN** the diagnostic count decreases because the selected authored-file set shrinks
**THEN** the selection gate SHALL fail
**AND** the cleanup SHALL not be accepted as a reduction in findings.

### Requirement: Findings SHALL be resolved by policy, not metric gaming

Every finding SHALL be corrected, assigned to an accepted scoped rule policy, or
narrowly suppressed with a tested invariant and owner. Completion SHALL mean zero
untriaged findings and zero baseline regressions, not a raw zero manufactured by
blanket suppression or broadened ignores.

#### Scenario: A rule is a systematic domain mismatch

**WHEN** a rule is rejected for a bounded domain scope
**THEN** the policy SHALL record scope, reason, owner, and test/invariant
**AND** findings outside that scope SHALL remain gated.

### Requirement: Generated artifacts SHALL remain generator-owned

Generated OpenAPI, site-derived output, build output, reports, and captured data
SHALL be excluded or handled only by their owning generator policy. A generated
output hash change SHALL require the generator and its contract check in the same
tranche, and fresh output SHALL be byte-consistent with the generator.

#### Scenario: Generated OpenAPI is formatter-modified without generator change

**WHEN** generated OpenAPI bytes differ but the generator was not run in the tranche
**THEN** the generated-artifact gate SHALL fail
**AND** the formatter diff SHALL not be accepted.

### Requirement: Cleanup SHALL be bounded and independently checked

Policy, formatter, syntax, and semantic cohorts SHALL be separate reviewable units
with exact receipts and a different checker/session. The rejected 910-file RI
checkpoint SHALL NOT be used as a landing unit.

#### Scenario: A tranche touches PostgreSQL or sensitive RI runtime paths

**WHEN** a cleanup diff reaches those paths
**THEN** its applicable PostgreSQL, Docker, and runtime gates SHALL run
**AND** the tranche SHALL block on an unexplained required-profile skip.

### Requirement: Retained JS and MJS SHALL be explicit

Cleanup SHALL classify every retained authored JS/MJS file and record a host,
configuration, generated-boundary, or runtime justification with an executable probe
and review condition. Conversion count SHALL NOT be a completion gate.

#### Scenario: A required host wrapper remains JavaScript

**WHEN** its host contract is documented and its probe passes
**THEN** the wrapper MAY remain JS/MJS
**AND** the cleanup gate SHALL still include it in the classified inventory.
