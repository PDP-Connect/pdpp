## Scope

This is a minimal follow-up stub created by `clean-up-openspec-corpus` from `reports/spec-gap-audit.md`.

The change should define reference-specific runtime commitments only after the active polyfill connector program has made the relevant product decisions. It should not preempt root PDPP Collection Profile semantics.

## Expected Coverage

- Runtime `START` / `INTERACTION` / `RECORD` / `STATE` / `DONE` handling where the behavior is reference-specific.
- Scheduler lifecycle behavior and persistence boundaries.
- Browser-profile binding and connector filesystem binding.
- Polyfill connector JSONL logging, coercion, and redaction expectations.
- Inbox and notification runtime behavior if those features graduate from the active program.

## Non-Goals

- Changing runtime code as part of this stub.
- Deciding product scope for connector configuration, credential storage, or partial-run semantics.
- Rewriting root PDPP protocol requirements.

## Acceptance Checks

- `openspec validate add-reference-runtime-spec --strict`
- Runtime product decisions are captured in this change before canonical requirements are expanded.
