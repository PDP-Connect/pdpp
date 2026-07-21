## 1. Spec and implementation

- [x] 1.1 Add an OpenSpec delta for durable source-detail run acknowledgements and exact run links.
- [x] 1.2 Add an OpenSpec delta for concise owner-facing assistance copy with diagnostics kept out of the instruction string.
- [x] 1.3 Implement the source-detail run-link and refresh durability fix.
- [x] 1.4 Implement the USAA manual-action copy boundary and add systemic regression coverage.

## 2. Verification

- [x] 2.1 Run targeted unit/invariant tests for the source-detail run handoff.
- [x] 2.2 Run targeted unit tests for the USAA handoff and diagnostic boundary.
- [x] 2.3 Run the relevant package lint/typecheck checks.
- [x] 2.4 Run `openspec validate repair-owner-action-handoff --strict`.
- [x] 2.5 Run `openspec validate --all --strict`.

## Acceptance checks

- [x] A source-detail run-start acknowledgement survives refresh/revalidation.
- [x] Connection-level owner actions route to an exact run when a run id is known.
- [x] USAA owner-facing manual-action copy is concise and does not leak raw diagnostics.
- [x] Other connectors remain covered by regression tests so diagnostic telemetry does not spill into owner assistance copy.
