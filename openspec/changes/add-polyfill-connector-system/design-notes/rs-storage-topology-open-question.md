# Open question: RS storage topology — one DB or many?

**Status:** open
**Raised:** 2026-04-19
**Context:** while running Claude Code + Codex ingests in parallel today, we hit `SQLITE_BUSY` during orchestrator startup because two embedded servers tried to initialize the same sqlite file. The quick fix was to give Codex its own DB via `PDPP_DB_PATH`. That split is now real but was never intentional.

The question: is one-DB-per-owner a PDPP spec requirement, a reference-implementation convention, or an incidental choice?

## What the spec actually requires

Reading `spec-core.md` and `spec-data-query-api.md`:

- An RS is an abstraction that exposes `/v1/streams/<stream>/records` and `/v1/state/<connector_id>` under an owner token.
- The spec says records are "addressable per stream" but is silent on physical topology.
- There's no language mandating a single relational store, single file, or single process.
- Grants reference `connector_id` + `stream` + resources — the join key is logical, not physical.

**Tentative conclusion:** the spec is silent on topology. Physical layout is an implementation concern as long as the query contract is unified under the owner token.

## What today's reference does

- `reference-implementation/server/db.js` opens a single sqlite file.
- All connectors registered against that server write into `records` and `spine_events` tables.
- The embedded server used by `orchestrate.js` was hard-wired to the same path until today's `PDPP_DB_PATH` flag.

## Two topologies we could commit to

### Topology A — unified store, per-owner

**Shape:** one DB file (or schema) per owner. All connectors write into the same `records` table, namespaced by `connector_id`. Today's default.

- ✅ Cross-connector query over `/v1/streams/<stream>` is native — UNION across connectors happens in SQL, not orchestration.
- ✅ Matches the spec's mental model: one RS exposes the owner's data.
- ✅ Single place for indexes, migrations, backups, retention policy.
- ✅ Grant enforcement stays in one ACL surface.
- ❌ Concurrent writers contend (today's bug). Mitigated by WAL mode + careful batch sizing but doesn't disappear.
- ❌ Blast radius: corruption or accidental `DROP TABLE records` wipes everything.
- ❌ Per-connector teardown is a DELETE query, not a file removal — harder to prove complete erasure to an auditor.

### Topology B — partitioned store, per-connector

**Shape:** one DB file per `(owner, connector_id)`. The RS service federates across them at query time (UNION over attached DBs, or a router in application code).

- ✅ Parallel ingest is a non-issue.
- ✅ Per-connector revocation = drop the file. Easy disclosure story: "here is the physical artifact containing only Amazon data."
- ✅ Per-connector portability: move one DB between owners or migrate it to a different backend without untangling.
- ✅ Corruption blast radius is contained to one connector.
- ❌ Query federation is now the runtime's problem. Simple cases (UNION) are easy; complex filters + pagination across attached DBs are not.
- ❌ Schema drift if migrations don't run uniformly.
- ❌ Grant enforcement must apply consistently across N stores — one missed ACL check per topology, not per table.
- ❌ Harder to explain to a spec reviewer: "where does the data live?" has N answers.

### Topology C — one logical store, multiple physical engines

**Shape:** spec-facing query surface is unified; storage backend is pluggable (single sqlite, per-connector sqlite, postgres, or cloud KV). The reference ships the simplest (A). Others are conformant as long as they expose the same HTTP surface.

- ✅ Spec stays silent on physical topology (matches current spec language).
- ✅ Reference implementation picks A for simplicity. Production implementers (Vercel-hosted PDPP, self-hosted at scale) pick whatever fits their ops story.
- ❌ Requires nothing from us *except* discipline: never leak physical topology into spec examples or test harnesses. Today's `PDPP_DB_PATH` hack is fine; a spec example that assumes a single file would not be.

## Candidate direction (to review, not decided)

**C + A-default.** State in the spec that RS topology is implementation-private; reference implementation uses topology A; polyfill-connectors package uses A for all connectors normally, with B-style splitting reserved for explicit parallel-bootstrap cases (today's Codex) that will later merge.

Add a "disclosure requirement" note: if an implementer uses topology B, they SHALL document how per-connector data is aggregated under the owner token so auditors can reason about the scope of a grant.

## Open sub-questions

1. **Does the Resource Server need to be addressable per-connector for disclosure artifacts?** If an auditor asks "show me everything the owner has stored from Amazon," topology B answers by handing over `amazon.sqlite`. Topology A requires a filtered export. The spec's disclosure-artifact language doesn't say which.
2. **Is the spine events log part of the RS or orthogonal to it?** Today it's in the same DB. Under topology B, does each connector get its own spine log, or is spine centralized? Governance says spine is the one audit surface — that argues for centralized spine even under B.
3. **Performance floor:** at what volume does A become untenable? the owner's Claude Code alone might be ~1 GB. Across 28 connectors, ~5–10 GB is plausible. SQLite is fine at that scale; Postgres is trivially fine. The question is more about concurrent writers than size.

## Action items (paused, awaiting direction)

- [ ] Read `spec-core.md` + `spec-data-query-api.md` for any language that implicitly assumes single-file topology; if found, either relax it or make it explicit.
- [ ] Draft a spec note: "RS physical topology is implementation-private. Implementers SHOULD document their topology in their implementer statement."
- [ ] Decide whether today's Codex-DB split is a bug to fix (merge on completion) or a pattern to promote (keep, formalize).
- [ ] If formalized, add a runtime pattern for per-connector DBs with spine centralization.

## Cross-reference

Related open question: `connector-configuration-open-question.md` — both are about where implementation choices bleed into spec surface, and both should be answered together if a spec RFC emerges.
