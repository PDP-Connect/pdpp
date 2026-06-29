## Why

The run interaction stream can label a run with the first connector summary for a connector type. When an owner has multiple ChatGPT connections, a dondochaka run can render copy for everyone@appears.blue.

## What Changes

- Resolve run-stream subject copy by `connector_instance_id` / `connection_id` before falling back to connector type.
- Keep connector-type fallback for older references that do not return instance identity.
- Add a focused invariant test for multi-connection stream labels.

## Capabilities

Modified:

- `reference-run-assistance`

## Impact

- Browser-session stream copy names the connection that owns the run.
- No connector run, credential, grant, or data-path behavior changes.
