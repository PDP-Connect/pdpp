# MCP Read-Evidence Parity Review — Findings

Date: 2026-06-22
Scope: Local parity audit of the read/evidence surface against the OpenSpec change
`openspec/changes/unify-read-evidence-surface`.
Method: read-only inspection of shipped code; no edits.
OpenSpec status at audit time: `openspec validate unify-read-evidence-surface --strict` → **valid**.

Surfaces inspected:

- `packages/mcp-server/src/tools.js` (MCP adapter, 5 tools)
- `packages/cli/src/read/commands.js` (CLI grant-scoped reads)
- `reference-implementation/server/routes/rs-read.ts` (REST read routes)
- record/field-window read path (claimed `GET /v1/streams/{stream}/records/{id}/field-window`)
- operator-ui record preview / kind: `packages/operator-ui/src/lib/{record-kind,record-preview,record-field-format}.ts`,
  `packages/pdpp-brand/record-format.ts`

Sibling change inspected for dependency: `openspec/changes/add-mcp-content-ladder`.

---

## Ground truth of the shipped surfaces (what actually exists today)

### MCP adapter (`packages/mcp-server/src/tools.js`)

- Registered tools are exactly **five**: `schema`, `query_records`, `aggregate`, `search`, `fetch`
  (name: entries at lines 399 / 449 / 495 / 554 / 588).
- There is **no `read_record_field` tool**. Repo-wide grep for
  `read_record_field|read-record-field|readRecordField` across `packages/` and
  `reference-implementation/` returns **zero non-proposal hits**.
- There is **no `content_ladder` block**. Repo-wide grep for
  `content_ladder|contentLadder|content-ladder` returns **zero non-proposal hits**.
- Truncation is a **terminal marker**, not a continuation path. When a record preview
  exceeds the bound (`RECORD_PREVIEW_CHAR_LIMIT = 1792`), the visible `content[]` appends:
  `record_preview_truncated=true; machine envelope in structuredContent.data`
  (`summarizeRecordEnvelope`, ~line 1156). The only recovery this points at is
  `structuredContent.data` — i.e. it is *the* dead-end the content-ladder change exists to remove.
- Visible record/envelope handles emitted are `next_cursor`, `next_changes_since`, `count`
  (`formatRecordEnvelopeHandles`, ~line 1187) — pagination handles only, not per-field
  continuation.
- Resource URIs: the only `pdpp://` URI minted in shipped code is **`pdpp://record/{id}`**
  (`urlForRecord`, line 2114), used as a *fallback* when no real record URL/REST URL is
  resolvable. There is **no `pdpp://field-window/...`** URI and **no `resource_link` /
  resource-template** machinery in `tools.js`.
- Binary/blob discipline in MCP visible output: **none present**. Every `blob`/`base64`
  mention in `tools.js` concerns dropping verbose JSON-Schema blobs from the `schema`
  tool's compact projection — unrelated to record binary/attachment fields. There is no
  "metadata-only by default + export handle" rule for large binary record fields in the
  MCP adapter today.

### CLI (`packages/cli/src/read/commands.js`)

- `COMMANDS = ['schema', 'streams', 'query-records', 'fetch', 'search', 'aggregate']`.
- There is **no `field-window` command** and no per-field windowed read. CLI reads map
  1:1 onto existing REST endpoints (`/v1/schema`, `/v1/streams/:stream/records`,
  `/v1/streams/:stream/records/:id`, `/v1/search[/semantic|/hybrid]`, aggregate).

### REST (`reference-implementation/server/routes/rs-read.ts`)

- Mounted read routes: `mountRsRecordsList` (`GET /v1/streams/:stream/records`, ~1684),
  `mountRsRecordDetail` (`GET /v1/streams/:stream/records/:id`, ~1805),
  `mountRsBlobRead` (`GET /v1/blobs/:blob_id`, ~2460), plus schema/aggregate/search routes.
- There is **no field-window route**. Grep for
  `offset|window|excerpt|truncat|preview|maxLength|slice` inside this file matches only a
  `Bearer` token `.slice(7)` at line 366. No
  `GET /v1/streams/{stream}/records/{id}/field-window` endpoint exists.
- Blob handling that *does* exist: `mountRsBlobRead` serves full binary bytes for an
  authorized blob id (`Content-Type` / `Content-Length` set, `res.send(blob.data)`,
  ~2443–2451) after a per-binding visibility scan. This is a whole-blob fetch, not a
  bounded windowed read, and has no MCP-visible metadata-only projection in front of it.

### operator-ui record preview / kind

- Presentation is driven by a declared **`type`** signal, sourced from the manifest
  extension **`x_pdpp_type`** (and sandbox `fields[]` / `schema.fields[]`), surfaced on the
  public read contract as `field_capabilities[field].type`.
  - `record-kind.ts`: classifies a row into one of
    `message | money | event | activity | reader | location | titled | generic`,
    preferring the declared `type` when present and degrading to a stream/field-name
    heuristic (and to `generic`) otherwise. Explicitly presentation-only; never written
    back, never sent to the resource server.
  - `record-format.ts` (`packages/pdpp-brand`): turns the declared `type` into formatting
    (e.g. minor-units money ÷100) — `formatDeclaredAmount`, `isMonetaryDeclaredType`,
    keyed on `field_capabilities[field].type`. Undeclared fields are never guessed.
  - `record-preview.ts`: kind-aware structured preview (amount / author / body /
    coordinates / excerpt) pulled only from the body already in hand.
- **`x_pdpp_role` does not exist anywhere in the source tree.** Grep for
  `x_pdpp_role | presentationRole | displayRole | PresentationRole` returns **zero hits**.
  The shipped declared-presentation vocabulary is **`type` (`x_pdpp_type`), not `role`.**

---

## Status of the capabilities the proposal treats as existing

`read_record_field`, `content_ladder`, the `field-window` read path, and
`pdpp://field-window/{handle}` resources are defined **only** in the sibling change
`openspec/changes/add-mcp-content-ladder` (its `What Changes`: "Add the generic
`read_record_field` bounded read tool…", "Add `pdpp://record/{handle}` and
`pdpp://field-window/{handle}` resource templates…"). Both changes are **un-archived /
not yet applied** (both live under `openspec/changes/`, neither under
`openspec/changes/archive/`), and **neither is implemented in code** (the grep evidence
above). So these are *proposed*, not *shipped*, capabilities.

---

## Findings against the three audit axes

### A. Does the change MISS existing capabilities? — Partly, and it also over-credits non-existent ones

1. **Over-credits unbuilt capabilities as existing.** The proposal's language assumes
   `read_record_field`, content ladders, and field-windows are deployed and merely need
   "migrating" / "keeping intact":
   - `design.md` Concept Ownership puts **"field-window reads"** under *RS / REST owns* —
     but RS implements no field-window route.
   - `mcp-adapter/spec.md` MODIFIED scenario cites a continuation "such as a fetch handle,
     `read_record_field` arguments, or a cursor" — `read_record_field` does not exist.
   - `tasks.md` 3.3 says "**Keep** `structuredContent`, `resource_link`, and
     `read_record_field` continuation paths **intact**" — there is no `read_record_field`
     and no `resource_link` path to keep.
   - `proposal.md` / `design.md` Slice 3 say "**Migrate** MCP … content ladder … onto
     shared primitives. Preserve existing tool names and deployed behavior" — there is no
     deployed content ladder to migrate.
   These are not fatal, but they make the change's scope dishonest about its baseline: it
   reads as a refactor of an existing ladder when it is in fact (a) net-new ladder work
   plus (b) a sharing refactor, with (a) actually owned by `add-mcp-content-ladder`.

2. **Misses the one genuinely-shipped presentation primitive** by not naming it. The
   live, load-bearing declared-presentation system is `x_pdpp_type` → `field_capabilities.type`
   → `record-kind.ts` / `record-format.ts`. The proposal never references `type`/`x_pdpp_type`;
   it describes a "declared-role" system that is not what shipped. A parity change that
   intends operator-ui to share semantics must bind to the primitive that exists.

3. **Misses the existing blob route as the binary continuation seam.** The proposal's
   "binary metadata-only + export/resource continuation" invariant has a natural existing
   anchor — `mountRsBlobRead` (`GET /v1/blobs/:blob_id`) — but the change does not reference
   it. Today MCP has *no* binary discipline and RS has a *whole-blob* fetch; the change
   should explicitly own "MCP renders blob fields metadata-only and points at the existing
   `/v1/blobs/:id` route" rather than implying a discipline already exists.

### B. Does the change CREATE duplicate semantics? — Yes, two concrete risks

1. **"declared-role" vs the shipped "declared-`type`" vocabulary (highest-confidence duplicate).**
   The proposal's presentation slot is "declared-role / manifest-authored display role /
   role-derived presentation" (8 occurrences across proposal/design/specs). The shipped
   primitive is declared **`type`** (`x_pdpp_type` → `field_capabilities.type`), and
   `x_pdpp_role` does not exist in the tree. Implementing the change as written would either
   (a) introduce a *second* parallel manifest vocabulary (`role`) alongside the live `type`
   vocabulary — exactly the "competing semantics for the same concept" the change's own
   Invariant 10 forbids — or (b) silently rename `type`→`role` and break every operator-ui
   consumer. Either way it manufactures duplication the codebase does not currently have.

2. **A "shared evidence layer that owns field-window continuation args" overlapping with
   `add-mcp-content-ladder`'s field-window design.** `add-mcp-content-ladder` already
   specifies the `read_record_field` input schema, the `content_ladder` block, and the
   `pdpp://field-window/{handle}` template. `unify-read-evidence-surface` independently
   lists "adapter-neutral field-window continuation arguments" and "continuation descriptors"
   as owned by its shared layer. With both changes open and unbuilt, the field-window
   continuation contract is now specified in **two** active changes. Without an explicit
   ordering, both could land overlapping/parallel definitions of the same handle.

### C. Does the change ASSIGN OWNERSHIP wrong? — Yes, two misassignments

1. **RS is assigned ownership of "field-window reads" it does not implement.** The Concept
   Ownership table lists "field-window reads" under *RS / REST owns*. RS owns record-list,
   record-detail, and whole-blob read — not a field-window endpoint. This is fine *as a
   target* but is stated as *current* ownership, and the actual creation of that endpoint is
   `add-mcp-content-ladder`'s Tier-2 work, not this change's. The ownership line should read
   as "will own (pending `add-mcp-content-ladder`)", and Slice 2 ("`pdpp read field-window`
   backed by `GET …/field-window`") cannot land until that endpoint exists — a hard
   dependency the proposal does not flag.

2. **Dependency direction between the two changes is unstated, so ownership of the ladder
   is ambiguous.** `unify-read-evidence-surface` lists `add-mcp-content-ladder` only as
   *source material*, and its Slice 3 says "migrate … content ladder … Preserve existing …
   deployed behavior." But there is no deployed ladder; `add-mcp-content-ladder` is the
   change that builds it. The correct ownership is: **`add-mcp-content-ladder` builds the
   ladder + `read_record_field` + field-window endpoint + resources; `unify-…` then extracts
   the shared layer and brings CLI/REST/operator-ui to parity.** As written, `unify-…` claims
   migration ownership of an artifact a sibling change still owns the *creation* of.

---

## Cross-cutting note (not a defect, a sequencing fact)

The MCP server's own runtime instructions and prior project memory describe
`read_record_field`, `content_ladder`, and `pdpp://field-window/...` as if live. They are
**specified but not implemented**. Any reviewer (human or agent) trusting the tool
description or memory over the code will mis-scope this change. The grep evidence in this
file is the authority: five MCP tools, no `read_record_field`, no `content_ladder`, no
field-window route, one `pdpp://record/` fallback URI.

---

## Recommendation

**HOLD** `unify-read-evidence-surface` at the Slice-0 design gate until the following are
resolved (none require new research; all are edits to the change's own artifacts):

1. **State the real baseline.** Rewrite the "migrate / keep intact / preserve deployed
   behavior" language so it does not assert that `read_record_field`, content ladders, or
   field-windows already exist. They are proposed in `add-mcp-content-ladder`.
2. **Make the dependency explicit and ordered.** Declare `add-mcp-content-ladder` a
   **prerequisite** (it builds the ladder, `read_record_field`, the field-window endpoint,
   and `pdpp://field-window` resources); `unify-…` extracts the shared layer and adds
   CLI/REST/operator-ui parity *after*. Gate Slice 2/Slice 3 on that change landing.
3. **Bind to the shipped vocabulary.** Replace "declared-role / display role / role-derived
   presentation" with the actually-shipped **declared `type` (`x_pdpp_type` →
   `field_capabilities.type`)** primitive, or explicitly justify and define a *new* `role`
   axis distinct from `type` (and reconcile with Invariant 10's no-competing-semantics rule).
   As written it duplicates the one live presentation vocabulary under a different name.
4. **Anchor binary discipline on the existing route.** Reference `mountRsBlobRead`
   (`GET /v1/blobs/:blob_id`) as the export/continuation target for the metadata-only binary
   invariant, and scope the *new* work as "add MCP-visible metadata-only projection in front
   of the existing blob route," not as preserving a discipline that does not exist.

The architectural intent (one shared read/evidence model below MCP; RS stays the
authorization/query authority; no MCP-only semantics; no field-name guessing) is sound and
consistent with the shipped `x_pdpp_type` philosophy. The HOLD is about baseline honesty,
vocabulary collision with `x_pdpp_type`, and unstated dependency ownership versus
`add-mcp-content-ladder` — not about the goal.
