## Context

The allocator already derives a stable per-connection profile bind path from the profile key. The reference persisted the profile key but discarded the allocator path. Separately, boot reconciliation wrote an `external_or_host_loss` start receipt and immediately terminalized it. A successor with a new surface ID could not complete that receipt because readiness only joins unresolved scope-matched receipts.

## Decision

An observed external loss is a replacement boundary, not proof that replacement failed. Its receipt stays `started` until either:

- readiness observes a successor browser generation in the same connection, surface-subject, and profile-key scope; or
- the allocator reports that an actual scoped successor ensure attempt failed.

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
