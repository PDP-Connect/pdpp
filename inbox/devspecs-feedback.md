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

## 2026-07-06 — remote-surface CDP backend lane

- Task: `ds task "make packages/remote-surface CDP backend first-class" --slice ...` in the remote-surface CDP backend worktree.
- Result: full task indexing completed after roughly 90 seconds and produced a useful task workspace at `devspecs/tasks/20260706-172733-make-packages-remote-surface-cdp-backend-first-c/`.
- Action: used the A01 plan as a cross-check, but continued to verify source/tests manually because the task warned that newly-created OpenSpec files were not in the indexed candidate set.
- Feedback: for multi-step feature work, the full `ds task` packet was more useful than prior `quick` attempts. The freshness warning was accurate, but newly-created files during the same session make the index look stale immediately; a `ds task refresh-current` or clearer "created after index" classification would reduce uncertainty.

## 2026-07-08 — remote-surface viewport-match lane

- Task: `ds task "build remote-surface dry viewport-match closed loop" --slice ...` in the remote-surface viewport-match worktree.
- Result: full task indexing completed quickly after dependencies were already local and produced A01/A02/A03 task packets. The packet was directionally useful as a work ledger, but its predicted file set skewed toward protocol/reference files and missed the new client controller/OpenSpec files created during the same run.
- Action: used the task as a bounded-work reminder, then manually inspected the actual package helpers, playground, and tests.
- Feedback: the "newly-created files not in indexed candidate set" warning was accurate. For code lanes that create new files, it would be useful if `ds task` classified those as "created after task index" and offered a lightweight refresh instead of making the pack feel stale immediately.
