## 1. OpenSpec changeover
- [x] 1.1 Move the active boundary-hardening plan into this OpenSpec change and stop creating new inbox memos for this tranche
- [x] 1.2 Keep the governance boundary explicit by referencing root PDPP specs for protocol semantics instead of duplicating them here

## 2. Web bridge truthfulness
- [x] 2.1 Make `apps/web` grant bridges source-aware so they support `provider_id` where the reference contract does
- [x] 2.2 Update query bridge wording and behavior so it no longer implies connector-only client access
- [x] 2.3 Quarantine any remaining legacy/demo bridge routes so they do not imply removed or non-primary surfaces are current

## 3. Native/public boundary hardening
- [x] 3.1 Continue removing connector-shaped leakage from native public artifacts while preserving current internal storage seams
- [x] 3.2 Add or tighten black-box tests proving native provider requests, owner access, and public artifacts remain provider/source-first

## 4. Verification and active-doc alignment
- [x] 4.1 Expand CLI/test coverage for the current primary reference surfaces as needed
- [x] 4.2 Update active reference docs that still contradict the landed contract changes in this tranche
