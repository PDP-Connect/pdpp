## Context

The repo now has two different things casually called “reference”:

- the website/reference experience in `apps/web`
- the forkable implementation substrate in `e2e/`

Spec authors would describe the latter as the **reference implementation**. Leaving it under `e2e/` makes it sound like a test harness. Renaming it to `reference-implementation/` gives it the right status without overloading the shorter `reference/` label that is already used elsewhere in the repo.

## Goals / Non-Goals

**Goals:**
- Make the forkable implementation package publishable under a name that matches what it is.
- Keep the active docs and OpenSpec layer aligned with the rename.
- Avoid churn in archival notes that are no longer on an active path.

**Non-Goals:**
- Renaming every historical mention of `e2e` in the repo.
- Reworking the website’s broader “reference” vocabulary in the same tranche.
- Changing protocol semantics or implementation behavior.

## Decisions

### Decision: Use `reference-implementation/` as the directory name

This is more explicit than `reference/` and avoids ambiguity with the website’s existing “reference” surfaces.

Alternatives considered:
- `reference/`
  - Rejected for now because the repo already uses “reference” for the site and narrative surfaces.
- `reference-impl/`
  - Rejected because it is shorter but less polished for published material.

### Decision: Update only active references in this tranche

The rename should cover:
- code and tests
- active docs
- active OpenSpec artifacts

It should not churn:
- `docs/archive/**`
- superseded inbox notes
- dead demo planning artifacts

## Risks / Trade-offs

- Some historical markdown links will point at the old path after the rename.
  - Accepted. Those docs are already archival and not used to steer current work.
- The repo will still have “reference” overlap between the implementation and the website.
  - Accepted for now. `reference-implementation/` is precise enough to avoid confusion in active paths.
