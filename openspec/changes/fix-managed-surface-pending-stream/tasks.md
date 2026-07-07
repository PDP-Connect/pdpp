## 1. Implementation

- [x] Attach pending browser interactions to a ready managed browser-surface lease when present.
- [x] Preserve legacy null-target behavior when no managed surface exists.

## 2. Verification

- [x] Add a route regression test for pending `manual_action` plus managed surface.
- [x] Run the targeted stream route test.
- [x] Run `openspec validate fix-managed-surface-pending-stream --strict`.
