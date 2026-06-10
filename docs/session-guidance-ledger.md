# Session Guidance Ledger — Operator Guide

A rerunnable extractor that scans Codex session JSONL logs for durable user guidance: process rules, design decisions, deferred tasks, corrections, feature commitments, SLVP constraints, and "remember" items.

## Quick start

```bash
# Scan the last week of sessions, redact sensitive values, write report
python3 scripts/extract-guidance.py \
  --since 2026-05-20 \
  --min-confidence 70 \
  --redact \
  --output tmp/workstreams/session-guidance-ledger.jsonl \
  --report tmp/workstreams/session-guidance-ledger-report.md
```

Output:
- `*.jsonl` — one JSON object per extracted item (machine-readable, grep-friendly)
- `*-report.md` — deduplicated markdown grouped by category

## CLI reference

```
python3 scripts/extract-guidance.py [OPTIONS] [LOG_FILE_OR_DIR...]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--output FILE` | stdout | JSONL output path |
| `--report FILE` | none | Markdown report path |
| `--since DATE` | all | Only files modified after `YYYY-MM-DD` |
| `--limit N` | 0 (all) | Stop after N items |
| `--category CAT` | all | Filter by category (repeatable) |
| `--min-confidence N` | 40 | Minimum score 0–100 |
| `--redact` | off | Mask bearer tokens, UUIDs |

If no path argument is given, defaults to `~/.codex/sessions/`.

## Categories extracted

| Category | What it captures |
|----------|-----------------|
| `explicit_directive` | "always", "never", "must", "do not" statements |
| `process_rule` | "before every", "each time", workflow definitions |
| `design_decision` | "we decided", "going forward", architecture statements |
| `deferred_task` | TODO/FIXME, "we will add", "later", backlog items |
| `feature_commitment` | "we're building", "must ship" |
| `correction` | "that was wrong", "stop doing", contradictions |
| `remember_item` | "remember", "do not forget", "keep in mind" |
| `slvp_constraint` | SLVP references, invariants, correctness constraints |

## Output JSONL schema

```jsonc
{
  "category": "explicit_directive",
  "text": "Always run relevant tests before stating code is ready.",
  "source_file": "rollout-2026-05-20T10-14-21-....jsonl",
  "turn_index": 1,        // 0 = durable instruction block
  "timestamp": "2026-05-20T10:14:21.000Z",
  "confidence": 85,       // 0–100
  "extraction_reason": "imperative with condition",
  "status": "active",     // active | possibly_done | low_priority
  "redacted": false
}
```

## Recommended triage workflow

1. Run with `--min-confidence 75` to get high-signal items first.
2. Review `deferred_task` and `correction` categories — these are where lost breadcrumbs concentrate.
3. Mark items `possibly_done` or `superseded` manually in the JSONL if they've been addressed.
4. Commit the JSONL to `tmp/workstreams/` only after reviewing for personal data. Use `--redact` for safety.

## Limitations

- Pattern-based: cannot catch implicit guidance buried in prose without trigger keywords.
- The `turn_context.user_instructions` block repeats in every session — the extractor deduplicates by `(category, normalized_text)`, so only the earliest occurrence is kept.
- Agent-authored text (turn role `assistant`) is excluded entirely; only user turns and instruction blocks are scanned.
- Status hints (`active`, `possibly_done`) are heuristic — manual review is required to confirm.
- Does not read the SQLite databases (`logs_2.sqlite`) — only the JSONL session files.

## Log locations

| Location | Contents |
|----------|----------|
| `~/.codex/sessions/YYYY/MM/DD/` | Per-session JSONL files (primary source) |
| `~/.codex/history.jsonl` | Flat chronological log (not used by extractor) |
| `~/.codex/logs_2.sqlite` | Binary DB — not read by this extractor |
