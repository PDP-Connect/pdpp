## Purpose

Provide bounded, replayable evidence that PDPP tests detect plausible faults without turning mutation counts or scores into quality gates.

## ADDED Requirements

### Requirement: Mutation work SHALL be declared as a validated packet

Each run SHALL accept a machine-readable packet that identifies the repository revision, risk being tested, mutation target and change, generator provenance, selected test authority, relevant backstop, resource budget, and forbidden execution profiles. The service SHALL reject incomplete, malformed, or revision-mismatched packets before changing source files.

#### Scenario: Valid packet is accepted
- **WHEN** a packet identifies a clean matching revision, a concrete mutation, accounted tests, a backstop, and finite budgets
- **THEN** the service SHALL accept it for execution

#### Scenario: Packet does not match the checkout
- **WHEN** the packet's revision or target content does not match the checkout
- **THEN** the service SHALL reject it without applying the mutation

### Requirement: Mutation execution SHALL establish a passing baseline

The service SHALL run the packet's selected tests against the unmodified revision before applying the mutation. It SHALL NOT classify a mutant as killed or survived unless the baseline passes under the same declared execution conditions.

#### Scenario: Baseline fails
- **WHEN** any selected baseline test fails, times out, or cannot run
- **THEN** the service SHALL stop that trial and classify it as an execution error rather than a mutation result

### Requirement: Mutation execution SHALL be isolated and reversible

The service SHALL apply each mutation in isolation, SHALL prevent mutation trials from overlapping beyond the declared resource budget, and SHALL restore the checkout to its exact pre-trial state before another trial or successful exit. A cleanup failure SHALL be visible and SHALL prevent subsequent trials in that checkout.

#### Scenario: Mutant is exercised
- **WHEN** the service applies a mutation and runs its selected tests
- **THEN** no other packet's source mutation SHALL be present in that trial

#### Scenario: Trial is interrupted
- **WHEN** a trial exits by failure, timeout, or handled termination
- **THEN** the service SHALL attempt restoration and SHALL verify the pre-trial tree identity before permitting more work

### Requirement: Outcomes SHALL preserve uncertainty

The service SHALL distinguish at least killed, survived, not exercised, timeout, execution error, equivalent-suspect, and uninteresting outcomes. Equivalent-suspect and uninteresting SHALL require recorded triage and SHALL NOT be inferred only from a passing test run.

#### Scenario: Selected test detects the mutation
- **WHEN** the clean baseline passes and an otherwise valid selected test fails because the mutation is present
- **THEN** the service SHALL classify the mutant as killed and record the detecting test evidence

#### Scenario: Selected tests stay green
- **WHEN** the clean baseline passes and all selected tests pass with the mutation present
- **THEN** the service SHALL classify the mutant as survived unless independent evidence supports a more specific classification

#### Scenario: Mutation target is not exercised
- **WHEN** available execution evidence shows that no selected test reaches the mutated behavior
- **THEN** the service SHALL classify the mutant as not exercised rather than survived

### Requirement: Every trial SHALL emit a verifiable receipt

The service SHALL emit a machine-readable receipt bound to the packet, repository revision, pre- and post-restoration tree identity, exact effective commands, environment profile, mutant identity, observed outcomes, timestamps, duration, exit status, and captured diagnostic output. Receipt validation SHALL reject missing or inconsistent evidence.

#### Scenario: Receipt is replayed
- **WHEN** a reviewer validates a receipt against its packet and repository revision
- **THEN** the reviewer SHALL be able to identify the exact mutation, tests, budgets, result, and cleanup proof without trusting prose

#### Scenario: Receipt is altered
- **WHEN** a bound packet field, command, result, mutant identity, or tree identity is changed after issue
- **THEN** receipt validation SHALL fail

### Requirement: Test selection SHALL respect executable accounting

Selected tests and backstops SHALL resolve through the repository's executable test-accounting authority or an explicitly declared, validated mutation-oracle command. The service SHALL record why each selected test is relevant and SHALL NOT treat static imports alone as complete dependency evidence.

#### Scenario: Accounted focused tests and backstop are declared
- **WHEN** a packet selects a focused test set for fast feedback
- **THEN** it SHALL also identify the relevant accounted package, suite, or control-lane backstop used to measure selection misses

#### Scenario: Unaccounted side lane is requested
- **WHEN** a packet names an executable test that is neither accounted nor an approved mutation oracle
- **THEN** the service SHALL reject the packet

### Requirement: Mutation runs SHALL obey explicit safety and resource bounds

Each packet SHALL declare finite wall-time, trial-count, process-concurrency, and cleanup bounds. Local execution SHALL cooperate with the repository's local test-resource controls. Live third-party services, personal data, production credentials, and stateful browser profiles SHALL be forbidden unless a later capability defines an isolated mutation profile for them.

#### Scenario: Budget is exhausted
- **WHEN** a packet reaches a declared time, trial, or process limit
- **THEN** the service SHALL stop new work, restore the checkout, and report a bounded outcome

#### Scenario: Packet requests a forbidden profile
- **WHEN** a packet requires live credentials, personal data, or an undeclared stateful external profile
- **THEN** the service SHALL reject it before mutation execution

### Requirement: Mutation evidence SHALL remain advisory until calibrated

Initial mutation execution SHALL report evidence without enforcing a repository-wide score or adequacy threshold. A later blocking rule SHALL identify a narrow risk class, a stable operator set, an accountable backstop, observed false-positive and miss evidence, and an explicit rollback path.

#### Scenario: A survived mutant is reported during calibration
- **WHEN** an advisory run produces a survived mutant
- **THEN** the service SHALL nominate it for triage and SHALL NOT automatically fail unrelated changes or require a new test

#### Scenario: A test is proposed for deletion
- **WHEN** mutation evidence shows that another test kills the same sampled mutants
- **THEN** that evidence alone SHALL NOT authorize deletion because the test may protect a different behavior or fault class
