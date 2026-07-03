## Context

The reference runtime supports static external-tool metadata in connector manifests. Slack uses this to declare `slackdump`. The existing readiness implementation accepts `detect.command` and executes it with `spawn(command, { shell: true })`.

The archived external-tools design intentionally deferred runtime execution of detection metadata. Execution has since been wired in, but the manifest shape remained shell-string based. The safe sibling path already exists in `scheduler-readiness.ts`: `runExecutable(file, args, ...)` uses array-form spawning with no shell.

## Goals / Non-Goals

**Goals:**

- Eliminate shell execution from external-tool readiness checks.
- Make the manifest contract express executable plus arguments, not shell syntax.
- Reject unsafe legacy detection declarations at connector registration.
- Preserve the owner-visible readiness behavior for missing external tools.

**Non-Goals:**

- No general command runner.
- No shell metacharacter allowlist.
- No broader redesign of `runtime_requirements.external_tools`.
- No change to PDPP Core protocol semantics.

## Decisions

1. Use structured `detect.executable` and `detect.args[]`.

   Rationale: this preserves the one needed behavior, checking a binary such as `slackdump version`, without shell parsing. It also matches Node's safe child-process API boundary.

   Alternative considered: keep `detect.command` and split with a shellwords parser. Rejected because shell-string parsing is easy to get wrong and preserves the wrong abstraction.

2. Reject `detect.command` for newly registered manifests.

   Rationale: existing seed manifests can be migrated in the same change. Accepting legacy shell strings would leave the dangerous contract alive.

   Alternative considered: accept both shapes and ignore `command` at runtime. Rejected because it silently accepts a field whose only historical meaning was shell execution.

3. Keep scheduler readiness output stable.

   Rationale: this is a security hardening of the detection substrate, not a product semantics change. Missing tools should still block automatic runs with the tool name and install hint.

## Risks / Trade-offs

- Existing private manifests using `detect.command` will be rejected. Mitigation: the replacement shape is mechanical: `command: "tool subcommand"` becomes `executable: "tool", args: ["subcommand"]`.
- Arguments that previously relied on shell expansion will stop working. Mitigation: shell expansion is intentionally out of scope for readiness detection; connector authors should use explicit arguments.
- Detection still executes a local binary named by manifest metadata. Mitigation: it executes only a binary path/name with explicit args and no shell, and it is limited to readiness checks.

## Migration Plan

1. Update manifest validation to reject `detect.command` and validate `detect.executable`, `detect.args[]`, and `detect.exit_code`.
2. Update shipped manifests to use the structured shape.
3. Update scheduler readiness to call array-form spawn only.
4. Add tests that malicious shell metacharacters are inert data or rejected, and that no `shell: true` remains in the readiness path.
