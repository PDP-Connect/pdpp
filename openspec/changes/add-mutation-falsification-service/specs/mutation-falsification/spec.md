## Purpose

Provide bounded, reviewable evidence that selected PDPP tests detect plausible trusted faults before the repository invests in shared mutation infrastructure.

## ADDED Requirements

### Requirement: Version one SHALL execute only trusted repository adapters

Version one SHALL be a local developer harness with no daemon, queue, server, or network API. It SHALL execute only reviewed, repository-owned adapter and operator identifiers with validated parameters and exact target preimages. It SHALL NOT execute caller-supplied commands, arbitrary patches, or agent-generated source.

#### Scenario: Trusted adapter is requested
- **WHEN** an intent names a registered adapter and valid checked-in operator
- **THEN** repository policy SHALL derive the effective command, environment, judge, and limits

#### Scenario: Arbitrary executable input is requested
- **WHEN** an intent supplies executable source, command arguments, working directory, environment policy, or an unregistered operator
- **THEN** the harness SHALL reject it before execution

### Requirement: Intent, attempt, and triage evidence SHALL remain separate

An intent packet SHALL record the requested risk, trusted adapter and operator descriptors, base identity, and requested budget. An attempt receipt SHALL record immutable machine observations from one execution. A triage receipt SHALL separately record a later reviewer judgment bound to one attempt. The harness SHALL derive conventional killed, survived, or inconclusive projections from valid attempt evidence and SHALL NOT accept those projections or triage dispositions from the intent.

#### Scenario: Execution completes
- **WHEN** a trusted adapter produces valid execution evidence
- **THEN** the attempt receipt SHALL preserve baseline, materialization, focused, backstop, reachability, cleanup, timeout, and error observations without adding a human judgment

#### Scenario: Reviewer classifies evidence
- **WHEN** an independent reviewer judges an attempt actionable, likely equivalent, uninteresting, deferred, or invalid
- **THEN** that judgment SHALL be appended as a separate triage receipt with reviewer claim, evidence reference, reason, and timestamp

### Requirement: Evidence identity and integrity claims SHALL be precise

Canonicalization and hash algorithms SHALL be versioned. The deterministic trial key SHALL bind the intent digest, repository tree, adapter version, policy version, and mutation identity. Each execution SHALL receive a distinct random attempt identifier. Content digests SHALL establish internal consistency or tamper evidence relative to an independently retained digest; they SHALL NOT be represented as issuer authentication.

#### Scenario: Same trial is repeated
- **WHEN** the same bound trial executes more than once
- **THEN** the attempts SHALL share a trial key and SHALL have different attempt identifiers and runtime observations

#### Scenario: Authenticated provenance is unavailable
- **WHEN** evidence is produced only on a developer-controlled host without a trusted signer or platform attestation
- **THEN** provenance SHALL be recorded as a claim and SHALL NOT be described as authenticated identity

### Requirement: The existing migration oracle SHALL retain its purpose-fit lifecycle

The test-migration oracle SHALL retain its existing named mutations, mutation-specific judges, positive control, fixture repositories, and rollback proof. Its structured mode SHALL report the same cases and decisions as its human-readable mode. This adapter SHALL validate structured evidence and crash honesty only; it SHALL NOT be presented as validation of a generic source-mutating executor.

#### Scenario: Structured mode runs successfully
- **WHEN** the existing oracle is run in structured mode
- **THEN** its named cases, catching checks, holes, positive control, and rollback decision SHALL agree with the legacy result

#### Scenario: Structured evidence is incomplete
- **WHEN** output is partial, malformed, omits a case or control, exceeds its bound, or the process is interrupted
- **THEN** the attempt SHALL remain incomplete or invalid and SHALL NOT be projected as killed or survived

### Requirement: Test-accounting authority SHALL NOT be overstated

Focused checks in the domain pilot SHALL be labeled adapter evidence, not test-accounting authority receipts. Repository-owned policy SHALL select the focused check and mandatory complete owning-suite backstop. Clean and mutant complete backstops SHALL run through the unchanged test-accounting authority on clean committed trees, and mutation evidence SHALL reference its verified receipt digests.

#### Scenario: Focused mutant check passes
- **WHEN** the focused check passes with a trusted mutant present
- **THEN** the mandatory mutant backstop SHALL run; a focused pass followed by a backstop failure SHALL be recorded as a selector miss

#### Scenario: Required backstop cannot complete
- **WHEN** a clean or mutant backstop is missing, fails its baseline, exceeds budget, or cannot issue a valid authority receipt
- **THEN** the attempt SHALL be inconclusive and SHALL NOT count as survived

### Requirement: Domain mutation attempts SHALL be one-shot and bounded

The GroupMe cursor/frontier pilot SHALL use only checked-in declarative fault operators over permitted production paths while the judge and runner closure remain immutable. Each source-mutating attempt SHALL use a fresh clean committed descendant in a disk-backed workspace. A successful workspace SHALL be deleted; an interrupted or cleanup-failed workspace SHALL be quarantined and detected on the next start.

#### Scenario: Trusted domain operator runs
- **WHEN** a registered GroupMe operator matches its exact target preimage
- **THEN** the attempt SHALL record base and mutant trees, permitted changed paths, focused and backstop evidence, environment profile, artifacts, resource observations, and cleanup state

#### Scenario: Attempt is abandoned
- **WHEN** execution ends before a complete receipt and verified cleanup
- **THEN** the issued attempt marker SHALL remain incomplete, its workspace SHALL NOT be reused, and a later run SHALL report or quarantine it

### Requirement: Local execution SHALL use enforceable bounds and honest limitations

Repository policy SHALL run one adapter at a time and SHALL set finite limits for attempts, wall time, captured output, workspace bytes, and cleanup time. It SHALL use an environment allowlist and SHALL forbid live credentials, personal data, live third-party services, stateful browsers, and shared production-like databases. CPU and memory limits SHALL be identified as hard only when the host mechanism enforces them; otherwise they SHALL be recorded as advisory observations. Unsupported required limits SHALL cause refusal rather than a portability claim.

#### Scenario: Hard limit is exceeded
- **WHEN** wall time, output, workspace, or another enforced limit is exceeded
- **THEN** execution SHALL stop or be marked interrupted, bounded evidence SHALL be retained, and the attempt SHALL be inconclusive

#### Scenario: Host cannot enforce required safety
- **WHEN** the selected adapter requires a hard control that the host does not provide
- **THEN** the harness SHALL refuse the attempt instead of silently weakening the policy

### Requirement: Calibration SHALL end with a pre-registered decision

The pilot SHALL remain advisory and SHALL publish raw counts and defined denominators for valid trials, focused-to-backstop misses, invalid faults, execution failures, cleanup failures, runtime, artifact sizes, and reviewer time. It SHALL stop or narrow on any containment or cleanup failure, unexplained selector miss, dominant setup cost, predominantly invalid or trivial faults, or lack of useful evidence within its declared budget. Shared infrastructure SHALL require a later proposal supported by repeated invariants across both adapters and measured reduction in audit cost.

#### Scenario: Pilot stays within bounds and produces useful evidence
- **WHEN** the two adapters produce interpretable evidence without cleanup failures or unexplained selector misses at acceptable compute and review cost
- **THEN** the decision memo MAY recommend a narrowly scoped shared evidence module and SHALL identify the repeated invariants it would hide

#### Scenario: Pilot does not justify generalization
- **WHEN** signal is weak, costs dominate, safety fails, or the adapters do not share a deep stable boundary
- **THEN** the decision memo SHALL stop or narrow the initiative and retain purpose-fit adapters rather than manufacturing a framework
