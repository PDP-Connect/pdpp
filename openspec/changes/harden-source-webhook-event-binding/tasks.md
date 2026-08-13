## 1. Implementation

- [x] Add a failing replay oracle for a signature reused with a different source webhook event id.
- [x] Bind event id into inbound source webhook signed material.
- [x] Update local sign helpers and source-webhook architecture requirement.

## 2. Acceptance Checks

- [x] Run focused source webhook tests.
- [x] Run reference implementation typecheck.
- [x] Run focused Biome checks.
- [x] Run `openspec validate harden-source-webhook-event-binding --strict`.
