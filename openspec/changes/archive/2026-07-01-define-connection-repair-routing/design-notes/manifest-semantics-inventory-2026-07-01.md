# Manifest semantics inventory for setup and repair routing

Date: 2026-07-01
Status: captured for `define-connection-repair-routing`

## What "semantics are not free" means

A manifest field is not just data. It creates obligations for connector authors, schema validators, setup planners, schedulers, dashboards, owner agents, tests, docs, migration tooling, and future connectors. A field that sounds helpful but mixes static capability with live provider state becomes especially expensive: every consumer can start treating it as truth even when only runtime evidence can know the answer.

Scores below use `1` low and `5` high.

## Flat Inventory

| Semantic | Current examples | Category | Value | Cost | Keep / change |
|---|---|---:|---:|---:|---|
| Connector identity | `connector_id`, `connector_key`, `display_name` | Stable identity | 5 | 1 | Keep. Required for every surface. |
| Runtime bindings | `runtime_requirements.bindings.network/browser/filesystem/local_device` | Stable runtime mechanism | 5 | 2 | Keep. This correctly says what substrate a connector can use, not whether it is currently healthy. |
| Setup modality | `setup.modality`: `static_secret`, `manual_or_upload`, `provider_authorization` | Stable setup mechanism | 5 | 2 | Keep. This is the right altitude for product routing. |
| Static credential shape | `setup.credential_capture.kind`, fields, identity/secret flags | Stable setup mechanism plus secret-handling contract | 5 | 3 | Keep. Cost is justified because secret capture needs consistent UX and safe storage. |
| Manual/import shape | `setup.manual_or_upload`, accepted file hints, acquisition methods | Stable owner-artifact mechanism | 4 | 3 | Keep but police copy. It routes file/import setup without provider credential claims. |
| Provider authorization deployment config | `setup.deployment_config`, `capabilities.auth.deployment_config` | Deployment prerequisite | 4 | 3 | Keep. Distinguishes instance readiness from owner account authorization. |
| Provider authorization lifecycle proof gate | `PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS`, setup-plan proof gates | Reference proof state | 4 | 3 | Keep as reference implementation gate, not protocol semantics. |
| Static-secret live proof gate | `STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS` | Reference proof state | 4 | 3 | Keep as honesty gate until all static-secret paths are proven. |
| Setup next step | `capture_static_secret`, `open_provider_auth`, `provide_import_file`, `manual_runbook`, `enroll_local_collector` | Product-surface class | 5 | 3 | Keep. This is the right bounded owner-action surface for setup. |
| Catalog disposition | `static_secret_connect`, `manual_upload_connect`, `browser_collector_manual`, proof-gated variants | UI routing/presentation | 3 | 3 | Keep only if derived from setup plan. Do not let it become source-specific business logic. |
| Refresh recommended mode | `automatic`, `manual`, `paused` | Scheduling policy | 5 | 2 | Keep. Correctly models whether background scheduling is appropriate. |
| Background safety | `background_safe` | Scheduling policy | 5 | 2 | Keep. Correctly blocks unattended runs for connectors that should only run from owner action. |
| Refresh interval/staleness | `recommended_interval_seconds`, `minimum_interval_seconds`, `maximum_staleness_seconds` | Scheduling/freshness policy | 4 | 2 | Keep. Needed for freshness and schedule cadence. |
| Interaction posture | `credentials`, `otp_likely`, `manual_action_likely`, `none` | Expected assistance posture | 3 | 4 | Keep as heuristic only. It predicts cost/posture; it must not decide a live repair action without runtime evidence. |
| Bot/rate sensitivity | `rate_limit_sensitivity`, `bot_detection_sensitivity` | Scheduling/runtime risk hint | 3 | 3 | Keep as coarse policy input; do not make it user-facing diagnosis by itself. |
| Assisted-after-owner-auth | `assisted_after_owner_auth` | Compatibility scheduling hint | 3 | 4 | Contain and migrate. It is useful for ChatGPT-style session-reuse scheduling, but the name invites live-auth interpretation. Treat as compatibility metadata until replaced by stable mechanism + evidence-derived repair routing. |
| Human interaction capability list | `capabilities.human_interaction` | Connector interaction affordance | 3 | 4 | Narrow. Useful as a high-level capability, but actionability must come from structured assistance/required actions observed at runtime. |
| Public listing status | `proven`, `needs_human_auth`, `unproven`, `deprecated_upstream` | Listing/proof honesty | 4 | 3 | Keep. It gates public claims and should not drive live health. |
| Connection setup state | `awaiting_credential`, captured/verified status in setup status | Connection runtime/setup evidence | 5 | 3 | Keep outside manifest. This belongs to connection state. |
| Credential validity | `credential_present_and_unrejected`, stored credential rejection conditions | Connection runtime evidence | 5 | 3 | Keep outside manifest. This is current evidence. |
| Browser session readiness | session captured, browser-surface availability, profile/session reuse | Connection/runtime evidence | 5 | 4 | Keep outside manifest. Manifest may declare browser-session mechanism; readiness must be observed. |
| Owner action satisfier | `satisfied_when`: credential present, attention resolved, confirming run succeeded, gap recovered | Connection/action lifecycle | 5 | 4 | Keep. This is the right evidence-driven closeout contract. |
| Provider-specific page instruction | approve push, enter OTP, select file type, click provider button | Runtime instruction | 4 | 5 | Do not put in manifest. Carry as bounded assistance metadata after observation. |

## Current code facts

- Manifest setup planning is centralized in `reference-implementation/server/connection-setup-plan.ts`.
- The reference setup-plan vocabulary already has the right coarse next-step classes: local collector enrollment, browser collector enrollment, static-secret capture, provider auth, import file, manual runbook, deployment config, unsupported.
- `assisted_after_owner_auth` appears in only one first-party manifest today: ChatGPT.
- The manifest honesty test enforces `assisted_after_owner_auth=true` when a `needs_human_auth` connector also claims `automatic` or `background_safe`.
- `run-automation-policy.ts` uses `assisted_after_owner_auth` to suppress notifications during non-manual runs while allowing session-reuse scheduling.
- `connection-health.ts` uses `interaction_posture` to classify stale-but-otherwise-green assisted connectors as non-urgent owner-refresh advisories rather than degraded failures.
- `rendered-verdict.ts` already has a `satisfied_when` contract for owner actions. That is the right closeout mechanism.

## Manifest Audit Result

Audited 37 shipped manifest files:

- 33 first-party polyfill manifests under `packages/polyfill-connectors/manifests/`;
- 4 reference fixture manifests under `reference-implementation/manifests/`.

The reference fixture manifests do not carry setup or repair-routing semantics;
they remain fixture/seed manifests. The polyfill manifest fleet already uses the
right stable fields: `runtime_requirements.bindings`, `setup.modality`,
`setup.credential_capture`, `setup.manual_or_upload`,
`capabilities.refresh_policy`, `capabilities.human_interaction`, and
`capabilities.public_listing`.

One manifest contained over-specific live/provider repair copy:

- `chatgpt.json` described using stored sign-in details to "help repair" a
  browser session "when an owner-started run needs login again" and named app
  approval, OTP, or browser action in refresh-policy rationale.

The fix keeps the stable policy but removes live-state/provider-page claims:

- automatic ChatGPT refresh is session-reuse-only;
- owner-mediated repair handles provider login challenges through runtime
  assistance evidence;
- scheduled runs reuse current session evidence and do not prompt for
  credentials.

The durable guard is `setup-repair-manifest-honesty.test.ts`, which fails if
setup or refresh-policy copy starts claiming current connection state, and if
interaction declarations drift beyond the coarse stable capability/posture
vocabulary.

## Preliminary Decision

The schema can give up provider-specific auth-state knowledge without materially hurting UX. It should keep coarse product-surface classes and stable setup/runtime mechanisms. It should not try to answer "is this connection currently logged in?" or "which provider challenge is showing?" from manifest data.

The exact replacement for `assisted_after_owner_auth` should be designed as a migration, not a direct delete. The likely target is a stable mechanism declaration plus evidence-derived readiness/repair:

- static: this connector supports browser-session reuse and owner-mediated browser repair;
- static: unattended runs may start only when the connection has reusable session evidence;
- dynamic: current connection has or lacks that reusable session evidence;
- dynamic: this run observed owner repair is needed and selected the matching bounded action.
