## Context

The allocator already derives a stable per-connection profile bind path from the profile key. The reference persisted the profile key but discarded the allocator path. Separately, boot reconciliation wrote an `external_or_host_loss` start receipt and immediately terminalized it. A successor with a new surface ID could not complete that receipt because readiness only joins unresolved scope-matched receipts.

## Decision

An observed external loss is a replacement boundary, not proof that replacement failed. Its receipt stays `started` until either:

- readiness observes a successor browser generation in the same connection, surface-subject, and profile-key scope; or
- the allocator reports that an actual scoped successor ensure attempt failed.

Boot and periodic reconciliation still evict every allocator-dead surface so
historical capacity cannot be reused. They create a new external-loss receipt
only when the evicted projection was `ready` immediately before reconciliation.
Already `unhealthy` or `stopping` rows are historical evidence, not a fresh
loss observation; re-emitting a pending successor for them would mask an older
failed successor in the same connection/profile scope.

When more than one allocator-absent `ready` row shares that scope,
reconciliation records one boundary only. It elects the lexical first surface
ID as the stable receipt subject, then persists every evicted row unhealthy.
The receipt represents the scoped external observation rather than a count of
stale projections.

The 2026-07-29 boot wrote false starts before this rule existed. Their receipt
fields do not retain the pre-eviction health, so neither a timestamp nor a
connector filter proves a false loss. The read path therefore supports an
explicit, reversible selection override only after a reviewed correction names
the full immutable receipt fingerprint and the earlier failed external-loss
receipt in the same scope. It preserves every append-only receipt, excludes
only the named active start from system-actionable selection, and records a
revocation timestamp to restore ordinary selection. No automatic time-window
or connector-wide correction is permitted.

That single-target contract remains the ordinary correction. A reviewed
synthetic episode with multiple exact later unresolved starts in one scope uses
the connector-neutral complete-episode batch form instead: one named earlier
failed predecessor, explicit episode identity/bounds, and every full immutable
started-receipt fingerprint. Admission rejects an omitted sibling, mixed scope,
altered fingerprint, resolved member, or unrelated/intervening start; it never
infers membership from a time window. Apply/revoke are atomic and reversible,
and verification checks the admitted immutable snapshot so later normal starts
or later member resolution do not invalidate it. The bounded direct operator
tool consumes the reviewed artifact's exact bytes (SHA-256) for dry-run,
apply, verify, or revoke; revoke revalidates its batch/episode/digest while
locked before mutation. Each committed decision atomically appends its
deterministic redacted fact to the canonical Spine. No HTTP operator surface,
production identifiers in product code, or cross-connector/scope widening is
permitted.

A terminal successor receipt is not a current browser generation; it is separate system-actionable runtime evidence. It degrades continuity and remains available through idle scale-to-zero, but it does not mint or repeat a browser-session owner repair. Only provider invalidation proof remains repair authority.

The reference copies the allocator's stable profile bind path into `browser_surfaces.profile_dir`. It does not create a second cookie/token store or browser hibernation mechanism.

The profile key and persisted path/volume form one compatibility boundary: health-only updates may retain omitted provenance only for the same profile key. A changed key clears both fields unless it supplies a complete replacement pair. Failed stop/retirement lifecycle receipts remain historical; only a failed terminal receipt whose original boundary is `external_or_host_loss` is actionable successor evidence.

## Alternatives

- Terminalize on observation of loss: rejected because no successor can later prove the causal chain.
- Infer a successor by connector alone: rejected because two connection instances can share a connector.
- Persist provider session material: rejected because browser profile/process remains the credential boundary.

## Acceptance checks

1. External loss followed by a new-surface readiness probe completes one receipt with a successor generation hash.
2. A scoped successor ensure failure terminalizes that same receipt.
3. A terminal receipt remains a degraded runtime condition with no owner repair authority.
4. A persisted dynamic surface includes the allocator profile bind path.
5. Duplicate ready rows in one scope emit one deterministic boundary and one
   same-profile successor completion on SQLite and PostgreSQL.
6. An exact reviewed selector override restores an older failed external-loss
   receipt; an unmatched fingerprint and analogous connector history remain
   unchanged, and revocation restores the original selector result.
7. A reviewed multi-start synthetic episode admits only its complete exact
   fingerprint set on SQLite and PostgreSQL; omission, races, unauthorized
   revoke, and audit append failure leave no partial correction, while a
   committed correction/revoke has one canonical audit fact and remains
   verifiable and reversible.
