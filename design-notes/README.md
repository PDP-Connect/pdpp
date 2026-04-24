# Design Notes

Design notes are a disciplined intake lane for requirements discovery. They are intentionally not official OpenSpec artifacts.

Use this directory for cross-cutting questions that are important enough to preserve but not ready for an OpenSpec change. If a note is tightly scoped to an existing active change, it may instead live under `openspec/changes/<change>/design-notes/`.

## Authority

Design notes do not outrank:

- root PDPP protocol specs
- canonical OpenSpec specs under `openspec/specs/`
- active OpenSpec proposals and spec deltas
- executable code and tests

If a design note conflicts with those sources, treat the note as stale context and update it.

## Required Header

New notes should start with:

```md
# Short Question Or Decision Title

Status: captured | researching | sprint-needed | decided-promote | decided-defer | superseded | archived
Owner: <name or role>
Created: YYYY-MM-DD
Updated: YYYY-MM-DD
Related: <OpenSpec change/spec, root spec, issue, or "none">

## Question

## Context

## Stakes

## Current Leaning

## Promotion Trigger

## Decision Log
```

## Status Meanings

- `captured`: worth preserving, not yet investigated.
- `researching`: facts are being gathered.
- `sprint-needed`: high-stakes enough for focused owner/design review.
- `decided-promote`: should become an OpenSpec change or root PDPP spec update.
- `decided-defer`: valid, but not actionable now.
- `superseded`: resolved or replaced by another artifact.
- `archived`: retained for history only.

## Promotion Rule

Promote the note into OpenSpec before implementation when the answer would change a protocol surface, reference contract, architecture boundary, security posture, storage model, user-facing behavior, or multi-step implementation tranche.
