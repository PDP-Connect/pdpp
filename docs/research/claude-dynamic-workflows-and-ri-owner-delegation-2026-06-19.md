# Claude Dynamic Workflows And RI Owner Delegation

Date: 2026-06-19
Owner: Codex RI owner
Status: process research note

## Question

How should PDPP use Claude dynamic workflows, ultracode-style high-effort
sessions, and waspflow lanes without losing RI-owner product judgment?

## Sources

- Anthropic Claude Code docs, "Orchestrate subagents at scale with dynamic
  workflows", retrieved 2026-06-19:
  https://code.claude.com/docs/en/workflows
- OnlyTerp UltraCode-Shim `docs/HOW_IT_WORKS.md`, retrieved 2026-06-19:
  https://github.com/OnlyTerp/UltraCode-Shim/blob/main/docs/HOW_IT_WORKS.md
- Anthropic docs, "Adaptive thinking", retrieved 2026-06-19:
  https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
- PDPP local research, `docs/research/ri-owner-orchestration-process-design-2026-06-15.md`
- PDPP local research, `docs/research/ri-owner-tmux-live-orchestration-2026-06-15.md`

## Findings

Claude dynamic workflows are a harness pattern: Claude writes an orchestration
script, fans work out to subagents, and validates/merges results before handing
back. The useful primitive is not the agent count itself; it is explicit
decomposition, isolation, scripted coordination, and verification before the
owner sees a final answer.

Ultracode is not a separate product surface that replaces judgment. The
documented mechanism is a high-effort/adaptive-thinking envelope with a larger
token ceiling and coding-oriented steering. It is appropriate for integration,
red-team review, and hard design synthesis; it is wasteful for mechanical grep,
tiny patches, or already-specified implementation.

PDPP's waspflow setup already captures the important parts of this model:
isolated worktrees, report-to-disk, live steering, wait/revise/reap, and owner
review gates. The missing behavior is not a new workflow runtime; it is stricter
owner discipline about when to delegate, how many lanes to keep active, and when
to stop workers that drift into broad exploration.

## PDPP Operating Rule

For owner-console product work, Codex should normally operate as an RI-owner
manager rather than a direct editor:

- Keep three to five bounded lanes active when there is enough accepted scope to
  parallelize.
- Use low-cost workers for mechanical audits, narrow implementation, and report
  generation; reserve high/ultracode effort for product synthesis,
  architecture, security, protocol, and adversarial review.
- Require each implementation lane to have an acceptance row, exact file scope,
  a report path, and explicit stop condition.
- Treat worker output as evidence, not acceptance. The owner thread still reads
  diffs, chooses tests, runs or obtains validation, and decides merge/deploy
  readiness.
- Do not run live/browser/pixel proof for every small lane. Do cheap unit,
  type, grep, and OpenSpec checks during integration; run browser/live proof
  after a coherent tranche exists.
- Stop or revise a worker that spends too long gathering context after the
  target is already known.

## Anti-Patterns

- Importing a workflow runtime or allowing subagents to self-merge against the
  live personal-data stack.
- Treating a large fan-out count as quality.
- Letting workers choose product direction.
- Using a browser/pixel loop before the majority of the planned tranche exists.
- Closing a user-facing promise because a local copy/test patch passed.

## Conclusion

The SLVP-aligned process is a managed-lane model: high parallelism for bounded
work, low owner burn, and centralized RI-owner judgment. Waspflow is sufficient
for the current need. Claude dynamic workflows are useful as a pattern and, when
available, as a high-breadth research/review backend, but they should not become
the authority layer for PDPP product quality.
