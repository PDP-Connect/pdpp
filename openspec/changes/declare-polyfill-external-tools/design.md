## Context

External subprocess tools are a distinct dependency class. They are not:

- runtime bindings like network, filesystem, browser, or interactive;
- language/package dependencies installed with the connector package;
- owner credentials.

Slack is the current concrete case: the connector wraps `slackdump` and reads its SQLite archive. Without manifest metadata, reviewers see only network/filesystem requirements and miss the AGPL subprocess dependency.

## Decision

Add static manifest metadata:

```json
{
  "runtime_requirements": {
    "external_tools": [
      {
        "name": "slackdump",
        "license": "AGPL-3.0",
        "purpose": "Session-token Slack archive export",
        "install_hint": "go install github.com/rusq/slackdump/v4/cmd/slackdump@latest",
        "detect": {
          "command": "slackdump --help",
          "exit_code": 0
        }
      }
    ]
  }
}
```

The reference validates the shape, including optional `detect` metadata, but does not execute detection commands in this slice.

## Non-Goals

- No `detect.command` execution in this slice.
- No `setup_required` interaction kind in this slice.
- No consent-card redesign in this slice.
- No attempt to model language package dependencies.

## Acceptance

- Slack declares `runtime_requirements.external_tools` with `slackdump`, license, purpose, and install hint.
- Connector registration rejects malformed `external_tools` declarations.
- A test fails if a connector references a known external binary without declaring it in its manifest.
