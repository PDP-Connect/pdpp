## ADDED Requirements

### Requirement: A checkpoint claim SHALL be optional, and its absence SHALL mean commit_on_success

A connector `STATE` message MAY carry a `checkpoint_claim`. A connector that
emits no claim SHALL retain `commit_on_success` behavior unchanged: its staged
cursor SHALL be committed only when the run reaches a terminal status that
already permits commit.

The runtime SHALL NOT require a claim from any connector, and SHALL NOT
maintain a per-connector allowlist of connectors permitted to claim. Eligibility
SHALL be carried by the claim itself, so a connector qualifies or fails to
qualify by what it can express, not by enumeration.

Fleet-wide adoption SHALL NOT be treated as a goal. A connector whose runs are
short enough that redoing one is acceptable recovery MAY correctly never emit a
claim.

#### Scenario: A silent connector keeps today's behavior

- **WHEN** a connector emits a `STATE` message with no `checkpoint_claim`
- **THEN** the runtime SHALL stage the cursor
- **AND** it SHALL NOT commit that cursor before the run reaches a terminal
  status that already permits commit

#### Scenario: Qualification is not an allowlist

- **WHEN** the runtime evaluates whether a checkpoint may be committed
  incrementally
- **THEN** the decision SHALL depend only on the claim and on facts the runtime
  itself recorded
- **AND** it SHALL NOT depend on the connector's name or version

### Requirement: A checkpoint claim SHALL declare an identifier space with an epoch

A `checkpoint_claim` SHALL name the identifier space its positions belong to,
and that name SHALL incorporate an epoch that changes whenever the provider
re-seeds the space.

The runtime SHALL compare a claim's space to the stored space by equality
alone. When they differ, the runtime SHALL stage the cursor only, SHALL discard
the prior position, and SHALL NOT interpret positions from one epoch as
comparable to positions from another.

The runtime SHALL NOT require any provider-specific knowledge to perform this
comparison.

#### Scenario: A re-seeded identifier space invalidates the prior position

- **WHEN** a claim declares a space that differs from the stored space
- **THEN** the runtime SHALL NOT commit the claimed position
- **AND** the prior position SHALL be discarded rather than compared

#### Scenario: A matching space permits comparison

- **WHEN** a claim declares a space equal to the stored space
- **THEN** the claim's positions SHALL be treated as comparable to the stored
  position

### Requirement: A checkpoint claim SHALL represent coverage as intervals, with debt derived from the gaps

A `checkpoint_claim` SHALL express what it has accounted for as a set of
covered intervals over its declared space. Outstanding debt SHALL be derived as
the complement of the covered set within that space, and SHALL NOT be declared
as a separate field.

A claim SHALL NOT carry both a coverage assertion and an independently declared
debt assertion, because two fields describing one fact can disagree and the
runtime cannot adjudicate between them.

An empty covered set SHALL be a valid claim asserting that nothing is yet
accounted for. Omitting the covered set entirely SHALL be rejected as
malformed; the two SHALL NOT be treated as equivalent.

This requirement SHALL constrain the representation only. It SHALL NOT mandate
any storage, compaction, or interval-merge strategy, so that such a layer may
be added later without changing the claim's meaning.

#### Scenario: A newest-first walk states a truthful partial claim

- **WHEN** a connector walking newest-first has accounted for only the newest
  part of its space
- **THEN** it MAY claim exactly that part as covered
- **AND** the remainder SHALL be treated as outstanding debt without being
  separately declared

#### Scenario: A two-pointer connector needs no special case

- **WHEN** a connector maintains both a forward watermark and a backfill floor
- **THEN** it SHALL express that state as two covered intervals separated by a
  gap

#### Scenario: An omitted covered set is malformed

- **WHEN** a claim omits its covered set entirely
- **THEN** the runtime SHALL reject the claim as malformed
- **AND** it SHALL NOT treat the claim as asserting empty coverage

### Requirement: A checkpoint claim SHALL declare its granularity, and a coarse claim SHALL cover whole units

A `checkpoint_claim` SHALL declare the granularity at which its interval
endpoints are positions. A claim MAY declare a granularity coarser than the
provider's own sort order when a finer position is not expressible from the
connector's cursor.

A coarse-granularity interval SHALL assert that every item in every unit it
covers has been accounted for. It SHALL NOT assert anything about ordering
within a unit, and SHALL NOT be required to.

A unit SHALL be claimed only when the connector can prove that unit closed. A
unit that may still receive items the connector has not seen SHALL NOT be
claimed, regardless of how many of its items have been accounted for.

Coarsening granularity SHALL NOT weaken what a claim asserts. A coarser unit
SHALL require completeness to be proven over a wider range, so it SHALL be
harder to earn than a finer one, not easier.

#### Scenario: A coarse claim is truthful when the unit is closed

- **WHEN** a connector's cursor cannot express a position finer than a whole
  unit
- **AND** it can prove every item in that unit was accounted for
- **THEN** it MAY claim that unit as covered at that granularity

#### Scenario: The open unit at the frontier is not claimed

- **WHEN** a connector walking in one direction has reached a unit but cannot
  prove it has passed every item in that unit
- **THEN** it SHALL NOT claim that unit
- **AND** it MAY claim only units it has provably passed

#### Scenario: An unattributable omission withholds the claim

- **WHEN** a connector enumerated an item but could not determine which unit it
  belongs to
- **THEN** it SHALL NOT emit a claim covering any unit for that run
- **AND** the run SHALL fall back to `commit_on_success` behavior

#### Scenario: A truncated walk claims less rather than claiming falsely

- **WHEN** a walk ends early because a pagination ceiling was reached
- **THEN** the claim SHALL cover only the units actually traversed
- **AND** the untraversed remainder SHALL remain outstanding debt

### Requirement: The runtime SHALL check a claim against durable ingest before committing

The runtime SHALL NOT commit a claimed position on the strength of the claim
alone. A claim that advances a stream's position SHALL be committed only when
the runtime itself recorded durable ingest for that stream during the run.

A claim that advances a position with no durably ingested records for that
stream in that run SHALL be staged only.

The runtime's decision procedure SHALL be connector-agnostic and SHALL depend
only on the claim's declared fields and on facts the runtime recorded.

#### Scenario: A claim without corresponding durable ingest is not committed

- **WHEN** a claim advances a stream's position
- **AND** the runtime recorded no durable ingest for that stream during the run
- **THEN** the runtime SHALL stage the cursor without committing it

#### Scenario: A claim backed by durable ingest commits incrementally

- **WHEN** a claim is well-formed, its space matches, and the runtime recorded
  durable ingest for that stream during the run
- **THEN** the runtime SHALL commit that stream's cursor without waiting for the
  run's terminal status

### Requirement: A partition-scoped claim SHALL move only its own partition, and a global floor SHALL be inexpressible

A `checkpoint_claim` MAY declare a partition key. A partition-scoped claim SHALL
move only the position of the partition it names.

A claim that would move the position of any partition other than the one it
names SHALL be rejected as a protocol violation.

The claim schema SHALL provide no field by which a connector can assign a
position to partitions it has not enumerated. A floor inherited by unseen
partitions SHALL therefore be unrepresentable rather than merely discouraged,
because such a floor makes every item below it permanently unreachable for a
partition that was never walked.

#### Scenario: A claim cannot move a partition it does not name

- **WHEN** a partition-scoped claim would advance the position of a different
  partition
- **THEN** the runtime SHALL reject the claim as a protocol violation

#### Scenario: An unenumerated partition inherits no position

- **WHEN** a connector has not enumerated a partition
- **THEN** no claim SHALL assign that partition a position
- **AND** that partition SHALL remain fully outstanding

### Requirement: A connector whose scan has no order SHALL NOT qualify at any granularity

A connector SHALL NOT emit a `checkpoint_claim` for a stream whose items are
retrieved without an ordering over the claimed space.

A maximum taken over an arbitrary subset of items SHALL NOT be treated as the
upper bound of a covered interval. Without an ordering, items below that maximum
may never have been visited, so an interval claimed up to it asserts coverage
the connector cannot demonstrate.

Declaring a coarser granularity SHALL NOT qualify an unordered scan. A coarser
unit asserts completeness over a wider range, so coarsening an unordered scan
SHALL produce a broader false claim rather than a safer one.

Advancing a watermark only for items actually emitted SHALL NOT by itself
qualify a stream. Restricting the watermark to emitted items makes it honest
about which items were counted; it does not establish that the counted items
form a contiguous prefix of the space.

#### Scenario: An unordered scan is disqualified

- **WHEN** a stream's items are retrieved by a query with no ordering over the
  claimed space
- **THEN** that stream SHALL NOT emit a checkpoint claim
- **AND** it SHALL retain `commit_on_success` behavior

#### Scenario: Coarsening does not rescue an unordered scan

- **WHEN** an unordered stream declares a coarser claim granularity
- **THEN** it SHALL still be disqualified

#### Scenario: An emitted-only watermark does not establish a prefix

- **WHEN** a stream advances its watermark only over items it emitted, but still
  retrieves those items without an ordering
- **THEN** it SHALL remain disqualified

### Requirement: New work on the checkpoint program SHALL preserve ideal compatibility

Changes made under this program SHALL observe the following constraints, so that
later tranches compose rather than accumulating incompatible mechanisms.

New health logic SHALL NOT be derived by reading evidence projections. Health
SHALL be derived from the coverage ledger.

New implicit run-state flags SHALL NOT be introduced. Run state SHALL be
explicit and durable, and SHALL NOT be inferred from the presence or absence of
a side-channel.

New cursor shapes SHALL NOT violate the claim schema. A new cursor SHALL either
state a well-formed `checkpoint_claim` or emit no claim at all.

#### Scenario: Health is not re-derived from a projection

- **WHEN** a change introduces health logic under this program
- **THEN** that logic SHALL read the coverage ledger
- **AND** it SHALL NOT re-derive health by reading an evidence projection

#### Scenario: Run state stays explicit

- **WHEN** a change under this program needs to record that a run is in some
  state
- **THEN** it SHALL record that state explicitly and durably
- **AND** it SHALL NOT encode it as the presence or absence of an unrelated
  side-channel

#### Scenario: A new cursor either claims well-formed or stays silent

- **WHEN** a change under this program introduces a new cursor shape
- **THEN** that cursor SHALL either carry a well-formed `checkpoint_claim` or
  carry none
- **AND** it SHALL NOT introduce a third representation of checkpoint safety
