## 1. OpenSpec

- [x] 1.1 Add governance requirement delta for required checks emitting terminal statuses.
- [x] 1.2 Validate the OpenSpec change strictly.

## 2. Workflow

- [x] 2.1 Remove the workflow-level pull-request path filter from `.github/workflows/reference-implementation.yml`.
- [x] 2.2 Add `merge_group` support.
- [x] 2.3 Add an in-job reference-impact classifier with the existing path set.
- [x] 2.4 Gate expensive install/test steps on the classifier while keeping the required job name unchanged.

## 3. Validation

- [x] 3.1 Run a local syntax/parse check for the workflow YAML.
- [x] 3.2 Run `openspec validate ensure-required-reference-check-emits --strict`.
- [x] 3.3 Run `git diff --check`.
