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

- [x] Confirm the reference PAR route still accepts exactly one `authorization_details[]` entry and document the exact failure shape for multi-entry requests.
- [x] Audit the consent UI for maximal single-source grants: wildcard streams, continuous access, no time bound, no retention, no field projection.
- [x] Audit dashboard grant listing/revocation to determine whether package/session grouping could be displayed without weakening per-grant revocation.
- [x] Audit `pdpp-data-access` skill and CLI guidance for any wording that encourages owner tokens or broad access as a workaround.

## 3. Design Decisions

Open owner decisions are detailed in `design-notes/2026-04-27-prior-art-review.md` "Owner Decisions Still Required" and refined with proposed defaults in `design-notes/2026-04-29-owner-review-synthesis.md`. The consolidated owner-consumable view — every decision below, its status, the recommendation, and the exact owner question text for the open ones — is the `## Decision Matrix` section of `design.md`.

- [x] Decide whether issued grants remain source-bounded in all near-term designs. **Decided: yes.** Already normative in `openspec/specs/agent-consent-bundling/spec.md` ("Hosted MCP broad approval SHALL issue source-bounded child grants") and reasserted in this change's delta. Owner steering confirms.
- [ ] Decide whether the first fast setup primitive is client-authored batch consent (Option B), owner-authored permission sets (Option C), agent roles (Option D), or no change. (Recommendation: B first, then C as the next OpenSpec change. D out of scope.)
- [ ] Decide whether both Option B and Option C are on the roadmap, or only B with C deferred.
- [ ] Decide a soft cap or warning threshold on `authorization_details[]` entries per staged request.
- [ ] Decide whether "approve all" is allowed for mixed-source requests and what risk conditions disable it. (Recommendation in design.md: never when continuous + all streams, no time bound + sensitive source, or N≥3 sensitive sources.)
- [ ] Decide which connectors/sources count as "sensitive" for risk classification, and whether that list lives in config or a manifest field.
- [ ] Decide how package-level audit works: package id, timeline grouping, dashboard display, and whether a revoke-package affordance is offered.
- [ ] Decide whether incremental "add a source later" produces a new package linked via `parent_package_id` or stands alone, and how the dashboard renders the cumulative picture per agent identity.
- [ ] Decide where owner-authored permission sets are stored when Option C lands (owner-local, manifest, or both) and how they affect client registration.
- [x] Confirm any first implementation of Option B is labeled reference-experimental in UI and docs until promoted by a follow-up OpenSpec change.
- [x] Decide whether AS-side enrichment of `authorization_details` is forbidden (synthesis recommendation: yes — AS may narrow only) and where that rule is captured. **Decided: forbidden; AS may narrow only.** Captured in this change's delta ("The AS SHALL NOT silently widen the issued child grant beyond the streams the picker observed as selected") and the merged `reference-implementation-architecture` no-widen requirements. Owner steering confirms.
- [x] Decide whether cross-source grants stay off the near-term roadmap or are reopened by a future change (synthesis recommendation: stay off). **Decided: off the near-term roadmap.** The capability spec already forbids a single cross-source grant ("SHALL NOT issue a single cross-source PDPP grant"); owner steering keeps cross-source grant objects off near-term. Permanence remains an owner call but is not required for this track.
- [x] Decide whether consent-level predicate filters (date / resource / category) are explicitly deferred to a separate OpenSpec change after the query-layer filter grammar settles (synthesis recommendation: defer). **Decided: deferred.** Out of scope for this track; reopened only as its own OpenSpec change once the query-layer filter grammar settles (synthesis Q4 / decision #11). Owner steering confirms.
- [x] Decide where normative "issued grants are source-bounded" lives: `spec-core.md` directly, or inside the `agent-consent-bundling` capability spec. **Decided: the `agent-consent-bundling` capability spec.** That spec already carries the normative rule for the hosted MCP flow; no `spec-core.md` change was made or required. A future promotion into `spec-core.md` remains an owner call but is not blocking.
- [ ] Decide soft-cap value for `authorization_details[]` entries per staged request (synthesis suggestion: 8, warning at 6).
- [ ] Decide ownership of connector sensitivity classification: manifest-declared, central PDPP registry, or both.

## 4. Implementation Planning Gate

- [ ] If batch consent is selected, write a follow-up implementation OpenSpec change before code.
- [ ] If permission sets or agent roles are selected, write a separate design/implementation change before code.
- [ ] If no broad setup primitive is selected, update `pdpp-data-access` guidance to explain why repeated source-by-source approvals are intentional.
- [ ] Do not change `/oauth/par`, consent storage, consent UI, or grant issuance until this design track reaches an owner-reviewed decision.
- [x] Owner-approved tranche: ship per-stream narrowing inside the existing hosted MCP picker (no PAR/consent-storage change; ceremony still issues one source-bounded child grant per selected source). Implementation lives in `reference-implementation/server/index.js` / `hosted-mcp-selection.js` and is pinned by the spec scenarios in `specs/agent-consent-bundling/spec.md` ("Hosted MCP picker SHALL let the owner narrow streams within a selected source").
- [x] Owner-approved tranche: ship package-level access-mode narrowing inside the existing hosted MCP picker (single radio group; applies the chosen `access_mode` to every child grant issued by the package; defaults to `continuous` to preserve baseline). Spine-event surface extended so `grant.issued.data` records `access_mode`, `stream_names`, and an explicit `retention: null` (no non-Core retention shape is emitted) for operator visibility. Implementation lives in `reference-implementation/server/index.js` and is pinned by the spec scenarios in `specs/agent-consent-bundling/spec.md` ("Hosted MCP picker SHALL let the owner choose the package access mode", "Grant detail spine events SHALL surface what the package picker approved", "Hosted MCP picker SHALL NOT encode a non-Core retention shape"). The picker emits no `retention` field on issued child grants and the picker copy says plainly that this ceremony does not encode a machine-readable retention bound; retention narrowing is deferred to a future tranche that introduces a fixed list of Core-shaped `{ max_duration, on_expiry }` presets — see Accepted Behavior — Picker Retention in `design.md`.
- [x] Owner-approved tranche: repair the existing hosted MCP picker after external Claude live feedback without changing PAR, consent storage, or source-bounded child grants. Source sections render collapsed by default; no source or stream starts selected; source inclusion is derived from checked child streams so a "source selected with no streams" state is not representable from the UI; source checkboxes act as whole-source select/clear controls; owners can also expand a source and check exactly one stream; global `Select all` / `Clear all` and separate `Expand all` / `Collapse all` controls are available; collapsed rows preview stream names so single-stream approval is discoverable; empty/no-source/no-stream submissions re-render the hosted HTML validation page instead of a raw JSON error; and labels/copy remove registry URLs, fallback URL-shaped connection labels, and redundant technical-demo phrasing. Implementation lives in `reference-implementation/server/routes/as-consent-ui-helpers.ts` and `reference-implementation/server/routes/as-authorize.ts`, with regression coverage in `reference-implementation/test/hosted-mcp-selection.test.js` and `reference-implementation/test/hosted-mcp-oauth.test.js`. Deployed follow-ups `d989b0f3` and `1344614c` are validated by the hosted consent suite and authenticated local UAT (`visible_registry_url=false`, `stale_old_copy=false`, 19 source rows).
- [x] Owner-approved tranche: enforce the picker's already-validated per-connection selection on the issued child grant. When a connector has more than one active connection and the owner selects one specific connection, the AS pins `streams[].connection_id` on every authorized stream entry (including the wildcard, which `resolveGrantSelection` expands while preserving the pin); single-connection and no-connection selections keep `connection_id` omitted so fan-in and existing grants are unchanged. The pin decision is the pure `shouldPinSelectedConnection(connectionId, activeBindingCount)` (pin iff a specific connection is chosen among more than one active binding). The enforced `connection_id` and the package member's `source_json.connection_id` name the same connection. No PAR, consent-storage, source-bounded-grant, or operator grant-request change. Implementation lives in `reference-implementation/server/routes/as-consent-ui-helpers.ts`, `reference-implementation/server/routes/as-authorize.ts`, and `reference-implementation/server/auth.js` (`resolveGrantSelection` wildcard-expansion pin preservation), pinned by the spec scenarios in `specs/agent-consent-bundling/spec.md` ("Hosted MCP picker SHALL enforce a selected connection on the issued child grant"). Regression coverage proves persisted-grant enforcement and read-path narrowing (not just `source_json`): `reference-implementation/test/hosted-mcp-selection.test.js` (builder/pin-policy units) and `reference-implementation/test/hosted-mcp-oauth.test.js` (persisted `streams[].connection_id`, sibling-record exclusion via the real fan-in resolver, single-connection omission, wildcard pin, audit/enforcement parity).

## 5. Validation

- [x] `openspec validate design-fast-broad-agent-consent --strict`
- [x] `openspec validate --all --strict`
