## Context

`publish-pdpp-cli` made `@pdpp/cli` the public npm package for delegated
access and intentionally left reference-only commands in
`reference-implementation/cli`. That was correct for the publish tranche, but
the current dashboard now shows `pdpp run timeline ...` while the installable
package exposes only `connect`, `token`, and `package-info`. The result is one
binary name with two meanings.

Prior art points to a stronger shape:

- AWS uses one base command with explicit top-level command groups
  (`aws <command> <subcommand>`).
- Vercel exposes one npm-installed `vercel` CLI with both user and operator-ish
  commands in one command tree.
- Wrangler recommends local project installation for version pinning while
  retaining one `wrangler` command.
- Google Cloud uses one `gcloud` CLI with installable components for alpha,
  beta, preview, and additional tools.
- GitHub CLI and kubectl allow extensions/plugins, but both prevent extensions
  from overriding core commands; plugin ambiguity is explicitly treated as a
  risk, not a desirable user experience.

For PDPP, the analogous SLVP shape is one public `pdpp` command tree with clear
namespaces. It should not publish a second package that also owns the `pdpp`
binary, and it should not rely on dashboard copy to explain an accidental split.

## Goals / Non-Goals

**Goals:**

- Make `@pdpp/cli` the single public owner of the `pdpp` binary.
- Add an explicit reference namespace for operator diagnostics:
  `pdpp ref run timeline`, `pdpp ref grant timeline`, and `pdpp ref trace show`.
- Publish only HTTP-only reference read commands in `@pdpp/cli`; keep
  server-coupled or mutation-heavy local-dev commands repo-local until separately
  designed.
- Provide a better owner-session UX than manually copying a cookie for routine
  operator reads.
- Keep backward-compatible repo-local aliases for existing `pdpp run timeline`,
  `pdpp grant timeline`, and `pdpp trace show` during the migration, but stop
  advertising those aliases.
- Update dashboard/docs/help so every displayed command states whether it uses
  the public npm package or a repo-local checkout.

**Non-Goals:**

- Do not make `_ref` routes part of core PDPP protocol.
- Do not publish the reference server, connector runtime, Docker orchestration,
  database helpers, seed fixtures, or local deployment commands inside
  `@pdpp/cli`.
- Do not solve broad CLI plugin architecture in this tranche.
- Do not require npm stable/latest promotion; beta remains acceptable until the
  full command surface is proven.

## Decisions

1. **One public package, one public binary.**

   `@pdpp/cli` remains the only npm package that publishes `bin.pdpp`. A second
   public package such as `@pdpp/reference-cli` that also exposes `pdpp` would
   recreate the current ambiguity at install time. A separate package could
   exist later only if it exposes a different binary or an explicit extension
   mechanism.

2. **Reference diagnostics live under `pdpp ref ...`.**

   The command namespace should make authority visible at the command line:
   `pdpp connect` is public delegated access; `pdpp ref ...` is reference
   operator inspection over `_ref` routes. `ref` is short enough for routine
   use and explicit enough to avoid implying protocol normativity.

   Rejected alternatives:

   - Keep top-level `pdpp run timeline`: too easy to confuse with a protocol or
     public data-run command later.
   - Use `pdpp operator ...`: accurate but longer and less aligned with the
     existing `_ref` naming.
   - Use a plugin package now: premature; PDPP does not yet need third-party CLI
     extension loading, and prior art treats plugin conflict as a risk to guard.

3. **Only HTTP-only read commands move into the public package now.**

   `run timeline`, `grant timeline`, and `trace show` already call HTTP `_ref`
   routes and can be made publishable by moving small fetch/output/reference URL
   helpers into `packages/cli`. They do not need server modules, database access,
   Docker, fixtures, or connector runtime imports.

   Commands such as `seed`, local owner bootstrap, broad local agent cache
   management, or server-dev shortcuts stay in `reference-implementation/cli`
   until each command has a publishability/security review.

4. **Owner-session UX should be first-class but bounded.**

   Initial support can keep `PDPP_OWNER_SESSION_COOKIE` and `--owner-session`
   for non-interactive use, but the ideal surface is a `pdpp ref login <url>`
   command that obtains an owner session through the existing owner-login route
   and stores it in the project-local `.pdpp/` cache with secret permissions.
   The CLI should never print the cookie value unless an explicit debug flag is
   added later.

   This keeps the current security posture (owner session, not owner bearer
   token) while removing a token-wasting operational footgun.

5. **The reference wrapper becomes a compatibility shell.**

   `reference-implementation/cli/index.js` should delegate public commands and
   `pdpp ref ...` to `packages/cli`. It may retain legacy top-level aliases for
   `run timeline`, `grant timeline`, and `trace show` with deprecation copy, so
   local scripts do not break immediately. New dashboard/docs copy should not
   use the legacy aliases.

6. **Validation proves package boundaries and copy consistency.**

   Acceptance requires tests at three levels: package CLI tests for `pdpp ref`
   command parsing and owner-session headers, reference integration tests
   against a running `_ref` route, and dashboard/docs grep tests proving no
   surfaced command still advertises the legacy top-level operator aliases.

## Risks / Trade-offs

- **Public package exposes reference-only routes** -> Mitigate by putting every
  command under `pdpp ref`, labeling `_ref` as reference-only in help output,
  and requiring owner-session auth when enabled.
- **Owner-session cache becomes a secret-handling surface** -> Mitigate with
  project-local cache storage, `0600` file mode, no stdout cookie printing, and
  tests for permissions and redaction.
- **Moving too many commands into npm bloats/supports the wrong thing** ->
  Mitigate by moving only HTTP-only read diagnostics in this tranche.
- **Backward compatibility hides the migration** -> Mitigate by keeping aliases
  repo-local and not advertising them in package help, dashboard, metadata, or
  docs.
- **Package/docs drift recurs** -> Mitigate with tests that derive dashboard
  command examples from package metadata or assert exact command strings.
