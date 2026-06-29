## Context

The stream companion page polls the run timeline while an owner operates a browser surface. When the current assistance disappears, the page previously rendered the resolved surface unconditionally. That conflated "no pending assistance" with "run succeeded."

Live evidence showed a manual ChatGPT reconnect run selecting the correct browser profile, failing fast with a missing-session/static-credential error, and then leaving the owner-facing stream in a success-shaped terminal view.

## Decision

Introduce an explicit no-assistance stream state derived from the run timeline's page-independent `terminal_status`:

- `completed` renders the existing resolved copy.
- `failed`, `cancelled`, and `abandoned` render an ended surface that points to the run timeline.
- `null` renders a continuing surface that says no browser action is waiting and points to the run timeline.

The stream page SHALL NOT claim recovery unless the run terminal status is completed.

## Alternatives

### Infer from the latest visible event

Rejected. The timeline can be paginated. The existing `terminal_status` envelope field exists specifically to avoid page-window inference.

### Keep the success copy and rely on source cards to correct it

Rejected. The stream page is the surface the owner sees immediately after acting. It must be locally honest.

## Acceptance checks

- A failed assisted run with no current browser assistance renders failure/ended copy, not success copy.
- A completed assisted run with no current browser assistance keeps the existing success copy.
- A still-running run with no current browser assistance does not claim success.
- The implementation uses `terminal_status`, not connector-specific strings.
