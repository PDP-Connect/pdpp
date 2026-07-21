# Tasks: Define Source-Backed Fulfillment

This change is architecture-first. Section 1 is complete when the change is accepted; sections 2–7 are the implementation tranche and stay unchecked until built and verified.

## 1. Architecture artifacts

- [x] 1.1 Durable prior-art artifact at `docs/research/source-backed-fulfillment-prior-art-2026-07-09.md` with cited primary sources and access dates.
- [x] 1.2 Promote `design-notes/passthrough-resource-server-mode-2026-06-04.md` with its open questions answered and status updated.
- [x] 1.3 This change validates with `openspec validate define-source-backed-fulfillment --strict`.

## 2. Manifest capability declaration and validation

- [ ] 2.1 Add the `fulfillment.source_backed` per-stream capability block (eligibility contract incl. base-surface support, per-page envelope bounds, `query` subset) to `connector-manifest-validation.ts`, validated from manifest JSON alone.
- [ ] 2.2 Reject the capability on `mutable_state` streams, on streams whose schema carries `blob_ref` fields, on streams without a deterministically orderable `cursor_field`, and when the `query` subset exceeds the stream's overall query surface — each with a structured stream-scoped error.
- [ ] 2.3 Revalidate the existing manifest corpus; zero behavior change for manifests without the block.
- [ ] 2.4 Gmail manifest: declare `cursor_field` for `message_bodies` and add a `fulfillment.source_backed` capability block to `message_bodies` only (bounded page listing and detail reads; full Core base surface). `attachments` is ineligible in v1 (`blob_ref`); attachment metadata stays retained.

## 3. Connection posture selection

- [ ] 3.1 Add per-stream fulfillment posture selection to connection configuration (`retained` default, `source_backed` selectable only where the manifest declares the capability), with deterministic validation of selections against the manifest.
- [ ] 3.2 Record posture selection and change as spine events; posture change invalidates the stream's source-backed cache entries.
- [ ] 3.3 Owner-console surface for viewing and changing posture per connection stream (honest copy: what stops being collected/retained, what becomes live, that existing rows are kept dormant until explicitly deleted).
- [ ] 3.4 Collection lifecycle: exclude actively source-backed streams from scheduled/manual collection scope and ordinary canonical ingest; keep existing canonical rows dormant (not served, not counted in coverage/freshness, not advertised); never auto-delete on posture switch.
- [ ] 3.5 Retained catch-up: switching back serves dormant rows with `stale`/`unknown` freshness until collection re-establishes coverage evidence; conformance test that the switch never yields instant `current`.

## 4. Fulfillment dispatch and fixture adapter

- [ ] 4.1 Define the source-backed adapter contract (async, paginated, envelope-bounded, keyset-ordered) behind the `queryRecords` operation dependency seam in `operations/rs-records-list`; retained path untouched.
- [ ] 4.2 Implement a deterministic fixture-backed reference upstream adapter for conformance tests (no real credentials), including fault and upstream-mutation injection.
- [ ] 4.3 Route detail reads (`rs-records-detail`) for actively source-backed streams through the same adapter contract.
- [ ] 4.4 Enforce per-page fetch-envelope bounds (page size + declared overscan) and full base-surface service (bare list never rejected); assert no upstream fetch occurs on 400-rejected declaration-driven shapes.
- [ ] 4.5 Implement bound page cursors (effective filter, projection, order, connection, upstream consistency marker, credential generation) failing as `invalid_cursor` on any mismatch or upstream marker change.
- [ ] 4.6 Owner self-export support over actively source-backed streams under the same envelope.

## 5. Disclosure surfaces

- [ ] 5.1 Attach `freshness` (fetch-time `captured_at`, coverage-conditional `status`) and `meta.fulfillment.origin` to source-backed list/detail responses.
- [ ] 5.2 Add `source_unavailable` (503, `Retry-After` when known) to the reference error surface and generated docs.
- [ ] 5.3 Make connection-scoped discovery (`stream metadata`, `schema(stream)`, `field_capabilities`, `expand_capabilities`) reflect the active posture's effective capability only.
- [ ] 5.4 Advertise the extension in protected-resource metadata following the retrieval-capability advertisement pattern (name, stability, response fields, error codes).
- [ ] 5.5 Collection reports and health projection: add the accepted-not-collected `source_backed` stream disposition; exclude actively source-backed streams from gap/stale/unknown/checking classification; derive their readiness from credential/adapter or probe evidence.
- [ ] 5.6 Owner surfaces: served-on-demand label, dormant retained row count/size disclosure, and an explicit separate dormant-row delete action.

## 6. Audit and cache

- [ ] 6.1 Emit a spine event per source-backed read decision (connection, stream, grant id or owner-export, request-shape digest, `fetch_attempted`, outcome, timing; no payloads or credentials).
- [ ] 6.2 Implement the isolated response cache (TTL + size caps; partitioned by connection, credential generation, stream, grant/owner principal, effective filter, projection; exact-coverage matching only; flushable).
- [ ] 6.3 Invalidate cache on credential rotation, connection reconfiguration, posture change, and manifest version change; exclude cache contents from ingest/coverage/freshness evidence for retained records.

## 7. Acceptance checks

- [ ] 7.1 Conformance set: bare Core list against a source-backed stream succeeds with per-page-bounded upstream work; subset-declared range filter → live grant-projected page with `origin: "live"`; undeclared range filter → HTTP 400 with spine `fetch_attempted: false`.
- [ ] 7.2 Effective-capability posture-switch pair: retained-only shape succeeds and is advertised before the switch; after selecting `source_backed`, discovery drops it and the request returns 400 while a subset shape succeeds; switching back restores both.
- [ ] 7.3 Cursor honesty: multi-page pagination with injected upstream mutation produces no gaps/duplicates; upstream consistency-marker rotation and cross-filter cursor reuse both yield 400 `invalid_cursor`.
- [ ] 7.4 Fault injection: upstream down → 503 `source_unavailable`, never an empty 200; warm cache within bound → `origin: "cache"` with honest freshness.
- [ ] 7.5 Token boundary: no client or owner token material in any upstream request; owner self-export works under the same per-page-bounded contract.
- [ ] 7.6 Cache isolation: no cross-grant/connection/credential-generation serving; rotation/posture-change invalidation; flush-then-refetch; retained-stream evidence unchanged.
- [ ] 7.7 MCP journey test consuming only model-visible `content[]`: discovery shows the active subset, `query_records`/`fetch` complete end-to-end with zero MCP-layer changes.
- [ ] 7.8 Mixed-connection health conformance: with one stream source-backed and others retained, the connection reports healthy; the collection report carries the `source_backed` disposition; no gap/stale/unknown/checking classification appears for the source-backed stream; owner surface shows served-on-demand + dormant size + separate delete.
- [ ] 7.9 Owner-gated pilot on a dev instance (never the live stack without a declared window): mixed Gmail connection — `messages` retained; `message_bodies` selected source-backed via the existing IMAP adapter (bare bounded list pages, exact-filter/detail reads by id, expand from retained `messages` not declared); attachment bytes/blob fulfillment explicitly out of scope.
