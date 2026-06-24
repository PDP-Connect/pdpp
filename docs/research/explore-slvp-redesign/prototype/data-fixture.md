# Real-data fixture for the Explore prototype (from live pdpp.vivid.fish, 2026-06-23)

Use THIS data in all prototype concepts so they render Tim's ACTUAL Explore (directly comparable to
the live screenshots in `../../explore-mobile-review-2026-06-22/`). Do not invent connectors.

## Connections (the real source list, with "in view" counts as seen live)
Amazon - gezalsatx@gmail.com · Amazon - Personal · Chase - Personal · ChatGPT - dondochaka ·
ChatGPT - everyone@appears.blue · GitHub - @dondochaka · GitHub - Personal ·
peregrine Claude Code (32 in view) · peregrine Codex · Reddit - dondochaka · Simon VM Claude Code ·
tim.nunamaker@gmail.com Gmail (1 in view) · USAA - Personal · Vana Slack (15 in view) ·
vivid fish Claude Code · WhatsApp - +1 210-281-1280 · YNAB - Personal

## Default recent feed (Today, "32 in view · from the most recent 32 records")
Group header: **Today**  ·  count "32 in view"

Rows (real content + kind + source + time), in order:
1. kind=titled · **project_explore_slvp_consolidated_sweep_v1** · secondary: "Explore SLVP consolidated sweep (P0b/P0/P1) DEPLOYED + live-verified" · memory_notes · peregrine Claude Code · 17m ago
2. kind=titled(message) · **[tool_result]** · actor: user · messages · peregrine Claude Code · 25m ago
3. kind=titled(message) · **[tool_use: Bash]** · actor: assistant · messages · peregrine Claude Code · 25m ago
4. kind=titled(message) · **"Confirmed: `git diff 41a671ef..HEAD` for that file = 1 line (just the diff header…"** · actor: assistant · messages · peregrine Claude Code · 25m ago
5. kind=generic · attachments · peregrine Claude Code · 25m ago · honest fields: Hook name "PreToolUse:Bash" · Timestamp "2026-06-22T23:15:44Z" · Event type "attachment"  (NOTE: title/text null → these are the only readable fields)
6–8. (more attachments rows, same shape, different timestamps)

## A money/finance example (the strongest content — use prominently)
Vana Slack deploy attachment (message_attachments), real content lives in `fallback`:
- fallback: "[vana-com/unity-surfaces] Successfully deployed <https://github.com/vana-com/unity-surfaces/commit/a6e2ec5c…|a6e2ec5> to <https://unity-surfaces-…opendatalabs.vercel.app|Preview>"
- color: "28a745" · index: 0   (decorative — must NOT lead the row)

## Upcoming section (188 upcoming · scheduled/future-dated) — ynab month_categories
Group header: **Wednesday, July 1, 2026**  ·  count "132 in view"  (kind=money, `$` glyph)
1. **Toys** · group "New Budget" · budgeted (YNAB milliunits) · month_categories · YNAB - Personal
2. **Collateral Repayment** · group "Financial Independence (Target: $16,…" · month_categories · YNAB
3. **Overflow** · group "Monthly Expenses" · YNAB
4. **Natural Gas** · group "Regular Bills" · YNAB
5. **Taxes** · group "True Expenses" · YNAB

## Search results state (query "deploy") — for the search concept
Header: **Top matches for 'deploy'** · sub: "Browse matching records, newest first" · "25 in view · 25 search results returned"
Disclosure: "Hybrid retrieval (lexical + semantic), deduplicated by record key. Public search results do not yet carry connection identity…"
Hits (each: matched snippet is the scannable content; retrievalMode=hybrid):
1. messages · ChatGPT - everyone@appears.blue · 2:16 AM · MATCH: "deploy a separate Modal function per user or force containers to shut down after each user"
2. messages · ChatGPT · 9:05 AM · MATCH: "deploy"
3. messages · Vana Slack · MATCH: "Deploying"  (Mon, April 20, 2026)

## Zero-results contradiction state (the bug to DESIGN AROUND, not reproduce)
Query "stream:messages role:assistant" → server returns 25 but role: post-filter removes all → live shows
"0 in view · 25 search results returned" + "try different terms". The redesign must instead ROUTE: e.g.
"No assistant-role records in these 25 message matches — [remove role:assistant] or [search all roles]".

## Operators (the real vocabulary, for autocomplete)
con: / -con: (source) · stream: / -stream: · role: · has:image · has:link · is:folded ·
before:YYYY-MM-DD · after:YYYY-MM-DD · field:value (e.g. a declared exact-filterable field).
"combine freely; a leading - excludes (everything except)."

## Brand tokens (FIXED — express the redesign THROUGH these, do not swap fonts)
- Fonts: **Schibsted Grotesk** (sans — use for ALL prose, titles, the search input) · **JetBrains Mono** (mono — ONLY ids, timestamps, hashes, amounts-as-columns/tnum, operator tokens). The live bug is the search INPUT being mono — fix that.
- Text hierarchy target (anchored to Geist/Primer): primary text near-black; ONE muted token for metadata; nothing else. Title ≥ metadata in size; restrained weight, not heavy.
- One accent color for the single primary action per screen. Spacing as the separator (no row borders within a day group). Tabular figures (`font-feature-settings:'tnum'`) for amounts, not mono.
- Money: YNAB amounts are milliunits (÷1000), chase/usaa cents (÷100) — format as currency only when the field is declared currency; otherwise neutral number.
