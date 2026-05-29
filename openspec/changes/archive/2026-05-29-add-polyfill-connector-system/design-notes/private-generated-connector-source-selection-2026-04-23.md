# Private Generated Connector Pilot Source Selection — 2026-04-23

**Status:** owner recommendation (project-scoped, non-normative)  
**Purpose:** choose the right kind of source for the first
`generated/private` pilot.

**Depends on:**

- `agent-generated-custom-connectors-open-question-2026-04-23.md`
- `private-generated-connector-pilot-brief-2026-04-23.md`
- `pdpp-trust-model-framing.md`

## Question

What source shape gives the first `generated/private` connector pilot the best
chance of producing evidence instead of noise?

This note is not choosing a specific product yet. It is choosing the **selection
criteria** and the default owner posture for that choice.

## Recommendation

Choose a source that is:

- **personally valuable**
- **single-surface**
- **snapshot-like or append-only**
- **easy to verify before extraction**
- **rich enough to feel real**
- **simple enough that failure teaches us something local**

That points toward a first pilot that looks more like:

- a history list
- a transaction/activity table
- a saved-items/archive list
- a personal ledger or exports page

and less like:

- a full inbox
- an edited/deleted chat product
- a highly relational productivity workspace
- a source that requires heavy anti-bot heroics

## Why this matters

The first pilot is not trying to prove:

- marketplace-grade reuse
- broad source coverage
- rich mutable-state sync
- deep semantic understanding

It is trying to prove:

1. a generated/private artifact can be **PDPP-conformant**
2. it can have **honest rerun semantics**
3. a generic consumer can still **browse, page, filter, and search** the data

So the source should maximize signal on those three questions and minimize
orthogonal chaos.

## The wrong first-source traps

### 1. Mutation trap

Sources with frequent edits, deletes, merges, or thread reshaping make it too
easy to confuse:

- bad connector generation
- bad incremental semantics
- source mutation itself

Examples of bad first-pilot shapes:

- chat inboxes
- collaborative docs/tasks with constant edits
- issue trackers with lots of state mutation

### 2. Ontology trap

Some sources are only useful after a long modeling exercise.

That is bad for pilot one because it becomes unclear whether failure was about:

- agent authoring
- schema design
- or the connector/runtime lane itself

### 3. Anti-bot trap

If staying authenticated already requires brittle automation tricks, then
failure tells us too much about browser evasion and not enough about PDPP.

### 4. Consumer-usability trap

A source may be easy to scrape but still produce data that no generic consumer
can meaningfully use without source-specific logic.

That is also a bad pilot, because generic downstream usability is one of the
core questions we are trying to answer.

## Selection rubric

Score each candidate 1–5 on each dimension.

### A. Owner value

Would the owner actually care about keeping and querying this data later?

Good signals:

- recurring personal usefulness
- audit/history value
- likely to be queried again

### B. Stable identity

Can records get a stable key cheaply and honestly?

Best:

- source-native durable ids

Acceptable:

- obvious synthesized key from durable fields

Bad:

- no stable identity without fuzzy matching

### C. Incremental tractability

Can reruns be described honestly as either:

- append-only since checkpoint, or
- snapshot refresh of a clearly bounded surface?

Best:

- obvious "new items since X"
- or honest whole-surface snapshot semantics

### D. Verifier tractability

Can a verifier cheaply determine whether:

- the session is valid
- the right surface is loaded
- extraction should proceed

Best:

- obvious page invariant
- obvious authenticated identity cue

### E. Schema tractability

Can an agent produce a useful schema without a heroic ontology exercise?

Best:

- small number of obvious fields
- mostly flat record shape

### F. Generic-consumer usability

If the connector emits truthful schema and field metadata, can a generic
consumer do something useful with the resulting stream?

Best:

- table-like rows
- obvious sort/search fields
- naturally page-able history

### G. Collection robustness

How likely is the source to keep working without anti-bot or heavy UI drift
dominating the experiment?

Best:

- stable, boring web surface
- simple auth/session flow

### H. Semantic pressure

Does the source create a legitimate future need for semantic retrieval without
making semantic retrieval a prerequisite for pilot success?

Best:

- lexical retrieval is enough to make the data usable
- semantic retrieval would be a clear additive improvement later

## Scoring guidance

### Strong candidate

- mostly 4s and 5s
- especially strong on:
  - stable identity
  - incremental tractability
  - generic-consumer usability

### Weak candidate

- any 1 or 2 in:
  - stable identity
  - verifier tractability
  - incremental tractability

Those should usually be disqualifying for pilot one.

## Default preferred source shapes

These are the shapes I would bias toward first.

### 1. Transaction / ledger / history table

Why this is strong:

- naturally row-shaped
- stable identity often exists
- obvious append or snapshot semantics
- generic consumers understand it immediately

### 2. Saved-items / bookmarks / archive list

Why this is strong:

- simple object model
- good owner value
- easy generic browsing/search
- semantic retrieval would be additive later, not required

### 3. Account activity / audit log

Why this is strong:

- append-only shape
- explicit time ordering
- excellent fit for page/filter/search

## Default avoided source shapes

### 1. Full messaging/chat systems

Bad first pilot because:

- edits/deletes/threading complicate identity and sync
- semantic expectations rise immediately
- anti-bot/auth complexity is often higher

### 2. Deeply relational productivity tools

Bad first pilot because:

- multiple object types
- many relationships
- hard to judge whether failure was schema complexity or connector generation

### 3. Sources whose only faithful representation is documents/blobs first

Bad first pilot because:

- generic downstream usability gets murky quickly
- lexical/semantic retrieval questions overwhelm the core connector question

## Recommended owner posture

For the first pilot, optimize for:

- **boring extraction shape**
- **honest incremental semantics**
- **useful generic data**

Do **not** optimize for:

- most impressive demo
- hardest source the agent might handle
- richest semantic challenge

The first pilot should reduce uncertainty, not maximize spectacle.

## What success should look like

A winning first source is one where, after the pilot, we can honestly say:

- yes, the artifact bundle was durable enough
- yes, reruns were honest
- yes, the resulting stream was still useful to a generic consumer

even if the source itself was not glamorous.

## Consequence for the next step

Before launching the pilot, score 3–5 candidate sources against this rubric and
pick the highest-signal boring winner.

If a candidate only looks attractive because it is impressive or AI-demo-friendly,
that is a reason to distrust it for pilot one.
