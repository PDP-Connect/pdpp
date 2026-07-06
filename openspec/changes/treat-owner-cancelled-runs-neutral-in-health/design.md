## Design

The read model should distinguish "the connector failed" from "the owner stopped this run." Both are terminal timeline facts, but only the former should drive `CollectionSucceeded=false`, maintainer `code_fix` actions, or terminal coverage failures.

The source-health projection will ignore owner-cancelled terminal runs when deriving run-health failure status, reason code, and coverage from the latest run. The latest successful run and freshness evidence remain unchanged, so the owner still sees whether retained data is stale.

This does not hide connector-reported cancellation errors. A connector that reports `status=cancelled` with a connector error remains inspectable in the run timeline. The health projection only treats owner-cancel terminal reasons (`owner_cancelled`, `owner_cancel_forced`) as neutral.

## Alternatives Considered

- Repair only the live Slack row. Rejected because the same bad UI classification would recur for the next correctly cancelled scheduler-direct run.
- Treat every `cancelled` status as neutral. Rejected because connector-declared cancellation can still carry source/connector failure evidence.
- Leave cancellation as a failure but change copy. Rejected because maintainer-code-fix classification would still be semantically wrong.

## Acceptance Checks

- A latest run with `status=cancelled` and `failure_reason=owner_cancelled` or `owner_cancel_forced` does not project `CollectionSucceeded=false`.
- The same owner-cancelled run does not produce a maintainer `code_fix` required action.
- A normal failed run with `connector_exit_without_done` still projects failure.
- Existing source-health and connector-summary tests pass.
