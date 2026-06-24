# Design

## Standard

SLVP here means Stripe, Linear, Vercel, and Plaid-level product and protocol quality: the surface is obvious, hard to misuse, honest under failure, and verified as a journey rather than as isolated payload fields.

The acceptance target is not "ChatGPT can recover." The acceptance target is that an agent using any supported surface can discover data, inspect bounded evidence, continue to a field/window read, and escalate to full fetch or export without hidden knowledge or trust-breaking detours.

## Non-Negotiable Invariants

1. **Visible evidence first.** Search and list previews expose enough bounded, truthful model-visible text to decide whether to inspect a result when the resource server can prove the matched field.
2. **No visible dead ends.** Any visible record, field, field-window, cursor, or export handle has an explicit model-callable next action. If a host's generic resource reader is optional or unreliable, visible text must name the tool call path.
3. **No invented evidence.** Adapters do not infer matched fields from stream names, connector names, display labels, or field names. Evidence windows are rendered only from resource-server-proven or explicitly read fields.
4. **Bounded inline by default.** Ordinary text evidence stays inline with size, range, truncation, match offsets when applicable, and continuation metadata.
5. **Deliberate escalation.** Large text, JSON, blob, binary, and multi-record outputs return compact metadata and an explicit read/export route instead of silent truncation or host file materialization.
6. **Grant preservation.** Every continuation handle preserves the originating grant constraints. Handle resolution cannot broaden streams, fields, time ranges, expansions, or connections.
7. **Surface parity.** MCP, REST, and CLI expose the same ladder concepts with surface-appropriate vocabulary and tests.
8. **Setup clarity.** Package docs and server instructions teach the ladder directly, including what to do when preview evidence is insufficient.
9. **Hostile-client proof.** Tests simulate clients that hide `structuredContent`, cannot read MCP resources, expose only `content[]`, or materialize files aggressively.
10. **Journey-level proof.** The final gate includes local hostile-client tests, deployed smoke, and at least one fresh ChatGPT retest prompt.

## Workstreams

### Client Matrix

Audit MCP host behavior and encode a conformance table for:

- content-only clients
- structuredContent-aware clients
- clients with generic `resources/read`
- clients that show resource links but cannot read them
- clients that materialize resources as files
- ChatGPT, Claude, Codex, and generic MCP clients where practical

### Handle Semantics

Decide and implement one clear contract:

- either `pdpp://record` and `pdpp://field-window` are readable via MCP resources where advertised
- or they are treated as operational handles and every visible occurrence names the model-callable tool path

The current ChatGPT closeout accepts `pdpp://record` as `read_record_field.id`; this change must generalize or explicitly narrow that rule.

### REST And CLI Parity

REST search should expose first-class bounded evidence windows and continuation descriptors. CLI should provide compact search plus explicit bounded field/window read commands. MCP must not be the only surface where the ladder is usable.

### Large Data And Export Tier

Large fields, JSON subtrees, binary/blob values, multi-record exports, stale handles, and revisions/digests need typed behavior. The model should see metadata and bounded previews; full content should require explicit read/export.

### Setup And Documentation

Package README, hosted MCP metadata, server instructions, tool descriptions, and operator docs should describe the ladder in the same terms. Error messages should suggest the next valid action, not generic "fetch it" advice.

## Fan-Out Discipline

Workers may audit, propose tests, and implement isolated tranches in separate worktrees. They must not merge, push, deploy, or relax acceptance criteria. Every worker report must include:

- scope read and changed
- evidence gathered
- proposed pass/fail criteria
- gaps and residual risk
- exact commands run

The owner lane synthesizes reports, writes/updates OpenSpec, reviews diffs, runs gates, merges verified tranches, and controls deploy windows.

## Acceptance Gates

- `openspec validate complete-mcp-slvp-surface --strict`
- existing MCP server test suite
- read-evidence test suite
- hosted MCP OAuth/reference tests
- new hostile-client matrix tests
- REST evidence envelope tests
- CLI bounded read tests
- export/large-field tests
- package README/tool-instruction invariants
- `openspec validate --all --strict`
- `git diff --check`
- deployed revision smoke
- fresh ChatGPT retest using the durable prompt in `docs/research/`

## Out Of Scope

- New PDPP Core grant semantics.
- Connector execution or collection profile changes.
- Owner-mode MCP access.
- Source-platform credentials or direct source reads from MCP.
