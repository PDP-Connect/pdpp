# Design

## Goal

Allow the project to commit high-signal connector fixtures without committing private owner data.

## Pipeline

The pipeline should have three stages:

1. Raw capture into ignored directories.
2. Deterministic redaction for known patterns and connector-specific fields.
3. LLM-assisted semantic redaction for free-form text that may contain names, addresses, merchants, personal notes, and message content.

The final scrubbed fixture should be reviewed before commit and should preserve selector/API shape, field names, timestamps where safe, and enough realistic structure to catch parser drift.

The LLM-assisted stage is implemented as an offline structured redaction-plan mode rather than a direct model call. A worker may use an LLM or human reviewer to identify exact free-form substrings, but the scrubber only accepts local JSON plans shaped as:

```json
{
  "version": 1,
  "redactions": [
    {
      "text": "Alice Example",
      "replacement": "[REDACTED_NAME]",
      "reason": "person name in delivery status"
    }
  ]
}
```

This keeps fixture generation deterministic, keyless in tests, and fail-closed. When `--llm-redactions-dir` is provided, every raw file in the run must have a corresponding plan file, every replacement must be a `[REDACTED_*]` placeholder, and every target string must still exist after deterministic rules run. Missing, malformed, or stale plans stop the run before scrubbed files for that run are written.

The pilot fixtures use synthetic real-shape captures to prove the workflow without committing raw owner data: Amazon covers a browser DOM shape and GitHub covers an API JSON shape.

## Non-Goals

- No connector extraction redesign.
- No production privacy guarantee for arbitrary third-party data.
- No use of scrubbed fixtures as proof that live account ingestion works.

## Acceptance Checks

- Raw fixture directories remain gitignored.
- Scrubbed fixture generation is repeatable enough for code review.
- Tests can use scrubbed fixtures without requiring live credentials.
- Redaction failures are obvious enough to stop a fixture from being committed.
