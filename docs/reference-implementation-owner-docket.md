# Reference Implementation Owner Docket

Updated: 2026-05-31
Owner: RI owner
Status: active triage index

This docket is the durable owner-level index for reference implementation work.
It is not a spec, not a worker report, and not a substitute for OpenSpec. Its
job is to keep the full scope visible so the RI owner can decide what to merge,
archive, park, delegate, or prove live without rediscovering the same facts.

Authoritative sources still live elsewhere:

- OpenSpec changes own approved implementation scope and acceptance tasks.
- Archived OpenSpec changes own accepted completed scope.
- Design notes own high-stakes open questions and promotion decisions.
- `tmp/workstreams/*.md` files are evidence and handoff artifacts.
- `tmp/workstreams/ri-owner-current-state.md` is the current operational
  checkpoint, not the durable backlog.

## Human-direct priority overlay

This section records the owner's direct priority corrections. It is an overlay on top
of the docket, not a replacement for OpenSpec task ownership.

| Priority | Item | Current owner reading |
|---:|---|---|
| 0 | Explorer design SLVP ideal | Highest direct product priority. The Explorer SLVP implementation is owner-accepted and archived; further Explorer work should be new scope, not hidden acceptance debt. |
| 1 | RI acceptance target | Hosted MCP external-client acceptance, multi-connection package grant, canonical connector identifiers, and Daisy owner-token behavior remain the core acceptance target. |
| 2 | Owner tracking and accountability | The RI owner must maintain accurate scope, own worker/delegate output, keep rollback safety, and not rely on stale memory or worker claims. |
| 3 | External-client and live proof gaps | Real external Claude/client proof and valid HTTPS callback delivery remain open live gates. |
| 4 | Self-host/operator readiness | This is directly important after the acceptance/live-proof gates, not merely a distant roadmap item. |
| 5 | Legitimate Gemini/guidance findings | Preserve real findings, but do not let noisy or false-positive audit claims outrank direct priorities. |

## Status vocabulary

| Status | Meaning | Owner action |
|---|---|---|
| `active-openspec` | Approved scope exists and tasks remain open. | Continue, delegate, or review within that OpenSpec change. |
| `complete-awaiting-archive` | Work appears complete but the OpenSpec archive step is not done. | Re-validate, archive, and update this docket. |
| `owner-live-gated` | The remaining evidence needs a live account, real client, deployment, or owner-held credential. | Bundle into the next human/live run. |
| `owner-decision-gated` | The next move changes posture or priority and needs the owner or RI owner approval. | Decide explicitly before implementation. |
| `needs-verification` | Current reports disagree or the evidence is stale. | Re-check code, tests, live state, or task files before acting. |
| `resolved` | Verified or completed outside an active OpenSpec change. | Keep citation; reopen only with new evidence. |
| `operational` | Live coordination state, not product scope. | Keep current, but do not treat as backlog. |
| `parked` | Valid work intentionally deferred. | Do not dispatch unless priority changes. |
| `false-positive` | Reconciled as not real against current code/specs/tests. | Remove from active planning unless new evidence appears. |
| `future-roadmap` | Real but outside the current acceptance or SLVP closeout lane. | Keep visible, do not let it block current acceptance. |

## Immediate owner gates

| Item | Status | Authority / evidence | Next action | Acceptance criterion |
|---|---|---|---|---|
| Remote `main` synchronization | `operational` | `pnpm workstreams:status` before push/report. | Keep `origin/main` current after accepted owner commits unless the owner explicitly asks to hold local. | Remote branch contains the accepted commits, or the reason for holding is recorded. |
| Delegate acceptance branch | `operational` | `git log main..workstream/ri-owner-delegate-acceptance-target` is empty and the branch is an ancestor of `main`; the worktree remains only for the owner's interactive paused delegate. | Keep parked until the owner no longer needs the live delegate session, then delete the branch/worktree. | No unmerged delegate commits exist; `pnpm workstreams:status` may still report the branch ahead of upstream as parked operational state. |
| Current operational ledger | `operational` | `tmp/workstreams/ri-owner-current-state.md`. | Keep updated after merge, deploy, archive, park, or live-gate decisions. | A resumed owner can identify current branches, deployment revision, evidence, and stop condition without chat memory. |

## Acceptance-target gates

| Item | Status | Authority / evidence | Next action | Acceptance criterion |
|---|---|---|---|---|
| Hosted MCP package grant over real MCP JSON-RPC | `owner-live-gated` | Delegate gate report and RI owner live probe under `tmp/workstreams/`. | Run the actual external Claude UI/client acceptance, not only the scripted probe. | External Claude reconnects through hosted MCP, inspects streams, queries records, and creates/manages event subscriptions without URL-shaped connector ids. |
| Multi-connection package disambiguation | `owner-live-gated` | Live probe proved typed `ambiguous_connection` with `connection_id`; task file still calls for real client coverage. | Include in external Claude/ChatGPT acceptance run. | Multi-connection package grant forces `connection_id` disambiguation and succeeds after retry. |
| Event-subscription HTTPS callback delivery | `owner-live-gated` | Probe skipped callback verification and `send_test` because no valid reachable TLS callback URL was available. | Provide or stand up a reachable HTTPS callback URL, then verify create -> verify -> active -> delivery. | Delivery receives CloudEvents 1.0 structured body and Standard Webhooks v1 signature at the callback. |
| Daisy-style owner-token REST access | `owner-live-gated` | RI owner probe proved owner token issue/introspect/use/revoke, `/v1/*` owner reads, `/_ref/*` owner-session scoping, and `/mcp` owner-bearer rejection. | If Daisy itself is the consumer, give it an owner token through the deployment-token flow and exercise the needed REST calls. Do not route owner access through MCP. | Daisy-style automation can use an owner token for owner-level REST/read/admin testing where bearer auth is supported, while `/mcp` remains grant-scoped and rejects owner bearers. |
| Hosted MCP internal forwarding F1 | `resolved` | `route-hosted-mcp-adapter-self-calls-internally` archived 2026-05-31; live deployment re-proved update via internal RS base. | No implementation action. Re-verify only after deploy or proxy changes. | Hosted MCP package-adapter self-calls use the internal RS base instead of hairpinning PATCH through the public origin. |

## OpenSpec docket

| Change | Progress | Status | Next action |
|---|---:|---|---|
| `complete-local-agent-collectors` | 6/22 | `active-openspec` | Continue connection-first identity, multi-device collision tests, local store coverage, and dashboard completeness now that state sync is archived. |
| `split-public-site-and-operator-console` | 15/36 | `active-openspec` | Continue surface separation without hosted-service framing drift. |
| `design-fast-broad-agent-consent` | 17/36 | `active-openspec` | Reconcile with current package-grant and owner-token behavior before more UI work. |
| `add-gmail-attachment-backfill` | 28/28 | `resolved` | Archived 2026-05-31. Live Gmail/Docker proof remains residual owner-only connector evidence, not open implementation scope. |
| `expose-connection-identity-on-public-read` | 51/60 | `active-openspec` | Remaining items are the UI test-infra-gated consent/dashboard tranche and out-of-repo hosted MCP gateway coordination. |
| `canonicalize-connector-keys` | 24/28 | `owner-live-gated` | No-human runtime/storage/trace tails are closed. Remaining work is live DB backup/migration validation, local deploy proof, and real Claude/ChatGPT/Daisy acceptance flows. |
| `split-reference-server-by-route-family` | 56/56 | `resolved` | Archived 2026-05-31. No route-extraction work remains in this change. |
| `add-connector-adaptive-lanes` | 29/33 | `needs-verification` | Verify max-concurrency decision and remaining acceptance evidence before dispatch. |
| `republish-remote-surface-as-opendatalabs` | 37/42 | `active-openspec` | Continue package/release readiness only after current acceptance gates are stable. |
| `add-chase-current-activity-stream` | 12/13 | `owner-live-gated` | Live owner investigation for stable transaction identity and pending-to-posted behavior. |
| `define-run-assistance-state-contract` | 26/26 | `resolved` | Archived 2026-05-31. The two Docker live flows remain residual post-deploy evidence, not implementation blockers. |
| `propagate-skip-result-diagnostics` | 14/14 | `resolved` | Archived 2026-05-31. Live USAA root-cause proof remains residual owner-only connector evidence. |
| `design-host-browser-bridge-for-docker` | 28/30 | `active-openspec` | Finish design closure or explicitly defer host-bridge implementation. |
| `add-run-interaction-streaming-companion` | 85/90 | `active-openspec` | Close remaining companion/streaming tasks after live UX verification. |
| `add-source-webhook-ingress` | 19/19 | `resolved` | Archived 2026-05-31 after manual spec sync and strict OpenSpec validation. |
| `design-local-collector-state-sync` | 36/36 | `resolved` | Archived 2026-05-31. Manual device-side replay remains residual pre-broad-rollout evidence. |
| `add-reddit-pilot-real-shape-fixture` | 0/20 | `future-roadmap` | Do not start until higher acceptance and connector-green lanes are stable. |
| `complete-explorer-slvp-ideal` | 25/25 | `resolved` | Archived 2026-05-31; future Explorer ambitions require new scope. |
| `narrow-search-to-spine-jump` | 18/18 | `resolved` | Archived 2026-05-31. |
| `route-hosted-mcp-adapter-self-calls-internally` | 11/11 | `resolved` | Archived 2026-05-31 after live F1 evidence. |

## Explorer, Search, and Timeline

Explorer is SLVP-complete for the accepted owner target as of `e1d6b604`. The
contract prerequisites that previously blocked type-aware cards and honest
window language are implemented, validated, and browser-proven. The active
OpenSpec change is archived; any later Explorer ambitions
should be opened as new scoped work.

| Item | Status | Authority / evidence | Next action | Acceptance criterion |
|---|---|---|---|---|
| Typed manifest stream schemas | `resolved` | Archived `complete-explorer-slvp-ideal`; `field_capabilities[field].type` merged and generated artifacts current. | No action unless new schema-display scope opens. | Explorer renders declared field types with heuristic fallback only when declarations are absent. |
| Photo/blob cards | `resolved` | Archived `complete-explorer-slvp-ideal`; final sandbox browser UAT proved blob affordance/read-path honesty. | No action unless blob UX expands. | Blob-backed records show safe read affordances only when declared usable. |
| Type facets and schema dispatch | `resolved` | Archived `complete-explorer-slvp-ideal`; typed card dispatch tests and browser UAT passed. | No action unless new typed-card scope opens. | Facets/cards derive from read metadata rather than static stream assumptions. |
| Grant-scoped field projection in Explorer | `resolved` | Archived `complete-explorer-slvp-ideal`; withheld-field rendering proved in sandbox UAT. | No action unless grant projection semantics change. | Fields hidden by projection are represented honestly, not silently omitted. |
| Connection-scoped search | `active-openspec` | `expose-connection-identity-on-public-read` remains open. Explorer now consumes connection chips/links. | Finish remaining identity/read-surface tasks in that change. | Searching within one connection cannot leak or mix sibling connections. |
| Aggregate/window metadata | `resolved` | Archived `complete-explorer-slvp-ideal`; `window=exact` contract/runtime slice and live browser language passed. | No action unless aggregate/window semantics expand. | Explorer can show bounded activity/window summaries without claiming full scans. |
| Search/Explore/Timeline IA unification | `resolved` | Archived `complete-explorer-slvp-ideal` plus `narrow-search-to-spine-jump`. | No action unless a new IA target opens. | Search/Jump, Explore, and Timeline have one coherent owner mental model. |
| `/dashboard/records/*` route retirement | `future-roadmap` | Explicitly out of scope for `complete-explorer-slvp-ideal`. | Do not treat as hidden Explorer acceptance debt; open a new change only if route semantics become priority. | No primary dashboard IA is record-centric where connection-centric language is intended. |
| Sandbox Explorer parity | `resolved` | Archived `complete-explorer-slvp-ideal`; `/sandbox/explore` web browser UAT passed with seeded specimen labels. | No action unless sandbox scope changes. | Sandbox route exists with labeled mock data and intentional live/sandbox divergence. |
| Live browser UAT | `resolved` | `tmp/workstreams/explorer-live-uat-final-clean*.png`; `tmp/workstreams/explorer-sandbox-uat-final-web-*.png`; archived `complete-explorer-slvp-ideal`. | No action unless a new Explorer target opens. | Owner can complete the target journey without hidden route, layout, or copy regressions. |

## Gemini and guidance-ledger reconciliation

The Gemini Flash audit is not authoritative. It is useful as a prompt for
re-verification. The current reconciliation says the highest-priority Gemini
items were mostly stale relative to code shipped later.

| Item | Status | Authority / evidence | Next action |
|---|---|---|---|
| Auth posture claim that all `/_ref/*` endpoints are unauthenticated | `false-positive` | `tmp/workstreams/ri-gemini-item-auth-posture.md`. | No implementation. Optional extra unauth tests only if doing nearby auth hardening. |
| Outbound webhook envelope standards | `false-positive` | `tmp/workstreams/ri-gemini-item-webhook-standards.md`; archived standards-alignment change. | Mark stale ledger rows resolved. |
| Read-contract aggregation/faceting | `false-positive` | `tmp/workstreams/ri-gemini-item-read-aggregation.md`; archived aggregation changes. | No new aggregation OpenSpec from Gemini. |
| MCP server behavior/spec coverage | `false-positive` | `tmp/workstreams/ri-gemini-item-mcp-server-package.md`; `openspec/specs/mcp-adapter/spec.md`. | No behavior work. Publishing remains separate and parked. |
| Gmail `blob_ref` / attachments | `resolved` | `tmp/workstreams/ri-gemini-item-gmail-attachment.md`; archived `add-gmail-attachment-backfill` at 28/28. | Live Gmail proof remains residual owner-only evidence, not Gemini-driven implementation scope. |
| `expand[]` / `expand_limit` footgun | `false-positive` | `record-expand-helpers.js`, generated reference docs, MCP tool descriptions, and `query-contract.test.js` show expansion is manifest-declared through `/v1/schema` `expand_capabilities`; undeclared expansions reject as `invalid_expand`. | No implementation; keep the honest declared-capability mirror. |
| SQLite-bound naming under Postgres mode | `parked` | Storage code has backend-neutral factories plus explicit backend-specific implementations; remaining `createSqlite*` names are aliases, tests, or actual SQLite implementations, not a Postgres runtime leak. | Do not run a broad rename without a scoped cleanup change; not acceptance-gating. |
| Cursor direction documentation | `resolved` | Implementation already rejects order-mismatched cursors in SQLite and Postgres read paths; `spec-core.md`, web docs, and the reference-contract cookbook now state the direction-bound rule. | No further implementation unless a future read-contract docs pass expands cursor examples. |
| Inbound `schedule_run` endpoint naming | `false-positive` | `schedule_run` is source-webhook payload action vocabulary on `POST /_ref/source-webhooks/:sourceId`; operator run routes are `POST /_ref/connectors/:connectorId/run` and `POST /_ref/connections/:connectorInstanceId/run`. | No rename; source-webhook change is archived. |
| Legacy zero-record Claude/Codex connections | `owner-decision-gated` | Guidance reconciliation action table. | Inspect data, then decide delete, migrate, or preserve. |
| Test fixtures leaking in production UI | `false-positive` | `isPublicReferenceConnector`, connector-listing tests, hosted-MCP picker coverage, and catalog completeness tests hide stubs, unproven manifests, local-device defaults, and PostgreSQL test connectors from public listing. | No implementation unless a concrete leaking connector id is found. |
| PWA icon and notification auto-prompt | `parked` | Gemini triage explicitly parks behind higher-leverage work. | Do not dispatch unless product priority changes. |
| DCR requiring no initial access token | `false-positive` | Gemini triage and auth posture reconciliation. | No action unless owner intentionally opens public registration. |
| SQLite WAL universally required | `false-positive` | Gemini triage. | No action; Postgres is the multi-process target. |
| `PDPP-Version` / stale version-header criticism | `false-positive` | Gemini triage and reference revision metadata work. | No action unless new evidence appears. |

## Connector and live-data lanes

| Item | Status | Authority / evidence | Next action | Acceptance criterion |
|---|---|---|---|---|
| Gmail historical attachment backfill | `resolved` | Archived `add-gmail-attachment-backfill`; Gemini reconciliation; focused Gmail/query/blob/state-replay tests. | Bundle live Gmail proof into a later owner run if credentials are available. | Historical Gmail attachment records expose usable `blob_ref` and fetch path after backfill; live Gmail remains a residual owner-only confirmation. |
| Chase current activity stream | `owner-live-gated` | `add-chase-current-activity-stream`. | Live investigation of DOM/network identity and pending-to-posted lifecycle. | Current activity records preserve stable identity or explicitly model uncertainty. |
| USAA skip diagnostics | `resolved` | Archived `propagate-skip-result-diagnostics`; live USAA run recorded as residual post-deploy proof. | Bundle live USAA proof into a later owner run if credentials are available. | Skip result records bounded diagnostics without false success; live source-specific usefulness remains post-deploy evidence. |
| Connector adaptive lanes | `needs-verification` | `add-connector-adaptive-lanes`; guidance evidence gap. | Verify remaining concurrency decision and validation tasks. | Connector runner adapts lanes without overclaiming throughput or hiding backpressure. |
| Connector-green readiness | `future-roadmap` | Connector-green worker reports. | Convert read-only readiness findings into bounded OpenSpec or task lanes. | Each advertised connector has honest maturity, fixture/test coverage, and live evidence where required. |
| Local agent collectors | `active-openspec` | `complete-local-agent-collectors`; `design-local-collector-state-sync` is archived. | Continue identity, multi-device collision, local store, and completeness-diagnostics work. | Local collectors run under explicit connection/device/state semantics. |
| Reddit pilot real-shape fixture | `future-roadmap` | `add-reddit-pilot-real-shape-fixture`. | Do not start until higher-priority live connector gates are closed. | Fixture reflects real shape without collecting or exposing unnecessary owner data. |

## Platform, release, and self-host lanes

| Item | Status | Authority / evidence | Next action | Acceptance criterion |
|---|---|---|---|---|
| Route-family split and `index.js` reduction | `resolved` | Archived `split-reference-server-by-route-family`; `01287318` full-suite acceptance tranche. | No further extraction work should be added to the archived change. | Route families have clear modules, parity tests, and no route-regression drift. |
| Public site vs operator console split | `active-openspec` | `split-public-site-and-operator-console`; voice/framing guide. | Continue without implying hosted-service semantics. | Public docs, sandbox, and owner dashboard use distinct taxonomy and auth posture. |
| Remote surface republishing | `active-openspec` | `republish-remote-surface-as-opendatalabs`. | Continue package readiness after current acceptance gates. | Package names, docs, and release policy match approved public posture. |
| `@pdpp/mcp-server` npm publishing | `parked` | `tmp/workstreams/ri-gemini-item-mcp-server-package.md`; package release policy. | Do not author `publish-pdpp-mcp-server` unless the owner explicitly un-parks it. | If un-parked, an OpenSpec change adds it to the publishable package set and passes release checks. |
| Self-host onboarding and operator readiness | `active-openspec` | `split-public-site-and-operator-console`; self-host design notes and reports. | Promote or continue the next concrete readiness panel/onboarding slice. | Operators can tell whether password, origin, storage, cache, and MCP grant prerequisites are ready. |
| Host browser bridge for Docker | `active-openspec` | `design-host-browser-bridge-for-docker`. | Close design or defer implementation explicitly. | In-container browser behavior fails closed and preserves user-controlled manual action. |
| Run interaction streaming companion | `active-openspec` | `add-run-interaction-streaming-companion`. | Finish remaining live UX and companion tasks. | Manual-action remote surface is usable, observable, and does not store secrets. |

## Docket maintenance rules

1. Run `pnpm workstreams:status` before changing owner status, merging,
   archiving, pushing, or reporting current state.
2. Update this docket when a work item changes class, not for every transient
   test run.
3. Keep `tmp/workstreams/ri-owner-current-state.md` as the short live checkpoint.
4. Promote unresolved design questions to `design-notes/`; do not bury them in
   this docket.
5. Promote approved implementation scope to OpenSpec before non-trivial code.
6. When a worker report claims completion, verify code, tests, OpenSpec tasks,
   and live evidence before changing this docket to `complete-awaiting-archive`
   or `false-positive`.
7. Remove or mark stale Gemini/guidance entries only after citing the evidence
   that refutes them.
