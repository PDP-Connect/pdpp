## 1. Pilot fixture (synthetic-but-shape-real)

- [x] Author `fixtures/reddit/scrubbed/pilot-real-shape/records/<stream>.jsonl` for all six streams (`submitted`, `comments`, `saved`, `upvoted`, `downvoted`, `hidden`).
- [x] Every row is PII-free: real field shapes and representative non-identifying values, with `[REDACTED_*]` placeholders wherever a real capture would carry owner identity. No `fixtures/reddit/raw/` is committed (gitignored by design).
- [x] Cover the meaningful shape variants per stream: link post + self post (`submitted`); top-level + reply comment (`comments`); saved post + saved comment (`saved`); post + comment mix (`upvoted`/`downvoted`/`hidden`).
- [x] Leave stable IDs (`t3_*`, `t1_*`) and non-identifying subreddit names intact; permalinks use the `https://reddit.com/(r|user)/` shape the schema requires.

## 2. Schema-drift lock test

- [x] Add `connectors/reddit/pilot-fixture.test.ts` wiring `registerPilotFixtureTests({ connector: "reddit", validateRecord })` (matching GitHub).
- [x] Confirm the helper registers one case per stream and that every committed row passes `validateRecord(stream, row).ok === true`.
- [x] Confirm the test fails loudly if the fixture directory or a stream file goes missing/empty (helper behavior — no `expectMissing` opt-out used).

## 3. Documentation

- [x] Update `docs/connector-authoring-guide.md` §9.1 to document the `pilot-real-shape` fixture and name Amazon (DOM), GitHub (API JSON), and Reddit (records-stream) as the three per-shape references.
- [x] Add a `FIXTURES` note in the Reddit `index.ts` header pointing at the committed pilot and the drift-lock test.

## 4. Validation

- [x] Run `pnpm --dir packages/polyfill-connectors run verify` (typecheck + lint).
- [x] Run the reddit test files (`pilot-fixture.test.ts`, `integration.test.ts`, `parsers.test.ts`) and confirm green, including the six new pilot cases.
- [x] Run `openspec validate add-reddit-pilot-real-shape-fixture --strict`.
- [x] Run `openspec validate --all --strict`.

## 5. Live-gated owner follow-up (OPTIONAL — not required to close this change)

This tranche raises the pilot from synthetic-but-shape-real to a reviewed **real owner capture**. It needs owner credentials and a logged-in browser, so it cannot run without a human. It is explicitly out of scope for closing this change; do it only if higher-fidelity ground truth is wanted later.

Exact owner-run packet:

- [ ] Capture: with the owner's Reddit profile logged in (a 2026-04-30 attempt was blocked at login by a Cloudflare/challenge surface — complete login in the visible Reddit browser profile first), run the v0.2.0 connector with `PDPP_CAPTURE_FIXTURES=1` so all six streams emit. Confirm the raw run lands under `fixtures/reddit/raw/<runId>/records/*.jsonl` (and `http/*.json` if HTTP capture is wired).
- [ ] Redaction plan: for every raw `records/<stream>.jsonl`, author `<rel>.redactions.json` per the structured-redaction contract (`{version:1, redactions:[{text, replacement, reason}]}`). Replacements MUST be `[REDACTED_*]` placeholders. Cover free-form `title`, `body`, `selftext`, personal `url`, and identifying permalink slugs; leave `t3_*`/`t1_*` IDs and non-identifying subreddit names alone. Review for false negatives — every span a human reader would consider identifying needs an entry.
- [ ] Scrub: `pnpm exec tsx bin/scrub-fixtures.ts reddit <runId> --llm-redactions-dir ./local-redactions/reddit`. The scrubber is fail-closed: every raw file must have a plan, every target string must survive deterministic scrubbing. Rename the output to `fixtures/reddit/scrubbed/pilot-real-shape/`.
- [ ] Review: eyeball the scrubbed `records/*.jsonl` for residual PII; a reviewer other than the capture author SHOULD sign off. If residual PII is found, add a deterministic rule to `connectors/reddit/scrub-rules.ts` or extend the redaction plan — do not hand-edit scrubbed output.
- [ ] Re-run the §2 drift-lock test against the real capture; it must stay green (real Reddit JSON is the same wire format the synthetic fixture mirrors).
