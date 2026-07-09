# Define Source-Backed Fulfillment

## Why

`design-notes/passthrough-resource-server-mode-2026-06-04.md` captured the question of serving grant-scoped reads from a live upstream at request time and set a promotion trigger: promote to OpenSpec before implementing any such mode or manifest capability subset. That trigger is now met deliberately, in architecture mode. Two pressures make the boundary worth defining now: parts of the portability market are constraining bulk history access for some distribution models (Slack's May 2025 limits on newly distributed non-Marketplace apps — a constrained signal, not a general rule, and one that does not govern this deployment's current session-token path), and credentials the reference already holds (Gmail's IMAP app password) can satisfy bounded reads of immutable payloads without eager collection, retention, or local indexing. Core already permits this — `spec-architecture.md` names fulfillment "an implementation choice" and Core never requires retention — but nothing defines what an honest source-backed read owes, so any ad hoc implementation would risk silently approximating grant semantics.

Evidence: `docs/research/source-backed-fulfillment-prior-art-2026-07-09.md` (federated-query pushdown, Steampipe required-quals, OData Capabilities vocabulary, Gmail/Slack/Graph capability heterogeneity, UMA/GNAP, aggregator cache-vs-pass-through debate) and the four workstream maps under `tmp/workstreams/sbf-*-2026-07-09.md`.

## What Changes

- Add a new reference capability, `source-backed-fulfillment`, with a strict capability/policy split:
  - the connector **manifest** declares only static adapter capability and constraints per stream (`fulfillment.source_backed` object: eligibility contract including full base-surface support, per-page envelope bounds, and a `query` subset in the existing declaration grammar, validated as a strict subset of the stream's overall query surface), validated deterministically from the manifest JSON alone;
  - the **active posture selects the effective query capability** — stream-level `query` (plus retrieval/aggregation affordances) when retained, the source-backed subset when live — and connection-scoped discovery (`schema(stream)`, field/expand capabilities) advertises only the effective capability, so posture switches visibly change what agents discover;
  - **connection configuration** selects the active posture per stream (`retained` by default, `source_backed` selectable only where the manifest declares the capability); the composition is a pure function of manifest + connection configuration, and posture changes are owner actions recorded in the spine;
  - clients never see posture as a request or grant parameter; they see declared query capability, freshness, provenance, and structured failure;
  - the Core base query surface is never narrowed by posture: bare lists, exact filters, projection, ordering, and detail reads always work, with pagination (page size + declared overscan) bounding upstream work per page and Core rate limiting governing sustained deep pagination; posture narrows only declaration-driven affordances (range filters, expand, search, aggregation), which stay pushdown-or-refuse (undeclared shapes are HTTP 400, never silently approximated);
  - bound page cursors: logical keyset cursors carrying effective-filter/projection/order/connection/upstream-consistency bindings, failing loudly as `invalid_cursor` instead of paginating with gaps or duplicates;
  - response provenance (`meta.fulfillment.origin: "live" | "cache"`) composed with the existing Core `freshness` object, with `status: "current"` only on confirmed full coverage;
  - a structured `source_unavailable` (503) failure instead of silent emptiness or undisclosed staleness;
  - unchanged local grant enforcement including owner self-export, no token forwarding upstream, bounded upstream fetch envelopes;
  - spine audit events for every source-backed read decision;
  - an isolated, bounded, non-canonical response cache (partitioned by connection, credential generation, stream, grant, effective filter, projection; invalidated on credential rotation, reconfiguration, posture change, and manifest change);
  - advertisement of the extension in protected-resource metadata following the existing retrieval-capability pattern.
- Update `design-notes/passthrough-resource-server-mode-2026-06-04.md` to promoted status with its open questions answered.
- No PDPP Core (`spec-*.md`) changes. Implementation is sequenced in `tasks.md` sections 2–7 and gated on acceptance of this design.

## Capabilities

- **Added:** `source-backed-fulfillment` — honesty contract for serving grant-scoped reads from a live upstream.
- **Modified:** none. Manifest validation, connection configuration, and schema disclosure obligations are stated inside the new capability; existing capabilities are not edited.
- **Removed:** none.

## Impact

- Reference implementation only; no root `spec-*.md` edits. Two additive client-visible surfaces exist — `meta.fulfillment` response metadata and the `source_unavailable` (503) error code — and are therefore advertised as a named extension in protected-resource metadata per the RI-beyond-spec disclosure discipline flagged in `docs/research/spec-readiness-audit-2026-06-24.md`, rather than shipped silently. A client that ignores the advertisement still sees Core-conformant behavior on the base query surface (Core envelopes, additive metadata, structured errors); posture narrows only declaration-driven affordances, which are discoverable through connection-scoped stream metadata exactly as Core prescribes. Retained streams and connections that select nothing are byte-identical to today.
- Connector manifests gain an optional per-stream `fulfillment.source_backed` capability block; connection configuration gains a per-stream posture selection. Absent both, behavior is unchanged.
- Search (lexical/semantic/hybrid) and aggregation remain index-backed: source-backed query subsets do not declare those affordances in v1, so schema honesty is preserved by the existing declaration mechanism.
- Slack remains retained-fulfillment: the archival connector shape (session-token `slackdump` subprocess, 6–20h cold runs) and the upstream's query surface cannot satisfy the read contract; the 2025 rate-limit change is noted as a constrained market signal only. The pilot is a **mixed Gmail connection** consistent with the manifest's actual semantics: `messages`/`threads`/`labels` stay retained (they are `mutable_state` and owe `changes_since`), while `message_bodies` (`append_only` text/HTML payloads — the bulky immutable part) is served source-backed through the existing IMAP adapter as ordinary bounded Core reads (bare list pages, exact-filter and detail reads by id), after the tranche adds the `cursor_field` the stream currently lacks (the eligibility validator enforces this). Attachment *metadata* may remain retained; attachment **bytes** are out of scope — the `attachments` stream carries `blob_ref`, and a source-backed blob lifecycle (identity, authorization, proxy, cache, retry) is explicitly deferred to a separate earned extension, which the spec enforces by making `blob_ref`-bearing streams ineligible in v1.
