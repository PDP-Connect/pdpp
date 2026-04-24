# Design

## Goal

Allow the project to commit high-signal connector fixtures without committing private owner data.

## Pipeline

The pipeline should have three stages:

1. Raw capture into ignored directories.
2. Deterministic redaction for known patterns and connector-specific fields.
3. LLM-assisted semantic redaction for free-form text that may contain names, addresses, merchants, personal notes, and message content.

The final scrubbed fixture should be reviewed before commit and should preserve selector/API shape, field names, timestamps where safe, and enough realistic structure to catch parser drift.

## Non-Goals

- No connector extraction redesign.
- No production privacy guarantee for arbitrary third-party data.
- No use of scrubbed fixtures as proof that live account ingestion works.

## Acceptance Checks

- Raw fixture directories remain gitignored.
- Scrubbed fixture generation is repeatable enough for code review.
- Tests can use scrubbed fixtures without requiring live credentials.
- Redaction failures are obvious enough to stop a fixture from being committed.
