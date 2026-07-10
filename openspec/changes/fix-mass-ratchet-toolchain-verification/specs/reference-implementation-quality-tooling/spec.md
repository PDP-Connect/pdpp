## ADDED Requirements

### Requirement: The complexity mass ratchet SHALL resolve its lint toolchain deterministically

The mass-ratchet measurement SHALL invoke the Biome binary installed in the
reference-implementation workspace's own `node_modules`. It SHALL NOT invoke
`npx`, a globally installed binary, or any network-resolved package manager
fallback.

#### Scenario: Workspace has no local Biome install

**WHEN** `node_modules/.bin/biome` does not exist under the
reference-implementation package
**THEN** the measurement SHALL fail closed with an explicit error
**AND** it SHALL NOT fall back to a global or `npx`-resolved binary
**AND** it SHALL NOT report a measured result.

### Requirement: The complexity mass ratchet SHALL verify the resolved Biome version against the pinned dependency

Before measuring, the tooling SHALL compare the resolved Biome binary's
reported version against the `@biomejs/biome` version declared in
`reference-implementation/package.json`.

#### Scenario: Resolved binary version does not match the pinned dependency

**WHEN** the resolved Biome binary reports a version different from the
declared workspace dependency version
**THEN** the measurement SHALL fail closed with an explicit version-mismatch
error
**AND** it SHALL NOT report a measured result.

### Requirement: The complexity mass ratchet SHALL account for every reported error diagnostic, not only parseable complexity ones

The tooling SHALL parse Biome's `--reporter=json` output and SHALL treat
every `severity: "error"` diagnostic as mass-relevant. It SHALL fail closed
if any error diagnostic is outside the configured complexity category, is
missing a parseable complexity score, or if the number of diagnostics it
successfully parsed does not exactly equal the report's `summary.errors`
count.

#### Scenario: Unparseable JSON output

**WHEN** the Biome process output cannot be parsed as JSON, or lacks the
expected `summary`/`diagnostics` shape
**THEN** the measurement SHALL fail closed and SHALL NOT report a result.

#### Scenario: A non-complexity error diagnostic is mixed with a real complexity finding

**WHEN** the diagnostics include one error in the configured complexity
category with a parseable score
**AND** the diagnostics also include an error of any other category (for
example a parse or configuration error)
**THEN** the measurement SHALL fail closed instead of reporting the mass
from only the parseable complexity diagnostic.

#### Scenario: Parsed error count disagrees with the reported summary count

**WHEN** the number of diagnostics this tooling successfully parses as
complexity errors does not equal `summary.errors`
**THEN** the measurement SHALL fail closed instead of trusting a
partially-parsed report.

#### Scenario: A true zero-diagnostic clean run

**WHEN** `summary.errors` is `0` and `diagnostics` is empty
**THEN** the measurement SHALL report the true zero-mass result.

### Requirement: The complexity mass ratchet SHALL cross-check the Biome process exit status against its reported diagnostics

The tooling SHALL NOT trust the process exit status or the parsed
diagnostics alone. A signal termination or an exit status greater than `1`
SHALL fail closed. An exit status of `0` SHALL require a parsed error count
of `0`. An exit status of `1` SHALL require a parsed error count greater
than `0`. Any other combination SHALL fail closed as inconsistent.

#### Scenario: Abnormal exit (signal or status greater than 1)

**WHEN** the Biome process is terminated by a signal or exits with a status
greater than `1`
**THEN** the measurement SHALL fail closed regardless of what its output
contains.

#### Scenario: Exit status and reported error count disagree

**WHEN** the process exits `0` but the parsed report claims a nonzero error
count, or exits `1` but the parsed report claims zero errors
**THEN** the measurement SHALL fail closed instead of trusting either
signal alone.

### Requirement: The mass baseline SHALL bind a toolchain fingerprint and fail closed on mismatch

`mass-baseline.json` SHALL record the Biome version and
`MAX_ALLOWED_COMPLEXITY` value used to produce it. The ratchet check SHALL
compare this recorded fingerprint against the currently resolved
toolchain's fingerprint before comparing or auto-tightening any file entry.

#### Scenario: Baseline fingerprint matches the current toolchain

**WHEN** the baseline's recorded Biome version and
`MAX_ALLOWED_COMPLEXITY` match the currently resolved toolchain
**THEN** the ratchet SHALL compare measured mass against the baseline per
file
**AND** it SHALL auto-tighten entries whose measured mass is below the
baseline as before.

#### Scenario: Baseline fingerprint does not match the current toolchain

**WHEN** the baseline's recorded fingerprint does not match the currently
resolved toolchain's fingerprint
**THEN** the ratchet SHALL fail closed with an explicit message directing
the operator to regenerate the baseline
**AND** it SHALL NOT auto-tighten or silently pass any file entry.

### Requirement: The mass baseline SHALL be regenerable in full under the pinned toolchain

The tooling SHALL provide an explicit command that remeasures every file
under `TARGET_ROOTS` using the verified toolchain and rewrites
`mass-baseline.json` in full, including the fingerprint metadata. This
command SHALL be the only sanctioned way to intentionally widen or
re-baseline mass values outside of per-file auto-tightening during a
passing check.

#### Scenario: Operator regenerates the baseline after a toolchain bump

**WHEN** an operator runs the baseline regeneration command after Biome or
`MAX_ALLOWED_COMPLEXITY` changes
**THEN** every file under `TARGET_ROOTS` SHALL be remeasured
**AND** `mass-baseline.json` SHALL be rewritten with the new values and the
new fingerprint
**AND** no file SHALL be hand-picked or left unmeasured.
