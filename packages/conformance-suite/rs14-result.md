# RS-14 owner-metadata completeness: review-repair result

Follow-up to the RS-14 case added in `062e5060e3`, closing the review gaps in
`local/conformance-fleet-0917/rs14-review-fixes.md`.

## 1. Nonempty capability checks replaced with content comparison

`declaredCapabilityMissing` (presence/count only) is replaced by
`declaredCapabilityMismatch` (`src/tests/resource-server.ts`), which compares
the exposed `views`/`relationships`/`query` value against the fixture's own
`expectedOwnerMetadata` by structural (JSON) equality, plus a new
`corruptedSchemaFields` check that compares each declared field's JSON Schema
`type` against what the response exposes (schema field presence was already
checked; content was not).

**Stated limit** (also in-code): this is a small, explicit equality check on
the exact shapes this suite's fixtures produce, not a general
schema-equivalence framework. It does not canonicalize key order, does not do
partial/subset matching, and a target whose adapter populated
`expectedOwnerMetadata` from a source using a differently-shaped-but-equivalent
representation of the same capability would be reported as a mismatch. That is
acceptable for v0.1: both fixtures in this suite (the in-process reference and
the Vana adapter) emit one fixed shape per category.

## 2. Independent mutant proof, one category at a time

`reference-server.ts` gained per-category defects, each corrupting exactly one
thing and leaving the rest of the document (including schema field presence)
intact, so no defect can pass by accident of a different check:

| Defect | What it changes |
| --- | --- |
| `corrupt-owner-schema-field-type` | Changes one field's declared `type`; every field name still present |
| `omit-owner-views` | Drops `views` to `[]` |
| `corrupt-owner-views` | Keeps `views` present but with the wrong `fields` |
| `omit-owner-relationships` | Drops `relationships` to `[]` |
| `corrupt-owner-relationships` | Keeps `relationships` present but points `target_stream` at the wrong stream |
| `omit-owner-query` | Drops `query` to `{}` |
| `corrupt-owner-query` | Keeps `query.range_filters` present but with the wrong operator |

`truncate-owner-metadata` (pre-existing) proves schema-truncation-plus-drop-
everything; the new defects prove the categories independently of it and of
each other. `oracle-discrimination.test.ts` gained one matrix row per defect,
each asserting pass-clean / fail-with-defect / non-empty-failure-detail.

The reference fixture (`reference-adapter.ts`) previously declared
`relationships: []` always, which made a relationship-corruption or
relationship-omission proof impossible (nothing to omit or corrupt). The
`conversations` fixture now declares a real relationship
(`conversation_messages` → `messages`, `has_many`) and both fixtures carry
`fieldTypes`, so `expectedOwnerMetadata` genuinely exercises schema content,
views, relationships, and query in the clean run.

All 44 suite self-tests pass, including 8 RS-14 discrimination rows (1
pre-existing + 7 new).

## 3. Vana adapter wiring and real-target run

`targets/vana-personal-server.json` streams now carry `expectedOwnerMetadata`
populated from `scripts/vana-target.sh`'s boot declaration (the authoritative
source — the declaration embedded in `write_boot_file`), not from the endpoint
under test:

- `schemaFieldTypes` for both streams matches the boot declaration's JSON
  Schema (`id`/`name`/`source_updated_at`: string, `genres`: array; and
  `id`/`title`/`artist`/`source_updated_at`: string for `saved_tracks`).
- `query`, `views`, `relationships` are left **absent**, not invented: the
  boot declaration's stream entries declare none of the three (no
  `query.range_filters`, no `views`, no `relationships` block), consistent
  with `capabilities.views: false` in the same config. RS-14 against this
  target therefore checks schema completeness and schema content only.

**Ran against real Vana `def4ff7`** (`waspflow/pdpp-integrated-journey-0917`),
composed via `scripts/vana-target.sh` against the clean worktree
`/home/tnunamak/.tmp/vana-ps-0917` (the tracked checkout at
`/home/tnunamak/code/personal-server-ts` had 131 uncommitted/conflicted files
from unrelated in-progress work and was left untouched):

```
RS-14 | resource-server | must | PASS | #stream-metadata
```

Full run: 21/21 tested requirements passed, 0 failures, 63.6% coverage
(unchanged gaps are pre-existing and out of scope for this increment — see
"Not tested" in the run's own report). The owned target process was stopped
after the run.

## 4. Checks on the whole diff

- `pnpm typecheck`: clean.
- `pnpm test` (oracle self-tests): 44/44 pass.
- `pnpm check` (lint): 2 pre-existing errors remain, unrelated to this diff
  and predating this commit — `reference-server.ts`'s `handle` method
  (cognitive complexity 46, introduced by an earlier PR, not touched here
  beyond adding an unrelated private method later in the same class) and
  `vana-ps-adapter.ts`'s `foreignSubjectOwnerToken` (`useAwait`, pre-existing).
  Confirmed pre-existing by re-running `pnpm check` against this worktree with
  this increment's changes set aside. This increment's own new code
  (`streamMetadata` and helpers) introduced a transient complexity violation
  (25 > 20) during development, fixed by extracting the four per-category
  computations (`schemaProperties`, `viewsCapability`,
  `relationshipsCapability`, `queryCapability`) into small private methods;
  `pnpm check` is clean on all lines this increment touches.
