# MCP Read-Evidence Architecture Review — Findings (2026-06-22)

Durable factual findings from an architecture-blocker review of OpenSpec change
`unify-read-evidence-surface`. Scope was architecture only (MCP-only semantics,
competing semantics, field-name guessing, client-specific core leakage,
essential/incidental confusion). No code edits were made. These are findings
about the *current* repository and spec state, separate from the change's own
design assessment.

## F1 — The content ladder this change "migrates" does not exist in code

`read_record_field`, `field-window` / `fieldWindow`, and `content_ladder` /
`contentLadder` appear **zero times** in repository source or tests, only in
OpenSpec prose and `docs/research/`.

Verification (2026-06-22, repo root):

```
grep -rnE 'read_record_field|field-window|fieldWindow|content_ladder|contentLadder' \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' . \
  | grep -vE 'node_modules|/openspec/|\.test\.|\.spec\.|docs/research|/dist/|/build/'
# -> 0 matches (source)
# -> 0 matches including tests
```

The change that *defines* these primitives — `add-mcp-content-ladder` — is at
**0/28 tasks** (unstarted) per `openspec list`.

Implication: the `unify-read-evidence-surface` design speaks of the content
ladder as already shipped and asks to "migrate" it:

- `design.md:90` — "Move MCP search/fetch/query content ladder and visible card
  rendering onto shared primitives. Preserve existing tool names and **deployed
  behavior** where possible."
- `proposal.md:15` — "Migrate MCP evidence cards/content ladders to shared logic
  instead of adapter-local semantics."

There is no deployed content ladder to migrate. The two changes are
build-then-unify, not unify-an-existing-thing, and that ordering is not declared
as a hard gate in either change.

## F2 — Source research overstates current MCP surface as fact

`docs/research/mcp-read-surface-slvp-assessment-2026-06-22.md` lists, under
"**MCP currently exposes**": `read_record_field`, `pdpp://record/{handle}`, and
`pdpp://field-window/{handle}` resources; and states "MCP **now** exposes
binary/blob fields as metadata-only with continuation handles." Per F1, none of
these are in the code. These assessment statements describe the *proposed*
(`add-mcp-content-ladder`) surface as if it were the *current* one. Anyone
planning the `unify` work from that research will mis-scope the baseline.

## F3 — RIA already mandates the shared-substrate architecture (alignment, not conflict)

`openspec/specs/reference-implementation-architecture/spec.md` already contains
the read-surface architecture this change restates:

- **Req "Public read semantics SHALL be operation-owned and adapter-shared"**
  (~L7505): read semantics live in "canonical resource-server operations or
  shared pure read-surface transforms"; "Adapters SHALL own only transport
  concerns: authentication lookup, argument parsing/serialization, protocol
  input-schema validation, and **presentation**."
- **Req "Read-surface parity SHALL be verified across REST, MCP, and CLI"**
  (~L7555): a parity regression gate already exists; "Transport-specific
  assertions SHALL remain isolated."
- **Req "MCP read tools SHALL mirror the canonical public read contract"**
  (~L7577): "MCP-only presentation wrappers... SHALL NOT define a separate
  record-detail semantic contract."
- **Req "Schema source scoping SHALL be transport-invariant"** (~L7531).

Consequence: `unify-read-evidence-surface` is **additive and consistent** with
the standing architecture, not a competing model. Its concept-ownership table
(RS / shared read-evidence / adapters) is the same decomposition the RIA spec
already requires. This is the central reason the change has no fundamental
architectural blocker.

## F4 — Real semantic tension: `content[]` "summary only" vs. `content[]` "self-sufficient"

Standing RIA contract (~L7583): "For canonical structured read tools,
`structuredContent` SHALL carry the canonical operation body and prose
`content[]` SHALL be **a concise summary only**."

The change pushes `content[]` toward carrying enough standalone evidence +
continuation when `structuredContent` is hidden:

- `design.md` Invariant 5 (Tool fallback) and the mcp-adapter scenario "Host
  hides structured content" — results "SHALL still include enough bounded
  evidence and continuation instructions... AND SHALL NOT require
  `structuredContent` as the only path to record identity or continuation."

These are reconcilable (a "concise summary" can still name identity + the next
call), but they are not identical framings. The unify spec delta does not
explicitly reconcile its "content[] is sufficient on its own" requirement with
the RIA "content[] is summary only" requirement. Left unstated, an implementer
can satisfy one and regress the other. This is a wording-reconciliation item,
not a structural blocker.

## F5 — `field-window` is not yet a canonicalized RS requirement

The research and the change both assert RS owns field-window reads
("`GET /v1/streams/{stream}/records/{id}/field-window`"). That route does not
appear in the RIA spec (no `field-window` match in 838KB), and does not appear
in code (F1). So "RS owns field-window" is a *design intent* in this change
family, not yet an enforced canonical requirement. CLI parity (Slice 2) and the
RS endpoint must land in `add-mcp-content-ladder` (or be promoted into RIA)
before the unify parity gate can mean anything.

## Net architectural read

No fundamental architectural blocker in the **target** design: it conforms to
the RIA's existing operation-owned/adapter-shared mandate, keeps RS as
authorization+query authority, scopes client quirks to an Incidental Complexity
Ledger at adapter boundaries, and forbids field-name guessing (Invariant 3 /
mcp-adapter "Manifest roles determine presentation" scenario) consistent with
the deployed `x_pdpp_role` discipline.

The blockers are **sequencing and baseline-accuracy**, not architecture:
the change describes an as-built content ladder that is unbuilt (F1/F2),
depends on an unstarted change without declaring the dependency as a gate (F1),
relies on an un-canonicalized RS field-window route (F5), and leaves one
`content[]` semantics wording unreconciled with standing RIA text (F4).

## Sources

- `openspec/changes/unify-read-evidence-surface/{proposal,design,tasks}.md` and
  `specs/{mcp-adapter,reference-implementation-architecture}/spec.md`
- `openspec/changes/add-mcp-content-ladder/{proposal,design}.md`
- `openspec/specs/reference-implementation-architecture/spec.md`
  (Reqs ~L188-216, ~L7505-7600)
- `openspec/specs/mcp-adapter/spec.md`
- `docs/research/mcp-read-surface-slvp-assessment-2026-06-22.md`,
  `docs/research/mcp-client-read-surface-findings-2026-06-22.md`
- `openspec list`; repo-wide grep (2026-06-22)
