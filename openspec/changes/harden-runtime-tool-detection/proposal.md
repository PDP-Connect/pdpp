## Why

Connector manifests can currently declare `runtime_requirements.external_tools[].detect.command` as a shell command string, and the scheduler readiness path executes that string with `shell: true`. Manifest-controlled shell execution is unnecessary for shipped connectors and creates a command-injection class bug.

## What Changes

- Replace shell-string tool detection with structured executable detection.
- Treat `detect.command` as a legacy input that is rejected for newly registered manifests.
- Allow `detect.executable` plus optional `detect.args[]` and `detect.exit_code`.
- Run detection with array-form child process spawning and no shell.
- Keep connector readiness output behavior the same: missing tools produce a readiness failure with the declared tool name and install hint.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `polyfill-runtime`: external tool detection becomes structured and non-shell-executed.

## Impact

- Affects connector manifest validation, scheduler readiness checks, and the Slack manifest's external-tool detection declaration.
- No shipped polyfill connector needs shell metacharacter behavior.
- Runtime behavior stays bounded to detecting whether a declared external tool is available.
