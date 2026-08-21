## 1. Resume action

- [x] 1.1 Add the shared `applyResume` primitive with an optional `requireSourceBindingKind` guard.
- [x] 1.2 Add owner-agent bearer resume routes addressed by `connection_id` and by `connector_id`.
- [x] 1.3 Add the owner-session reference resume route, unrestricted by binding kind.
- [x] 1.4 Keep the automatic `historical_archive` resume hooks (credential capture, run admission) narrow.
- [x] 1.5 Pin `connector_instance_not_paused` (409) in the error-status table.
- [x] 1.6 Publish the resume contract manifests and regenerate the OpenAPI/route docs.

## 2. Pause action

- [x] 2.1 Add the shared `applyPause` primitive (active -> paused).
- [x] 2.2 Add owner-agent bearer pause routes addressed by `connection_id` and by `connector_id`.
- [x] 2.3 Add the owner-session reference pause route.
- [x] 2.4 Pin `connector_instance_not_active` (409) in the error-status table.
- [x] 2.5 Publish the pause contract manifests and regenerate the OpenAPI/route docs.

## 3. Console

- [x] 3.1 Add `paused` to `SourceStatusKind` and render it distinctly from revoked/syncing/pending.
- [x] 3.2 Surface a paused connection with a Resume action instead of hiding it.
- [x] 3.3 Add a Pause action to an active connection's detail page.
- [x] 3.4 Keep the recovered-archive reconnect journey routed to credential repair.

## 4. Manual-upload import directory

- [x] 4.1 Verify `import_dir` exists before returning the import-dir env fragment.
- [x] 4.2 Fail with `manual_upload_import_dir_missing` naming path, env var, and connection.
- [x] 4.3 Confirm a non-manual-upload binding still resolves to null without raising.

## 5. Stranded transplanted bindings

- [x] 5.1 Add a dry-run-default repair tool that lifts `original_source_binding` to the top level, restores `kind`, and rewrites `import_dir` to a discovered on-disk path.
- [x] 5.2 Refuse on zero and on ambiguous discovery candidates rather than guessing.
- [x] 5.3 Back up the pre-image binding in the same transaction as the write, guarded on the pre-image still being current.

## 6. Validation

- [x] 6.1 Unit-test the repair tool's envelope recognition, lift, discovery, and refusals.
- [x] 6.2 Unit-test the import-directory guard, including mutation-checking that removing it turns the tests red.
- [x] 6.3 Test the resume and pause routes, including wrong-state and foreign-target refusals.
- [x] 6.4 Typecheck polyfill-connectors, reference-implementation, console/operator-ui, and packages/mcp-server.
- [x] 6.5 Run `npx biome check` on every touched file.
