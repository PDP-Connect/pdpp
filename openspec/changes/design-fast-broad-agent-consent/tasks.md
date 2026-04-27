## 1. Prior-Art Review

Findings consolidated in `design-notes/2026-04-27-prior-art-review.md`.

- [x] Review OAuth RAR (RFC 9396) for multiple `authorization_details[]` entries and typed authorization details.
- [x] Review OAuth PAR (RFC 9126) for staged request integrity and pending-request lifetime.
- [x] Review Google OAuth consent and incremental auth for multi-scope risk presentation.
- [x] Review GitHub fine-grained PATs and GitHub App installation for resource toggles and permission grouping.
- [x] Review Slack app scopes and app installation consent for bundled source capability review.
- [x] Review Plaid Link for institution/account/product selection and consent filtering.
- [x] Review Apple/Android permission grouping for high-risk prompt friction and progressive disclosure.
- [x] Review AWS IAM Identity Center permission sets and GitHub/GitLab organization app installs for reusable owner/admin-authored bundles.

## 2. Current-State Audit

- [ ] Confirm the reference PAR route still accepts exactly one `authorization_details[]` entry and document the exact failure shape for multi-entry requests.
- [ ] Audit the consent UI for maximal single-source grants: wildcard streams, continuous access, no time bound, no retention, no field projection.
- [ ] Audit dashboard grant listing/revocation to determine whether package/session grouping could be displayed without weakening per-grant revocation.
- [ ] Audit `pdpp-data-access` skill and CLI guidance for any wording that encourages owner tokens or broad access as a workaround.

## 3. Design Decisions

Open owner decisions are detailed in `design-notes/2026-04-27-prior-art-review.md` "Owner Decisions Still Required."

- [ ] Decide whether issued grants remain source-bounded in all near-term designs. (Recommendation: yes — consistent across every surveyed system.)
- [ ] Decide whether the first fast setup primitive is client-authored batch consent (Option B), owner-authored permission sets (Option C), agent roles (Option D), or no change. (Recommendation: B first, then C as the next OpenSpec change. D out of scope.)
- [ ] Decide whether both Option B and Option C are on the roadmap, or only B with C deferred.
- [ ] Decide a soft cap or warning threshold on `authorization_details[]` entries per staged request.
- [ ] Decide whether "approve all" is allowed for mixed-source requests and what risk conditions disable it. (Recommendation in design.md: never when continuous + all streams, no time bound + sensitive source, or N≥3 sensitive sources.)
- [ ] Decide which connectors/sources count as "sensitive" for risk classification, and whether that list lives in config or a manifest field.
- [ ] Decide how package-level audit works: package id, timeline grouping, dashboard display, and whether a revoke-package affordance is offered.
- [ ] Decide whether incremental "add a source later" produces a new package linked via `parent_package_id` or stands alone, and how the dashboard renders the cumulative picture per agent identity.
- [ ] Decide where owner-authored permission sets are stored when Option C lands (owner-local, manifest, or both) and how they affect client registration.
- [ ] Confirm any first implementation of Option B is labeled reference-experimental in UI and docs until promoted by a follow-up OpenSpec change.

## 4. Implementation Planning Gate

- [ ] If batch consent is selected, write a follow-up implementation OpenSpec change before code.
- [ ] If permission sets or agent roles are selected, write a separate design/implementation change before code.
- [ ] If no broad setup primitive is selected, update `pdpp-data-access` guidance to explain why repeated source-by-source approvals are intentional.
- [ ] Do not change `/oauth/par`, consent storage, consent UI, or grant issuance until this design track reaches an owner-reviewed decision.

## 5. Validation

- [ ] `openspec validate design-fast-broad-agent-consent --strict`
- [ ] `openspec validate --all --strict`
