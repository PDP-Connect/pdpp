## 1. Current-State Audit

- [x] 1.1 Inventory existing dashboard/session owner control routes for connectors, connections, runs, schedules, diagnostics, delete/revoke, and display-name mutation. (Read-only audit: `tmp/workstreams/ri-owner-agent-control-audit-v1-report.md`, "Route inventory table".)
- [x] 1.2 Inventory owner-agent bearer authorization paths and identify which owner-session operations can safely share handlers with owner-agent REST. (Audit report "Auth boundary table" + "Safe implementation lanes".)
- [x] 1.3 Capture the current Amazon evidence: template `amazon` listing, record-level `connection_id`, registry-URL fallback `display_name`, and missing owner-agent connection-initiation path. (Audit report "Amazon / multi-connection evidence".)
- [x] 1.4 Record the selected route-family decision in `design.md`: extend `/_ref/*` for owner-agent bearer access or introduce a cleaner owner REST family. (Audit report "Route-family recommendation": introduce `/v1/owner/*`; realized by `GET /v1/owner/connections` and `GET /v1/owner/control`.)

## 2. Contract And Metadata

- [x] 2.1 Define owner-agent control metadata in root/protected-resource discovery, including entrypoint URL, action families, and unsupported-action semantics. (`pdpp_owner_agent_onboarding.control_surface` hint + bearer-authed `GET /v1/owner/control` capability document, both projected from `buildOwnerAgentControlSurface`; supported families carry method + URL, owner-mediated/unsupported families are named with a typed `status` and reason. Lane `ri-owner-agent-control-entrypoint-v1`.)
- [ ] 2.2 Define connector template and connection instance response shapes with `connector_id`/`connector_key`, `connection_id`, deprecated `connector_instance_id` compatibility, `display_name`, label status, lifecycle status, and supported actions. (Connection-instance shape landed via `ownerListConnections` reference-contract op + `OwnerConnectionSchema`: `connection_id`, deprecated `connector_instance_id`, `connector_id`/`connector_key`, `display_name`, `label_status`, lifecycle fields. Template shape and `supported_actions` remain for other lanes.)
- [ ] 2.3 Define typed connection-intent response shapes for OAuth, browser assistance, upload/import, local-collector enrollment, and unsupported connectors.
- [ ] 2.4 Add typed error envelopes for ambiguous connector-only actions, unsupported actions, missing owner-agent action family, and unsafe provider step.

## 3. Authorization And Audit

- [ ] 3.1 Add explicit owner-agent bearer allowlisting for the selected owner control routes without making `/mcp` accept owner bearers. (Partial: `GET /v1/owner/control` is gated by `requireToken` + `requireOwner`; client/`mcp_package` bearers → 403, missing bearer → 401, `/mcp` owner-bearer rejection pinned by regression test. Mutating control routes remain for later lanes.)
- [ ] 3.2 Share control operation handlers between browser owner sessions and owner-agent bearers where semantics match, while keeping auth adapters separate.
- [ ] 3.3 Add non-secret audit evidence for owner-agent mutations: actor kind, client id/name, target resource, operation, result, and request id.
- [ ] 3.4 Add revocation/authorization tests proving a revoked owner-agent credential cannot perform read or control operations.

## 4. Connection Discovery And Labels

- [ ] 4.1 Implement owner-agent connector-template listing with links or embedded summaries for configured connection instances.
- [x] 4.2 Implement owner-agent connection-instance listing with owner-meaningful labels or explicit label-needed state. (`GET /v1/owner/connections`, bearer-authed; lane `ri-owner-agent-connections-list-v1`.)
- [x] 4.3 Ensure display-name fallback values such as registry URLs are exposed as fallback/label-needed rather than treated as final SLVP labels. (`label_status: owner_set | fallback` via `projectStorageDisplayName`.)
- [ ] 4.4 Implement or extend owner-agent rename support so a trusted agent can label Amazon instances as `the owner personal` and `Shared Amazon`.

## 5. Connection Lifecycle Intents

- [ ] 5.1 Implement typed connection-intent creation for at least one supported connector path without completing provider authentication silently.
- [ ] 5.2 Return `open_url`, `complete_browser_assistance`, `upload_file`, `enroll_local_collector`, or `unsupported` next-step types as appropriate.
- [ ] 5.3 Add Amazon-specific acceptance coverage proving a trusted owner agent can initiate the second-account flow up to the owner-mediated next step.
- [ ] 5.4 Ensure connection instances are not marked active until provider authorization, upload/import, or local enrollment completes.

## 6. Instance-Scoped Operations

- [ ] 6.1 Make run-now, schedule, pause, resume, diagnostics, delete/revoke, and rename operations instance-scoped where they affect configured bindings.
- [ ] 6.2 Reject connector-only stateful actions with typed ambiguity when multiple instances exist, including available `connection_id` values and labels.
- [ ] 6.3 Preserve single-instance compatibility where a connector-only operation can safely auto-select the only configured instance.
- [ ] 6.4 Verify public read results and owner-agent control listings agree on `connection_id` and `display_name` after rename.

## 7. CLI, Docs, And Agent Guidance

- [ ] 7.1 Extend `pdpp owner-agent status` or a new subcommand to show non-secret control capabilities and connection listing.
- [ ] 7.2 Add owner-agent guidance for initiating new connections, labeling instances, and avoiding raw bearer/token output.
- [ ] 7.3 Update dashboard/operator copy so trusted local agents have a smooth connection-management path distinct from debug bearer copy.
- [ ] 7.4 Document that routine chat-hosted agents should still use scoped grants/MCP and not owner-agent admin credentials.

## 8. Validation

- [ ] 8.1 Add local integration tests for metadata discovery, owner-agent control authorization, connection listing, label-needed state, rename, and typed ambiguity.
- [ ] 8.2 Add connection-intent tests for supported, browser-assisted, and unsupported connector types.
- [ ] 8.3 Run `openspec validate add-owner-agent-control-surface --strict` and `openspec validate --all --strict`.
- [ ] 8.4 Run targeted reference implementation tests for owner-agent auth, connector routes, connection instance storage, and MCP owner-bearer rejection.
- [ ] 8.5 Run a live Daisy/Simon-equivalent smoke proving a trusted owner agent can list connection instances, label one, initiate a new Amazon connection intent, and stop at the owner-mediated provider step.
