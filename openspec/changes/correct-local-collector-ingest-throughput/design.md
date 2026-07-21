# Context

The load-bearing boundary is one authoritative record transaction followed by
derived lexical/semantic maintenance. The old device route hides that boundary
inside serial `ingestRecord` calls, making retries unsafe after derived failure.

# Decisions

1. A server-verified SHA-256 of canonical raw `records` JSON, or the exactly
   reconstructable full-envelope representation emitted by the shipped durable
   collector, together with device, source, instance, connector, and sequence
   facts, is the immutable reservation identity. The verified supplied hash is
   retained, so changing hash representation for an existing batch conflicts.
   Canonical records are the reserved durability representation, avoiding
   SQLite string-equality versus Postgres JSONB drift.
   One request-builder seam owns full-envelope hashing plus wire projection for
   every shipped sender, and its request is exercised against the server route.
2. The durable reservation is `absent -> processing -> accepted`. Every
   device-record transaction verifies the reservation and atomically advances
   its monotonic input cursor. `accepted` stores the exact replay response and
   can only occur after complete prefix, required index repair, and a
   manifest/capability generation fence.
3. The record layer exposes one durable seam and one derived seam. The durable
   seam retains its existing outcome shape; the route owns duplicate-key final
   planning and the authoritative reread/derived repair needed only for skipped
   retry keys. A fresh suffix input that is an anchored durable no-op repairs its
   manifest-derived durable columns inside the same record/prefix transaction,
   without an authoritative reread or version allocation. It retains current
   Postgres retained-size/disclosure dirty-repair timing and existing general
   `ingestRecord` behavior. Device orchestration does not duplicate record SQL.
4. One opaque, re-entrant connector-instance ownership capability serializes
   every current authoritative or lexical/semantic writer. SQLite is explicitly
   one process; Postgres uses one domain-separated advisory key and a dedicated
   capped lock pool. Backfills process one instance at a time.
5. Global bounded admission and index permits prevent request-multiplied work.
   Only a compute-only child owns local transformer execution; return values
   are identity-fenced before the main process applies indexes. Deadline,
   TERM, KILL, confirmation, and process fail-stop are distinct states.

# Rejected alternatives

- `Promise.all`, a larger client timeout, or lower batch size do not preserve
  ordered durable semantics or completion acknowledgement.
- A route-local lock misses owner writes and backfills; version-fenced index
  writes are a broader future design.
- A batch transaction holds storage resources across embedding work.
- A `Promise.race` timeout leaves zombie computation capable of later writes.
- A transactional notification outbox and broad projection transaction change
  are valuable separate work, not this correction.

# Verification strategy

The task receipt records strict OpenSpec validation, tests on SQLite and the
dedicated real Postgres URL, direct table assertions, privacy sentinels, bounded
admission/lock lifecycle cases, and a real 100-record transformer benchmark at
1/2/4/8. Missing an oracle is reported rather than treated as success.
