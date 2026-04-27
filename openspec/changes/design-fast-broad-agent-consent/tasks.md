## 1. Prior-Art Review

- [ ] Review OAuth RAR (RFC 9396) for multiple `authorization_details[]` entries and typed authorization details.
- [ ] Review OAuth PAR (RFC 9126) for staged request integrity and pending-request lifetime.
- [ ] Review Google OAuth consent and incremental auth for multi-scope risk presentation.
- [ ] Review GitHub fine-grained PATs and GitHub App installation for resource toggles and permission grouping.
- [ ] Review Slack app scopes and app installation consent for bundled source capability review.
- [ ] Review Plaid Link for institution/account/product selection and consent filtering.
- [ ] Review Apple/Android permission grouping for high-risk prompt friction and progressive disclosure.
- [ ] Review AWS IAM Identity Center permission sets and GitHub/GitLab organization app installs for reusable owner/admin-authored bundles.

## 2. Current-State Audit

- [ ] Confirm the reference PAR route still accepts exactly one `authorization_details[]` entry and document the exact failure shape for multi-entry requests.
- [ ] Audit the consent UI for maximal single-source grants: wildcard streams, continuous access, no time bound, no retention, no field projection.
- [ ] Audit dashboard grant listing/revocation to determine whether package/session grouping could be displayed without weakening per-grant revocation.
- [ ] Audit `pdpp-data-access` skill and CLI guidance for any wording that encourages owner tokens or broad access as a workaround.

## 3. Design Decisions

- [ ] Decide whether issued grants remain source-bounded in all near-term designs.
- [ ] Decide whether the first fast setup primitive is client-authored batch consent, owner-authored permission sets, agent roles, or no change.
- [ ] Decide whether "approve all" is allowed for mixed-source requests and what risk conditions disable it.
- [ ] Decide how package-level audit works: package id, timeline grouping, dashboard display, and optional revoke-package affordance.
- [ ] Decide how high-risk source/scope combinations are classified and rendered.
- [ ] Decide how this interacts with project-local agent token caches and incremental grant upgrades.

## 4. Implementation Planning Gate

- [ ] If batch consent is selected, write a follow-up implementation OpenSpec change before code.
- [ ] If permission sets or agent roles are selected, write a separate design/implementation change before code.
- [ ] If no broad setup primitive is selected, update `pdpp-data-access` guidance to explain why repeated source-by-source approvals are intentional.
- [ ] Do not change `/oauth/par`, consent storage, consent UI, or grant issuance until this design track reaches an owner-reviewed decision.

## 5. Validation

- [ ] `openspec validate design-fast-broad-agent-consent --strict`
- [ ] `openspec validate --all --strict`
