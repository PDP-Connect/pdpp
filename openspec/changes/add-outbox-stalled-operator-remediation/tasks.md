## 1. Command And Evidence

- [x] 1.1 Add `pdppLocalCollectorDoctorCommand` / `pdppLocalCollectorStatusCommand` to `pdpp-cli-command.ts` with unit tests proving no base-url/token/path.
- [x] 1.2 Add `summarizeOutboxStallRemediation` to `connection-evidence.ts` with unit tests for the stalled axis, `clear_backlog` condition, and the quiet healthy/idle/active/unknown paths.

## 2. Render

- [x] 2.1 Render the remediation label as visible copy plus a copy-pasteable doctor command in `connection-diagnostics.tsx` when the outbox is stalled.
- [x] 2.2 Thread the non-secret connection identity from `page.tsx` to scope the command.
- [x] 2.3 Keep copy in operator-console voice; do not imply a remote/hosted fix.

## 3. Validation

- [x] 3.1 Run targeted `apps/console` CLI-command and diagnostics tests.
- [x] 3.2 Run `pnpm --dir apps/console run types:check`.
- [x] 3.3 Run `openspec validate add-outbox-stalled-operator-remediation --strict`.
- [x] 3.4 Run `openspec validate --all --strict`.
- [x] 3.5 Run `git diff --check`.
