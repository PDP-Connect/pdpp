# Console grants safe review

## Why

The Grants queue currently issues a consent grant from a list-row action without showing the complete stored request or requiring a final confirmation.

## What Changes

- Add an owner-session-only reference approval-detail projection keyed by opaque `approval_id`.
- Replace queue-row approval with a review route and a final confirmation step.
- Preserve direct denial and existing approval semantics, including affirmative AI-training consent.

## Capabilities

### Modified

- `reference-implementation-architecture`: the reference approval queue gains a safe detail read and the console approval path gains a review-before-issue boundary.

## Impact

- `GET /_ref/approvals/:approval_id` is a reference/operator endpoint, not a PDPP protocol surface.
- The operator console, reference route adapter, safe projection, and approval tests change.
