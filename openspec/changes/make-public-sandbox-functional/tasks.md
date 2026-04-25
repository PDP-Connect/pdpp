## 1. Sandbox Data Model

- [ ] 1.1 Create a small seeded sandbox scenario module with fictional connectors, streams, records, grants, and API-shaped examples.
- [ ] 1.2 Ensure all seeded data is obviously fictional and contains no real credentials, emails, bank details, tokens, or platform identifiers.
- [ ] 1.3 Model the walkthrough states needed for request, consent, access, revocation, denied access, and reset.

## 2. Functional UI

- [ ] 2.1 Replace placeholder copy on `/sandbox` with an end-user-facing demo surface that explains the value of PDPP without saying the sandbox is future work.
- [ ] 2.2 Implement an interactive walkthrough where visitor actions visibly change simulated grant/access state.
- [ ] 2.3 Add inspectable API-shaped panels for each step, clearly labeled as simulated.
- [ ] 2.4 Add a reset control that returns the sandbox to seeded initial state.
- [ ] 2.5 Preserve distinct simulated chrome/labeling so the page cannot be mistaken for the live `/dashboard`.

## 3. Evidence And Navigation

- [ ] 3.1 Update `/reference/coverage` sandbox rows so demonstrated claims link to the functional sandbox flow and still expose remaining gaps honestly.
- [ ] 3.2 Ensure `/reference`, `/docs`, and `/sandbox` CTAs frame the sandbox as mock education, not a hosted live reference instance.
- [ ] 3.3 Keep `/dashboard` out of the public sandbox flow except for copy that distinguishes live local operation from simulation.

## 4. Quality Gates

- [ ] 4.1 Add tests or stable assertions for key sandbox state transitions where practical.
- [ ] 4.2 Run `openspec validate make-public-sandbox-functional --strict`.
- [ ] 4.3 Run `openspec validate --all --strict`.
- [ ] 4.4 Run `pnpm --dir apps/web run types:check`.
- [ ] 4.5 Run `pnpm --dir apps/web run check`.
- [ ] 4.6 Run `pnpm --dir apps/web run build`.
- [ ] 4.7 Write a merge-queue report with files changed, validations, screenshots or route checks if available, residual risks, and `git status --short`.
