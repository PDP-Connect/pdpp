# Explore SLVP consolidated sweep — plan (2026-06-22)

Synthesis of 3 parallel lanes (manifest authoring [DONE, committed 41a671ef], heuristic code-audit, live re-walk) into ONE prioritized fix batch. Goal: nothing in the Explore read path guesses content/semantics from names/magnitudes — everything declared or honestly-generic. >95% Claude+Codex, Codex end-review, deploy, live re-verify.

Source reports: docs/research/slvp-heuristic-audit-2026-06-22.md, docs/research/explore-rewalk-audit-2026-06-22.md, docs/research/record-kind-declared-not-guessed-plan-2026-06-22.md.

## ALREADY RESOLVED by the authoring lane (41a671ef) — RE-VERIFY LIVE after deploy, don't re-fix
- Default-feed `Id:` rows for the 15 authored connectors (the YNAB-upcoming wall F2, function_calls had no title field so stays generic-correct, message streams now titled). RE-VERIFY: redeploy + walk; the YNAB 188-upcoming should now show month/category names, not Id:.
- Amount magnitude bug is MITIGATED for declared streams (formatDeclaredAmount now fires) — but the heuristic branch must still be removed (it bites undeclared amounts).

## P0b — UNDER-DECLARATION (the authoring agent was too aggressive with the stop-condition — found by live re-walk + a systematic audit)
The authoring lane (41a671ef) skipped ~27 streams as "telemetry/stat" that ACTUALLY have a human-meaningful title field. Confirmed via schema audit. Notable LIVE-connector misses:
- ynab/month_categories → category_name (THIS is the 188-upcoming Id: wall, re-walk F2) + category_group_name(secondary) + budgeted/balance(amount, milliunits)
- codex/function_calls → name (the TOOL NAME — this is re-walk F4's function_calls Id: wall; the tool name IS the honest title)
- usaa/accounts, chase/accounts → name (account names like "Sapphire Preferred (...9241)")
- gmail/labels → name; slack/workspace → name
Non-live connectors also under-declared (author for completeness): anthropic (conversations/messages/projects), imessage/messages (text), twitter_archive (tweets/direct_messages text), linkedin (profile/experience/skills), loom (videos/transcripts), pocket/items, meta (profile/posts), doordash/heb/wholefoods order_items, ical/events.
CAUTION (verify each, don't blanket-declare): chase/usaa statements `title` may be boilerplate ("Statement"); confirm it's real content before declaring. slack/message_attachments title/text may be attachment metadata. The rule stays: declare only a GENUINELY human-meaningful field; if it's boilerplate/an id-in-disguise, leave generic.
FIX: a corrective authoring pass over these ~27, verifying each field is real content (not boilerplate). This resolves the two biggest re-walk "Id: wall" findings (F2 ynab, F4 function_calls).

## P0 — CORRECTNESS (fix regardless of SLVP-aesthetics; data shown wrong)
1. **Amount magnitude heuristic (2 copies): DELETE.** `record-preview.ts:128` and `timeline-summaries.ts:176`: `Math.abs(v) > 10_000 ? v/1000 : v`. A $12,001 value renders as "$12.00" on any amount field without a declared `currency_milliunits` type. FIX: the declared `x_pdpp_type` is the ONLY gate for ÷100/÷1000 scaling. When no type is declared → format as plain dollars (no division), OR — more honest — if the field has no declared currency type, treat it as a plain number, not money. (record-preview already prefers formatDeclaredAmount; just drop the magnitude fallback. timeline-summaries needs DeclaredFieldTypes plumbed OR drop division.)

## P1 — the content layer (the re-walk's "betrays it" theme + heuristic audit's content findings)
2. **Search results unscannable (re-walk F1 — highest leverage).** Search-hit entries carry `data: null` + no `preview`, so `rowPrimary` → `recordId` even for streams with authored titles. FIX: the search path must surface SOMETHING honest + scannable. Options (decide with Codex): (a) carry the record body/preview on search hits the way the recent feed does, so rowPrimary uses the declared primary-title; (b) render the matched SNIPPET as the secondary (the audit notes entry.summary holds it but it's withheld) — but ONLY if the server marks it as a search excerpt (the entry.summary-as-primary honesty trap we already closed; a snippet is fine as a clearly-labeled secondary, NOT as a faked title). PREFER (a): real declared title + matched-snippet secondary. This is where scannability matters most.
3. **`summarize()` is field-name-driven (heuristic audit #3/#4/#7).** The live feed-row `summary` (assembler:658,1169) picks the headline by guessing field names + a hand-curated per-connector SUMMARIES table + `firstString` insertion-order luck. Now that x_pdpp_role is authored, `summarize()` should read DECLARED roles (primary-title/secondary) first, firstString only as last resort for truly-undeclared. Migrate the SUMMARIES table → manifest roles (the table becomes dead once roles are authored). NOTE: confirm whether `summary` is still even used for display now that rows use rowPrimary(preview) — if summary is only the search-hit fallback, this folds into #2.
4. **classifyRecordKind name-guess → declared (recorded plan).** Make kind from declared x_pdpp_type via classifyByDeclaredTypes; DELETE classifyByStreamName/StrongField/WeakField/refineByBody + the manifest-field-name branch; undeclared → generic + neutral glyph. (Per docs/research/record-kind-declared-not-guessed-plan-2026-06-22.md.)
5. **Enter-hijack (re-walk F3).** Typing a multi-word query + Enter applies a facet filter instead of searching, because the typeahead auto-highlights a name-matching suggestion (aria-activedescendant opt-0). FIX: do NOT auto-select the first suggestion; Enter on free text runs the literal search unless the user explicitly arrowed into a suggestion. Standard combobox correctness.

## P2 — polish (batch where cheap, else defer)
6. has:link value-regex (heuristic #5): add a declared `link` field-capability (like blob/has:image) so has:link reads a declared affordance; until then it's an admitted last-resort — LOW priority, leave honest-as-is or add the declared affordance.
7. Peek "Open this record in full" on desktop (re-walk F5) — add the single-record route link to the peek (mobile already has it).
8. Peek leaks `http://reference:7663` internal host (re-walk F6) — use the public base URL in the displayed GET line.
9. Mobile redundant "Open →" (re-walk F8) — the whole-row <a> already routes; drop the duplicate (the redesign's own "no redundant affordances" principle).
10. Layout right-hug (F7), rail name-wall (F9), mono query input (F10) — taste; F10 (sans for the search input, mono only for ids/operators) is a quick consistent win.

## Scope guard / honesty (unchanged)
NO field-name guessing reintroduced. NO magnitude/shape inference of MEANING. Declared signal or honest-generic, always. Keep the content honesty gate, count==reachability, burst order, the conditional inspector, server contracts. x_pdpp_type/role stay presentation-only.

## Gate
tsc x-pkg, the explore + record-preview + record-kind + declared-roles + timeline-summaries + manifest-role tests (+ new regressions: undeclared amount ≠ ÷1000; search hit shows declared title or honest fallback; kind from declared type only; Enter on free text searches), openspec --strict (kind/spec deltas), lint. Codex end-review against ALL of this. Deploy. LIVE re-walk: search rows scannable, no Id:-wall, amounts correct, Enter searches, glyphs declared-or-neutral.
