## Design

The source-detail header already receives a typed `RunNowResult` from the
server action. The console should render that result directly instead of
waiting for the refreshed health projection to catch an active run.

The active-run projection remains important for long-running syncs and for
page-load state. It is not sufficient as the only acknowledgement for short
syncs because a connector such as GitHub can complete in seconds.

## Alternatives

- **Redirect to the sync timeline after every click.** Clear, but too heavy for
  routine refreshes and inconsistent with the source-list drawer.
- **Poll until the run appears.** Still fails when the run starts and completes
  between polls; also adds unnecessary background work.
- **Render the server-action result locally.** Chosen. It is immediate,
  connection-scoped, and already has the run id.

## Acceptance Checks

- A successful source-detail `Sync now` shows a local success message.
- When a run id is returned, the message links to `/syncs/<run_id>`.
- A fast run does not leave the button stuck in an optimistic running state.
- Existing before/after-server failure classification remains intact.
