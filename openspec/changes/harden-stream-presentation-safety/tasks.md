## 1. Presentation restoration and surface targeting

- [x] 1.1 Await baseline window settlement before marking a presentation restored.
- [x] 1.2 Propagate and validate a per-surface settle endpoint for dynamic managed n.eko surfaces.

## 2. Terminal safety and authority

- [x] 2.1 Route all managed-lease cleanup paths through restore-or-retire before release.
- [x] 2.2 Scope controller attachment cookies per stream session and apply controller admission to every state-changing presentation route.

## 3. Wire safety and regression coverage

- [x] 3.1 Normalize viewport dimensions before positivity validation.
- [x] 3.2 Add deterministic regressions for restore settlement, dynamic targeting, cleanup, authority isolation, and wire normalization.

## 4. Acceptance checks

- [x] 4.1 Run `openspec validate harden-stream-presentation-safety --strict`.
- [x] 4.2 Run focused allocator, adapter, route, controller cleanup, and parity-oracle suites.
