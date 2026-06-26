## Design

The required GitHub status context should be emitted by the job that branch protection already names: `typecheck + full test suite`. The workflow should not rely on GitHub path filtering for a required check because a skipped workflow is not a useful terminal result for autonomous merge.

The workflow will trigger on:

- `pull_request`
- `merge_group`
- `workflow_dispatch`

Inside the job, a shell classifier compares the changed files against the same reference-impacting path set the workflow previously used as its trigger filter. If a PR does not touch those paths, the job prints an explicit skip reason and exits successfully. If it does, it runs the existing install, typecheck, view-model, owner-journey, health-surface, and reference test steps.

## Alternatives

- Remove the path filter and always run the full suite. This is simpler but wastes the long reference suite on docs-only PRs.
- Add a second required workflow. This would require changing the GitHub ruleset and risks ambiguous duplicate contexts.
- Keep the current path filter. This preserves CI cost but blocks autonomous merge for PRs whose changes do not trigger the required workflow.

## Acceptance Checks

- A non-reference PR emits `typecheck + full test suite` and succeeds without dependency install or full reference tests.
- A reference-impacting PR emits the same context and runs the full existing suite.
- The workflow supports `merge_group` so it can participate in a future merge queue.
- `openspec validate ensure-required-reference-check-emits --strict` passes.
