## 1. Command Boundary Inventory

- [x] 1.1 Inventory `packages/cli` and `reference-implementation/cli` commands into public, publishable-reference, and repo-local-only categories.
- [x] 1.2 Confirm `run timeline`, `grant timeline`, and `trace show` are HTTP-only and safe to expose under `pdpp ref ...`.
- [x] 1.3 Identify any helper modules that must move from `reference-implementation/cli/lib` into `packages/cli` without importing server-only code.

## 2. Public CLI Reference Namespace

- [x] 2.1 Add `pdpp ref run timeline <run-id>` to `packages/cli`.
- [x] 2.2 Add `pdpp ref grant timeline <grant-id>` to `packages/cli`.
- [x] 2.3 Add `pdpp ref trace show <trace-id>` to `packages/cli`.
- [x] 2.4 Add shared reference URL, owner-session header, fetch, and output helpers inside the public CLI package.
- [x] 2.5 Add package CLI help text that labels `pdpp ref ...` as reference-only operator diagnostics.

## 3. Owner Session UX

- [x] 3.1 Support `--owner-session <cookie-or-value>` for `pdpp ref ...` commands without printing the cookie.
- [x] 3.2 Preserve `PDPP_OWNER_SESSION_COOKIE` support for automation.
- [x] 3.3 Add `pdpp ref login <reference-url>` or an equivalent owner-session command that stores an owner session in the project-local `.pdpp/` cache with secret permissions.
- [x] 3.4 Add bounded errors for missing, expired, or rejected owner sessions.

## 4. Reference Wrapper Migration

- [x] 4.1 Make `reference-implementation/cli/index.js` delegate `pdpp ref ...` to `packages/cli`.
- [x] 4.2 Keep repo-local legacy aliases for `pdpp run timeline`, `pdpp grant timeline`, and `pdpp trace show` as compatibility aliases.
- [x] 4.3 Add deprecation/help copy for legacy aliases that points to the canonical `pdpp ref ...` commands.
- [x] 4.4 Keep repo-local-only commands such as seed or server-coupled helpers out of `@pdpp/cli` help and package exports.

## 5. Dashboard, Docs, And Metadata

- [ ] 5.1 Update dashboard timeline and peek copy to use `pdpp ref ...` commands.
- [ ] 5.2 Update reference docs and package README to explain public `connect` versus reference `ref` namespaces.
- [ ] 5.3 Ensure public agent-connect metadata continues to advertise `npx -y @pdpp/cli@beta connect <provider-url>` rather than reference-operator commands.
- [ ] 5.4 Add or update validation that rejects surfaced legacy examples such as `pdpp run timeline` outside compatibility/help context.

## 6. Validation

- [x] 6.1 Add package tests for `pdpp ref` parsing, JSON/table output, owner-session header handling, and missing-session errors.
- [x] 6.2 Add reference CLI tests proving wrapper delegation and legacy alias compatibility.
- [x] 6.3 Add package-smoke coverage proving `@pdpp/cli` can pack/install with the new `ref` commands and without server-only files.
- [x] 6.4 Run `pnpm --filter @pdpp/cli test`.
- [x] 6.5 Run relevant `reference-implementation` CLI tests.
- [ ] 6.6 Run relevant web checks for dashboard/docs copy.
- [x] 6.7 Run `openspec validate unify-pdpp-cli-command-surface --strict`.
