## Why

The main ruleset requires the `typecheck + full test suite` status check, but the workflow that emits that context is path-filtered. PRs that do not touch the filtered paths can become blocked because the required context never appears.

## What Changes

- Make the reference-implementation workflow trigger for every pull request and merge-group.
- Keep the required job/context name stable.
- Add a path classifier inside the job so non-reference PRs complete the required context successfully without running the heavy suite.

## Capabilities

Modified:

- `reference-implementation-governance`

## Impact

- Docs/research/policy PRs get an explicit required check result instead of a missing required context.
- Reference-impacting PRs still run the same typecheck and test suite.
- This does not deploy, release, or mutate live data.
