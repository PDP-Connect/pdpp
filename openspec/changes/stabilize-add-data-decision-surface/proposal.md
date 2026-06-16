# Stabilize Add Data Decision Surface

## Why

The live Add data page no longer shows the earlier Strava/Pocket false setup buttons, but it still fails the owner journey. The default page is a tall set of repeated cards, every card exposes the same "Why this" disclosure, and rich import sources expand into nested instructions and existing-source controls inside the picker. A motivated owner should be able to scan what can be added now, choose one real path, and only then see detailed instructions.

## What Changes

- Make `/dashboard/records/add` a compact decision surface by default.
- Keep available sources comparable: one source name, one short method line, one current support fact, and one real next action.
- Move acquisition paths, existing-source reuse, and detailed guidance behind post-intent disclosure or destination pages rather than inline card expansion.
- Summarize server-prerequisite and unavailable sources outside the primary add-now flow.
- Add live evidence and scanner gates so repeated detail copy and false-action relabeling do not return.

## Capabilities

Modified:

- `reference-surface-topology`

## Impact

This is an owner-console reference implementation change. It does not change PDPP Core protocol semantics or connector runtime behavior. It changes how the reference console presents source setup choices and how the Add data journey is accepted.
