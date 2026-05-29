#!/usr/bin/env python3
"""
extract-guidance.py — Session Guidance Ledger Extractor

Scans Codex session JSONL files for durable user guidance:
  - Explicit directives
  - Process rules
  - Design decisions
  - Deferred tasks / "later" breadcrumbs
  - Feature commitments
  - Corrections (prior behavior called wrong)
  - "remember" / "do not forget" items
  - SLVP / correctness constraints

Usage:
  python scripts/extract-guidance.py [OPTIONS] [LOG_FILE_OR_DIR...]

  If no path is given, defaults to ~/.codex/sessions/

Options:
  --output FILE       Write JSONL output (default: stdout)
  --report FILE       Write markdown summary (default: none)
  --since DATE        Only process files modified after DATE (YYYY-MM-DD)
  --limit N           Stop after N candidate items (0 = unlimited)
  --category CAT      Filter by category (can repeat)
  --min-confidence N  Minimum confidence score 0-100 (default: 40)
  --cwd-filter PATH   Only include sessions whose cwd contains PATH
  --owner-only        Only include top-level CLI sessions (source == "cli")
  --pdpp              Shortcut: --cwd-filter /pdpp --owner-only
  --redact            Mask tokens, UUIDs, bearer values
  --help              Show this message

Output JSONL fields per item:
  category, text, source_file, turn_index, timestamp, confidence,
  status, extraction_reason, redacted
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

# ---------------------------------------------------------------------------
# Pattern registry — deterministic heuristics
# ---------------------------------------------------------------------------

CATEGORIES = [
    "explicit_directive",
    "process_rule",
    "design_decision",
    "deferred_task",
    "feature_commitment",
    "correction",
    "remember_item",
    "slvp_constraint",
]

# Each entry: (category, weight, compiled_pattern, extraction_reason)
_RAW_PATTERNS = [
    # remember / do not forget
    ("remember_item", 90, r"\b(remember|do not forget|don'?t forget|keep in mind|note:)\b", "explicit remember marker"),
    # corrections
    ("correction", 88, r"\b(that was wrong|you were wrong|don'?t do that|stop doing|never do|avoid doing|you should not|should never)\b", "correction signal"),
    ("correction", 85, r"\b(I said|I told you|as I mentioned|we agreed)\b.*\b(but you|instead you|you still)\b", "contradiction marker"),
    # explicit directives
    ("explicit_directive", 85, r"\b(always|never|must|shall|do not|don'?t)\b.{0,80}\b(when|if|before|after|for|in)\b", "imperative with condition"),
    ("explicit_directive", 80, r"^[\-\*]\s+(always|never|must|do not|don'?t)\b", "bullet imperative"),
    # process rules
    ("process_rule", 80, r"\b(before (every|each|any)|after (every|each|any)|every time|each time|whenever)\b", "temporal process rule"),
    ("process_rule", 75, r"\b(the workflow is|our process is|the pattern is|convention is|standard is)\b", "process definition"),
    # design decisions
    ("design_decision", 80, r"\b(we decided|decision:|we chose|the design is|architecture is|the model is|the contract is)\b", "design decision marker"),
    ("design_decision", 78, r"\b(going forward|from now on|henceforth)\b", "temporal design decision"),
    # deferred tasks
    ("deferred_task", 85, r"\b(TODO|FIXME|later|follow.?up|next sprint|eventually|at some point|we should)\b.{0,120}\b(do|add|fix|check|review|update|implement|revisit)\b", "deferred task marker"),
    ("deferred_task", 82, r"\b(we('ll| will) (add|do|fix|address|revisit|look at))\b", "future commitment"),
    ("deferred_task", 80, r"\b(parking lot|not now|out of scope for now|backlog)\b", "explicit deferral"),
    # feature commitments
    ("feature_commitment", 80, r"\b(we('re| are) building|we('ll| will) build|we('ll| will) ship|must ship|needs to ship)\b", "feature commitment"),
    # SLVP / correctness constraints
    ("slvp_constraint", 85, r"\b(SLVP|simple.*lossless|lossless.*verifiable|correct.by.construction|invariant|must be idempotent|must be atomic)\b", "SLVP/correctness constraint"),
    ("slvp_constraint", 78, r"\b(the invariant is|must preserve|must not lose|data must not)\b", "data invariant"),
]

COMPILED_PATTERNS = [
    (cat, weight, re.compile(pat, re.IGNORECASE | re.MULTILINE), reason)
    for cat, weight, pat, reason in _RAW_PATTERNS
]

# Patterns that indicate a line is NOT a user message (assistant boilerplate)
_NOISE_PATTERNS = re.compile(
    r"(I'll|I will|Let me|I'm going to|Here is|Here's|I've|I have|Based on|As you|To do this|In this)",
    re.IGNORECASE,
)

_REDACT_PATTERN = re.compile(
    r"(Bearer\s+\S+|token[=:\s]+[A-Za-z0-9_\-\.]{20,}|sk-[A-Za-z0-9]{20,}|"
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# Log parsing
# ---------------------------------------------------------------------------

def iter_session_file(path: Path) -> Iterator[dict]:
    """Yield parsed JSON objects from a JSONL session file, skipping bad lines."""
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def read_session_meta(path: Path) -> dict:
    """Read only the session_meta line from a JSONL file (fast, stops early)."""
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if obj.get("type") == "session_meta":
                    return obj.get("payload", {})
            except json.JSONDecodeError:
                continue
    return {}


def session_matches_filters(path: Path, cwd_filter: str | None, owner_only: bool) -> bool:
    """Return True if this session file passes the cwd/owner filters."""
    if not cwd_filter and not owner_only:
        return True
    meta = read_session_meta(path)
    if cwd_filter and cwd_filter not in (meta.get("cwd") or ""):
        return False
    if owner_only:
        source = meta.get("source", "")
        if isinstance(source, dict) or (isinstance(source, str) and source != "cli"):
            return False
    return True


def extract_user_texts(path: Path) -> list[tuple[int, str, str | None]]:
    """
    Return list of (turn_index, text, timestamp) for every user message
    and durable instruction block in the session file.
    """
    results: list[tuple[int, str, str | None]] = []
    turn_index = 0
    session_ts: str | None = None

    for obj in iter_session_file(path):
        obj_type = obj.get("type", "")
        ts = obj.get("timestamp")
        if ts and session_ts is None:
            session_ts = ts

        if obj_type == "turn_context":
            payload = obj.get("payload", {})
            instructions = payload.get("user_instructions", "")
            if instructions:
                results.append((0, instructions, ts or session_ts))

        elif obj_type == "response_item":
            payload = obj.get("payload", {})
            role = payload.get("role", "")
            if role == "user":
                turn_index += 1
                content_blocks = payload.get("content", [])
                for block in content_blocks:
                    text = ""
                    if isinstance(block, dict):
                        text = block.get("text", "") or block.get("content", "")
                    elif isinstance(block, str):
                        text = block
                    if text:
                        results.append((turn_index, text, ts or session_ts))

    return results


# ---------------------------------------------------------------------------
# Pattern matching
# ---------------------------------------------------------------------------

def score_text(text: str) -> list[dict]:
    """
    Score a text block against all patterns.
    Returns list of candidate items (may be empty).
    """
    # Split into sentences/lines for per-line scoring
    lines = [ln.strip() for ln in re.split(r"(?<=[.!?])\s+|\n", text) if ln.strip()]
    candidates = []

    for line in lines:
        if len(line) < 20:
            continue

        best_cat = None
        best_weight = 0
        best_reason = None

        for cat, weight, pattern, reason in COMPILED_PATTERNS:
            if pattern.search(line):
                if weight > best_weight:
                    best_cat = cat
                    best_weight = weight
                    best_reason = reason

        if best_cat and best_weight > 0:
            # Penalize lines that look like agent responses
            if _NOISE_PATTERNS.match(line):
                best_weight = max(0, best_weight - 20)
            if best_weight > 0:
                candidates.append({
                    "category": best_cat,
                    "text": line,
                    "confidence": best_weight,
                    "extraction_reason": best_reason,
                })

    return candidates


def infer_status(category: str, text: str) -> str:
    """Heuristic status hint."""
    lowered = text.lower()
    if category == "deferred_task":
        if any(w in lowered for w in ("done", "completed", "shipped", "merged", "fixed")):
            return "possibly_done"
        return "active"
    if category == "correction":
        return "active"
    if category in ("design_decision", "slvp_constraint"):
        return "active"
    if any(w in lowered for w in ("eventually", "someday", "later", "backlog")):
        return "low_priority"
    return "active"


def redact(text: str) -> tuple[str, bool]:
    """Redact sensitive patterns. Returns (cleaned_text, was_redacted)."""
    cleaned = _REDACT_PATTERN.sub("[REDACTED]", text)
    return cleaned, cleaned != text


# ---------------------------------------------------------------------------
# File discovery
# ---------------------------------------------------------------------------

def discover_session_files(
    roots: list[Path],
    since: datetime | None,
    cwd_filter: str | None = None,
    owner_only: bool = False,
) -> list[Path]:
    """Recursively find all .jsonl files under roots, optionally filtered by mtime and session metadata."""
    found = []
    for root in roots:
        if root.is_file() and root.suffix == ".jsonl":
            if session_matches_filters(root, cwd_filter, owner_only):
                found.append(root)
        elif root.is_dir():
            for p in sorted(root.rglob("*.jsonl")):
                if since:
                    mtime = datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc)
                    if mtime < since:
                        continue
                if session_matches_filters(p, cwd_filter, owner_only):
                    found.append(p)
    return found


# ---------------------------------------------------------------------------
# Main extraction loop
# ---------------------------------------------------------------------------

def extract_from_file(
    path: Path,
    min_confidence: int,
    category_filter: set[str] | None,
    do_redact: bool,
    limit: int,
    count: list[int],
) -> list[dict]:
    results = []
    try:
        texts = extract_user_texts(path)
    except Exception as e:
        print(f"[WARN] Failed to parse {path}: {e}", file=sys.stderr)
        return []

    source_id = path.name

    for turn_index, text, ts in texts:
        if limit and count[0] >= limit:
            break
        candidates = score_text(text)
        for item in candidates:
            if limit and count[0] >= limit:
                break
            if item["confidence"] < min_confidence:
                continue
            if category_filter and item["category"] not in category_filter:
                continue

            item_text = item["text"]
            was_redacted = False
            if do_redact:
                item_text, was_redacted = redact(item_text)

            record = {
                "category": item["category"],
                "text": item_text,
                "source_file": source_id,
                "turn_index": turn_index,
                "timestamp": ts,
                "confidence": item["confidence"],
                "extraction_reason": item["extraction_reason"],
                "status": infer_status(item["category"], item_text),
                "redacted": was_redacted,
            }
            results.append(record)
            count[0] += 1

    return results


# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------

def deduplicate(items: list[dict]) -> list[dict]:
    """Keep one representative per unique (category, normalized_text) pair.
    When the same line appears in multiple files, keep the earliest instance.
    """
    seen: dict[tuple[str, str], dict] = {}
    for item in items:
        # Normalize whitespace for dedup key
        key = (item["category"], re.sub(r"\s+", " ", item["text"].strip().lower()))
        if key not in seen:
            seen[key] = item
        else:
            # Prefer earliest timestamp
            existing_ts = seen[key].get("timestamp") or ""
            new_ts = item.get("timestamp") or ""
            if new_ts and new_ts < existing_ts:
                seen[key] = item
    return list(seen.values())


def generate_markdown_report(items: list[dict], source_paths: list[Path]) -> str:
    from collections import defaultdict

    lines = ["# Session Guidance Ledger", "", f"_Generated: {datetime.now(timezone.utc).isoformat()}_", ""]
    lines.append(f"**Total items extracted:** {len(items)}")
    lines.append(f"**Session files scanned:** {len(source_paths)}")
    lines.append("")

    by_cat: dict[str, list[dict]] = defaultdict(list)
    for item in items:
        by_cat[item["category"]].append(item)

    for cat in CATEGORIES:
        cat_items = by_cat.get(cat, [])
        if not cat_items:
            continue
        heading = cat.replace("_", " ").title()
        lines.append(f"## {heading} ({len(cat_items)})")
        lines.append("")
        # Sort by confidence descending
        for item in sorted(cat_items, key=lambda x: -x["confidence"]):
            conf_bar = "●" * (item["confidence"] // 20) + "○" * (5 - item["confidence"] // 20)
            status_tag = f"`{item['status']}`"
            ts = item.get("timestamp", "")[:10] if item.get("timestamp") else "unknown"
            lines.append(f"- **[{conf_bar} {item['confidence']}]** {status_tag} `{ts}` — {item['text']}")
            lines.append(f"  _(source: {item['source_file']}, turn {item['turn_index']}, reason: {item['extraction_reason']})_")
            lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Extract durable guidance from Codex session JSONL logs",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("paths", nargs="*", help="Log files or directories (default: ~/.codex/sessions/)")
    p.add_argument("--output", "-o", metavar="FILE", help="JSONL output file (default: stdout)")
    p.add_argument("--report", "-r", metavar="FILE", help="Markdown report output file")
    p.add_argument("--since", metavar="DATE", help="Only files modified after YYYY-MM-DD")
    p.add_argument("--limit", "-n", type=int, default=0, metavar="N", help="Max items (0=unlimited)")
    p.add_argument("--category", "-c", action="append", dest="categories", metavar="CAT",
                   help=f"Filter category (choices: {', '.join(CATEGORIES)})")
    p.add_argument("--min-confidence", type=int, default=40, metavar="N")
    p.add_argument("--cwd-filter", metavar="PATH", help="Only sessions whose cwd contains PATH")
    p.add_argument("--owner-only", action="store_true", help="Only top-level CLI sessions (source=cli)")
    p.add_argument("--pdpp", action="store_true", help="Shortcut: --cwd-filter /pdpp --owner-only")
    p.add_argument("--redact", action="store_true", help="Redact tokens, UUIDs, bearer values")
    return p.parse_args()


def main() -> None:
    args = parse_args()

    roots = [Path(p).expanduser() for p in args.paths] if args.paths else [Path("~/.codex/sessions/").expanduser()]

    since: datetime | None = None
    if args.since:
        since = datetime.fromisoformat(args.since).replace(tzinfo=timezone.utc)

    category_filter = set(args.categories) if args.categories else None

    cwd_filter: str | None = None
    owner_only: bool = False
    if args.pdpp:
        cwd_filter = "/pdpp"
        owner_only = True
    else:
        cwd_filter = args.cwd_filter
        owner_only = args.owner_only

    print(f"[INFO] Discovering session files in: {[str(r) for r in roots]}", file=sys.stderr)
    if cwd_filter:
        print(f"[INFO] Filtering by cwd containing: {cwd_filter}", file=sys.stderr)
    if owner_only:
        print(f"[INFO] Owner-only mode: skipping subagent sessions", file=sys.stderr)
    session_files = discover_session_files(roots, since, cwd_filter=cwd_filter, owner_only=owner_only)
    print(f"[INFO] Found {len(session_files)} session file(s)", file=sys.stderr)

    all_items: list[dict] = []
    count = [0]

    for i, path in enumerate(session_files, 1):
        if args.limit and count[0] >= args.limit:
            break
        if i % 50 == 0 or i == len(session_files):
            print(f"[INFO] Processing {i}/{len(session_files)}: {path.name}", file=sys.stderr)
        items = extract_from_file(
            path,
            min_confidence=args.min_confidence,
            category_filter=category_filter,
            do_redact=args.redact,
            limit=args.limit,
            count=count,
        )
        all_items.extend(items)

    print(f"[INFO] Extracted {len(all_items)} candidate guidance items (before dedup)", file=sys.stderr)
    all_items = deduplicate(all_items)
    print(f"[INFO] {len(all_items)} unique items after deduplication", file=sys.stderr)

    # Write JSONL output
    jsonl_text = "\n".join(json.dumps(item, ensure_ascii=False) for item in all_items)
    if args.output:
        Path(args.output).write_text(jsonl_text + "\n", encoding="utf-8")
        print(f"[INFO] JSONL written to {args.output}", file=sys.stderr)
    else:
        print(jsonl_text)

    # Write markdown report
    if args.report:
        report = generate_markdown_report(all_items, session_files)
        Path(args.report).write_text(report, encoding="utf-8")
        print(f"[INFO] Report written to {args.report}", file=sys.stderr)


if __name__ == "__main__":
    main()
