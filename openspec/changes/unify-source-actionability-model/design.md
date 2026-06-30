## Context

`rendered_verdict` already separates collection tone from owner-interruption channel. Backend push policy also uses the correct high-level rule: only `channel: "attention"` with an owner-satisfiable required action may interrupt.

The remaining failure is in the owner console composition layer. Overview derives three separate arrays (`attentionConnections`, `advisoryOwnerActions`, and `sourceIssues`) and the presentation flattens them into one "Anything wrong" list. The hero line counts only `attentionConnections`. Live-shaped data can therefore show a small hero count above a much larger undifferentiated list, and the same connection can appear once as an owner action and once as a source issue.

## Decision

Introduce one pure owner-console projection for source work. It reads each `RefConnectorSummary` once and assigns each connection to at most one visible group:

- `needsOwner`: owner-satisfiable action on `channel: "attention"`.
- `review`: owner-satisfiable action on a non-attention verdict.
- `systemIssue`: non-owner or non-runnable source issue that should suppress all-clear copy.
- `checking`: unresolved/passive checking state that should not read as an owner task.

The projection is a UI-facing derivation, not a new server state machine. It must derive from `rendered_verdict` first, falling back to legacy `connection_health` only when the verdict is absent. It must not reclassify raw health axes into alarming states when `rendered_verdict` is present.

Overview renders the groups with headings that answer what the owner can do. Counts belong to the group they describe. The owner does not need to see or learn `attention`, `advisory`, `terminal_gap`, or `outbox` as UI taxonomy.

The model also owns detail-page source health labels. A later audit found that
the connection diagnostics surface still carried a local verdict tone-to-label
table and could show a bare healthy/checking label where the shared model would
show the server verdict label plus freshness context. That is a continuation of
the same source-actionability boundary, not a separate product concept: any
operator-facing source status or required-action summary should consume the
shared projection unless it is explicitly showing lower-level evidence.

## Alternatives

### Promote all advisory rows to attention

Rejected. It would create noisy push/action semantics and violate the existing verdict channel contract.

### Keep a flat list and change copy

Rejected. Copy alone cannot solve mismatched counts or duplicate rows. The surface needs a structural grouping invariant.

### Move the whole model into the server

Deferred. The server already owns the durable verdict contract. The failing behavior is owner-console composition; adding a console projection keeps the boundary small and avoids duplicating server semantics.

## Acceptance Checks

- A live-shaped set with three attention connections and additional review/system/checking rows renders a "Needs you" count of three and does not imply the entire panel has only three rows.
- A connection with both owner-runnable review action and amber/red health appears once, in the owner-review group, not also in system issues.
- Maintainer-only code-fix rows appear as system/maintainer issues and do not render owner-runnable CTA copy.
- Passive checking/unknown rows are visually muted and not counted as owner work.
- Existing source detail links remain exact-connection links, not connector-type links.
- Connection diagnostics renders status labels and owner-action CTAs through the
  shared source-actionability model instead of a local verdict vocabulary.
