## 1. Policy And Spec

- [x] 1.1 Document the package-release policy for all publishable PDPP npm packages.
- [x] 1.2 Add OpenSpec release-governance requirements for npm package publication and versioning.

## 2. Enforcement

- [x] 2.1 Add a repo-local package-release policy checker.
- [x] 2.2 Add a root `pnpm release:policy-check` script.
- [x] 2.3 Run the policy checker in the semantic-release quality job.

## 3. Validation

- [x] 3.1 Run `pnpm release:policy-check`.
- [x] 3.2 Run `openspec validate standardize-pdpp-package-publishing --strict`.
- [x] 3.3 Run `openspec validate publish-pdpp-local-collector --strict`.
- [x] 3.4 Run package verification for current publishable packages.
