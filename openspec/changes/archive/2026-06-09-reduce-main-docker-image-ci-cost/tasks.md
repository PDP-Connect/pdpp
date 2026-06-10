## 1. OpenSpec

- [x] 1.1 Add proposal, design, and spec delta for reduced default-branch Docker image publication.
- [x] 1.2 Validate `reduce-main-docker-image-ci-cost` with `openspec validate --strict`.
- [x] 1.3 Validate all OpenSpec changes with `openspec validate --all --strict`.

## 2. Workflow

- [x] 2.1 Update `.github/workflows/docker-images.yml` so default-branch pushes run validation only.
- [x] 2.2 Keep image publication on explicit trusted publishing events only.
- [x] 2.3 Narrow Docker workflow path filters to image-affecting inputs.

## 3. Documentation and verification

- [x] 3.1 Update README Docker image tag wording so `:main` is not promised as an every-commit publish.
- [x] 3.2 Run a workflow syntax/render check or equivalent static validation.
- [x] 3.3 Re-run the Actions-cost inventory command and record the expected reduction.
