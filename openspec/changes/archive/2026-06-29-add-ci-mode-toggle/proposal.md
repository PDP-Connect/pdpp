## Why

Hosted GitHub Actions can fail before running code because of account or platform availability. The repository needs a documented, auditable way to temporarily require local CI signoff without weakening the merge gate or hand-editing rulesets.

## What Changes

- Add a repository CI-mode switch for the main branch ruleset.
- Support hosted mode (`typecheck + full test suite`) and local mode (`signoff/reference-implementation`).
- Add a local signoff command that posts the required commit status after local verification.
- Document when local mode is appropriate and how to return to hosted mode.

## Capabilities

Modified:
- `reference-implementation-governance`

## Impact

- Maintainers can unblock merges during hosted CI infrastructure outages using an explicit, auditable status context.
- Pull-request and non-fast-forward protections remain unchanged.
- Hosted CI remains the default posture.
