# Add local collector deployment-posture surface

## Why

`docs/local-collector.md` already documents how to tell whether a host runs a
**published** `@pdpp/local-collector` or a **repo `dist/` dev override**: run
`command -v`, `readlink -f`, and cross-check the reported version. That is a
manual, easy-to-skip ritual. Live evidence has already been captured from a host
whose `pdpp-local-collector` resolved into a repo `packages/local-collector/dist/`
tree, which is valid for development but must not masquerade as published
operator-host evidence.

The honest signal — is this collector running from a published package, a pinned
explicit version, or a repo/dev override — is derivable at runtime from the
running module's own resolved location and the package manifest the CLI already
reads. The CLI should surface it as redaction-safe machine-readable evidence so
operators and agents stop relying on "remember to run `readlink`".

## What Changes

- `pdpp-local-collector status` and `doctor` gain a redaction-safe
  `deployment_posture` block: package version, a `kind` classification
  (`published_package`, `repo_dist_override`, `unknown`), a `latest`-placeholder
  flag, and a redacted/classified module-location descriptor (never a full home
  path).
- `doctor` gains a `deployment_posture` check that warns (not errors) when the
  running collector is a `repo_dist_override` or is reporting the `0.0.0`
  placeholder version, with a static remediation hint.
- New fields are additive; existing `status`/`doctor` JSON consumers keep every
  current field.

## Capabilities

### Modified

- `local-collector-durable-work` — the connection-scoped health surface gains a
  deployment-posture requirement.

## Impact

- `packages/local-collector/bin/pdpp-local-collector.ts` — posture detection +
  `status`/`doctor` output.
- `packages/local-collector/test/runner.test.js` — published-like vs
  repo-dist-like classification, redaction, and doctor-severity tests.
- `docs/local-collector.md` — point the manual recipe at the mechanical block.
