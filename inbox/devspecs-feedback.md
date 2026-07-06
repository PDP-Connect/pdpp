# Devspecs Feedback

## 2026-06-24 — RI bucket endpoint worktree

- Task: `ds task quick "add index-backed Explore bucket-count endpoint"` in `~/.tmp/pdpp-ri-index-backed-buckets`.
- Result: `ds init --yes` reported the repo was already initialized, then `ds task quick` began auto-indexing (`4889 candidate file(s); skipped 11 ignored/heavy directories`) and produced no further output for over 60 seconds.
- Action: stopped it with Ctrl-C and continued manually.
- Feedback: for a real multi-step coding task, the quick-task path felt too blocking during repo indexing. A visible progress rate, timeout guidance, or a `--no-index/--defer-index` mode would make it safer to use opportunistically.

## 2026-07-06 — tmp leak cleanup

- Task: `ds task quick "stop observed test mkdtemp leaks in reference implementation"` in the repo root.
- Result: task auto-index started and printed `discovered 26012 candidate file(s); skipped 77 ignored/heavy directories`, then did not complete after repeated waits.
- Action: stopped it with Ctrl-C and continued manually.
- Feedback: same friction as the earlier RI bucket run: quick-task indexing can become a blocking side quest on large repos. It would help to emit a progress rate/ETA and offer a clear `--defer-index` path for focused hotfixes.
