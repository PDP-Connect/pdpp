# Injected-defect checks

Controlled HTTP fixtures; neither pinned live target was modified. Each matching case passed without its defect and failed with it. Five assertions passed, zero failed.

| Defect | Matching case | Clean | Injected |
| --- | --- | --- | --- |
| ignore-grant-streams | RS-2/ungranted-stream-refused | pass | fail |
| ignore-field-projection | RS-2/field-projection-not-exceeded | pass | fail |
| per-instance-limit-concatenated | RS-1/list-page-size-bounded-by-limit-across-instances | pass | fail |
| first-reference-only | RS-1/shared-blob-readable-through-any-authorized-reference | pass | fail |
