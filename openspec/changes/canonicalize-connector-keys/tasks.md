## 1. Identity Inventory

- [ ] 1.1 Inventory every active use of URL-shaped connector ids, stale aliases, `legacy`, `legacy_default`, `connector_instance_id` public aliases, and delimiter-parsed connector selection values.
- [ ] 1.2 Classify each occurrence as active runtime contract, migration-only, test fixture, root protocol doc, reference doc, or generated artifact.
- [ ] 1.3 Produce a canonical key mapping table for first-party connectors and local aliases, including unmapped/custom behavior.

## 2. OpenSpec And Contract Alignment

- [ ] 2.1 Validate this OpenSpec change with `openspec validate canonicalize-connector-keys --strict`.
- [ ] 2.2 Cross-check `expose-connection-identity-on-public-read`, `agent-consent-bundling`, and MCP adapter specs for contradictory `connector_id`/`connector_key` wording.
- [ ] 2.3 Decide whether any root `spec-core.md` or `spec-collection-profile.md` language must change in this tranche or whether it requires a separate protocol-spec change.

## 3. Migration

- [ ] 3.1 Add canonical connector-key helpers and first-party URL/alias mapping tests.
- [ ] 3.2 Add dry-run migration that reports every table/field to be rewritten and fails on ambiguous/unmapped identifiers.
- [ ] 3.3 Add write migration that rewrites connector manifests, storage bindings, source bindings, grants, grant packages, records/history, blobs, indexes, schedules, state, runs, diagnostics, coverage/gaps, and event subscriptions.
- [ ] 3.4 Validate migration against a backup fixture with URL-shaped ids and aliases, proving row counts, grants, data, and record hydration are preserved.

## 4. Runtime And Surface Cleanup

- [ ] 4.1 Update first-party manifests to use `connector_key` plus `manifest_uri`.
- [ ] 4.2 Update manifest registration and lookup to key by `connector_key`.
- [ ] 4.3 Update runtime/storage/read/search/blob/event-subscription code to require canonical connector keys in active paths.
- [ ] 4.4 Update hosted MCP package and consent selection parsing to use opaque or structured selection values, not delimiter-split connector ids.
- [ ] 4.5 Update owner dashboard, Explore, Records/Connections, event subscriptions, deployment tokens, and grant package surfaces to display connector names and connection names without registry URLs or legacy labels.
- [ ] 4.6 Update local-collector setup/config paths to advertise and accept canonical connector keys only.

## 5. MCP And Client Surface

- [ ] 5.1 Update MCP tool schemas/descriptions to prefer `connection_id` for source disambiguation and canonical connector keys for connector type metadata.
- [ ] 5.2 Verify Claude and ChatGPT MCP flows can approve multiple connections, inspect streams, query records, and create event subscriptions without URL-shaped connector ids.
- [ ] 5.3 Verify package-token event-subscription creation selects exactly one child grant by `connection_id` and returns typed ambiguity when required.

## 6. Docs And Fixtures

- [ ] 6.1 Update reference docs, CLI help, MCP README, and dashboard copy to use canonical connector keys and `manifest_uri` provenance.
- [ ] 6.2 Update fixtures/tests so URL-shaped connector ids appear only in migration tests or root protocol examples that are intentionally left unchanged.
- [ ] 6.3 Grep the tree for URL-shaped connector ids, `legacy_default`, user-visible `legacy`, and delimiter form patterns; read every affected file before marking this complete.

## 7. Deployment Validation

- [ ] 7.1 Run targeted unit/contract tests for migration, manifest registration, grant package consent, MCP adapter, event subscriptions, owner-token routes, records/search hydration, and local collector config.
- [ ] 7.2 Run `openspec validate canonicalize-connector-keys --strict` and relevant broader validation.
- [ ] 7.3 Deploy to the local Docker reference instance and verify `/dashboard`, `/dashboard/event-subscriptions`, `/dashboard/deployment/tokens`, `/dashboard/explore`, `/oauth/authorize`, and `/mcp`.
- [ ] 7.4 Verify the owner's acceptance target: Claude can reconnect through MCP, set up event subscriptions, and Daisy can receive/use an owner token for management-feature testing.
