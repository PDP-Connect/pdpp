## Status

Superseded by `add-mock-reference-demo-instance`. These tasks describe the rejected scenario-first sandbox attempt and
should not be used as implementation guidance for the primary sandbox route family.

## 1. Sandbox Data Model

- [x] 1.1 Create a small seeded sandbox scenario module with fictional connectors, streams, records, grants, and API-shaped examples.
- [x] 1.2 Ensure all seeded data is obviously fictional and contains no real credentials, emails, bank details, tokens, or platform identifiers.
- [x] 1.3 Model the walkthrough states needed for request, consent, access, revocation, denied access, and reset.

## 2. Functional UI

- [x] 2.1 Replace placeholder copy on `/sandbox` with an end-user-facing demo surface that explains the value of PDPP without saying the sandbox is future work.
- [x] 2.2 Implement an interactive walkthrough where visitor actions visibly change simulated grant/access state.
- [x] 2.3 Add inspectable API-shaped panels for each step, clearly labeled as simulated.
- [x] 2.4 Add a reset control that returns the sandbox to seeded initial state.
- [x] 2.5 Preserve distinct simulated chrome/labeling so the page cannot be mistaken for the live `/dashboard`.

## 3. Evidence And Navigation

- [x] 3.1 Update `/reference/coverage` sandbox rows so demonstrated claims link to the functional sandbox flow and still expose remaining gaps honestly.
- [x] 3.2 Ensure `/reference`, `/docs`, and `/sandbox` CTAs frame the sandbox as mock education, not a hosted live reference instance.
- [x] 3.3 Keep `/dashboard` out of the public sandbox flow except for copy that distinguishes live local operation from simulation.

## 4. Quality Gates

- [x] 4.1 Add tests or stable assertions for key sandbox state transitions where practical.
- [x] 4.2 Run `openspec validate make-public-sandbox-functional --strict`.
- [x] 4.3 Run `openspec validate --all --strict`.
- [x] 4.4 Run `pnpm --dir apps/web run types:check`.
- [x] 4.5 Run `pnpm --dir apps/web run check`.
- [x] 4.6 Run `pnpm --dir apps/web run build`.
- [x] 4.7 Write a merge-queue report with files changed, validations, screenshots or route checks if available, residual risks, and `git status --short`.
