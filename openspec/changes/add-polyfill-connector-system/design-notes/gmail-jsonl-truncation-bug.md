# JSONL truncation bug — ROOT CAUSE FOUND: U+2028 in Node 24+ readline

**Status:** ✅ RESOLVED
**Raised:** 2026-04-19
**Resolved:** 2026-04-19 (same day)
**Diagnosed via:** Gemini 3 Pro + Google search consensus after 9 failed symptom fixes and a minimal reproducer

## Root cause

Node.js v24+ `readline.createInterface()` treats **U+2028 (LINE SEPARATOR)** and **U+2029 (PARAGRAPH SEPARATOR)** as line terminators. This tracks ECMA-262's definition of line terminators.

`JSON.stringify()` does **not** escape these characters — per RFC 8259 they are valid unescaped inside JSON strings, written as their raw UTF-8 bytes `E2 80 A8` / `E2 80 A9`.

Collision: when a JSON record contains U+2028 or U+2029 in a string value (common in newsletter-style HTML-to-text, PDF extraction, or anywhere Microsoft-copy-pasted text appears), the connector emits a valid JSON line, but the runtime's `readline` splits it into multiple 'line' events at the U+2028 byte sequence. `JSON.parse` on the first split fails with "Unterminated string in JSON at position N".

## Why the diagnostic signals confused us

- The connector-side `\n` count invariant was `1` (JSON.stringify produces clean output at the `\n` level).
- Error position ~1617/1651 was the byte offset of the U+2028 character, not a buffer boundary.
- C0 controls, lone surrogates, backpressure — none of these were involved.
- The E2 80 A8 triplet in the trace file LOOKED like UTF-8 encoding of characters in the General Punctuation block, not like a line terminator at first glance.

## The fix

Post-stringify, escape both characters. JSON.parse accepts `\u2028` / `\u2029` escape sequences, so this round-trips cleanly:

```javascript
const line = JSON.stringify(safe)
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029') + '\n';
```

## Deployed across the fleet

Fix applied to all 21 connectors that emit JSONL + the shared `browser-scraper-runtime.js`:

- ynab, github, gmail, usaa, amazon, chatgpt, claude_code, codex, slack, notion, oura, reddit, spotify, strava, pocket, ical, whatsapp, imessage, google_takeout, twitter_archive, apple_health
- `src/browser-scraper-runtime.js`

Every new connector MUST apply the same fix or use a shared emit helper.

## Verification

Gmail run on 2026-04-19 post-fix:
- Prior: crashed at record 2009 in all attempts.
- After: 6,000+ message_bodies ingested and climbing, no crashes. Run expected to complete at 17,810.

## Cross-cutting implications

1. **Spec-surface concern.** The JSONL protocol between connector and runtime is vulnerable to U+2028/U+2029 any place in record content. This is a runtime + spec concern, not just a connector concern.
2. **Runtime-side defense.** The runtime should ALSO handle this on the reader side — or the spec should mandate writers escape these characters. Proposed clarification: "Connectors MUST escape U+2028 and U+2029 in emitted JSONL lines even when the JSON spec does not require it."
3. **Framing alternative.** Length-prefixed framing (write 4-byte length, then JSON) would sidestep this class of bug entirely. Worth considering as a spec v2 transport option.

## Debugging infrastructure ROI

This bug was unsolvable without:
- **Runtime message-stream recorder** (`PDPP_TRACE_DIR`) — let us see exactly what the runtime received.
- **Enriched invalid-JSONL error messages** with preview of offending bytes.
- **Minimal reproducer** that replayed the exact record with raw-byte capture on the parent side — showed multiple line events where exactly one was expected.
- **Aggressive hypothesis** from Gemini — crucial to check a non-obvious angle (JSON spec vs. ECMA-262 line terminator definition divergence).

All documented in `debugging-leverage-open-question.md`. Keep investing there.

## Prior art / references

- GitHub Copilot CLI [#2649](https://github.com/github/copilot-cli/issues/2649) — same failure pattern in JSONL session files.
- Claude Code CLI #913 — truncation at fixed character positions via `createInterface` on piped stdout.
- Node.js readline line-terminator behavior documented at https://nodejs.org/api/readline.html

## Next action

File as a minor spec clarification: PDPP v0.1.x connectors MUST escape U+2028 and U+2029 in emitted JSONL to preserve compatibility with Node 24+ readline receivers.
