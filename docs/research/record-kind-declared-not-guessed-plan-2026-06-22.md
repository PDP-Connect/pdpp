# Make record `kind` declared-driven, delete the name-guessing heuristic (2026-06-22)

the owner's standard: nothing sub-SLVP, ever. `classifyRecordKind` was flagged as a possible sub-SLVP heuristic. Verdict + the SLVP-ideal fix below.

## Finding (verified in code)
`classifyRecordKind` (packages/operator-ui/src/lib/record-kind.ts) CANNOT lie about row CONTENT — `buildRecordPreview`'s honesty gate overrides `kind` (no declared roles → generic card regardless of kind; typed builders fill slots from declared roles only). So a wrong `kind` produces nothing dishonest in the content.

BUT `kind` drives the leading GLYPH (kindGlyph / data-kind in explore-canvas.tsx ~1358), and today the glyph is NAME-GUESSED for ~every stream: `classifyByDeclaredTypes` (the preferred, declared path) only fires when `x_pdpp_type` is declared, and only 2 manifests declare any type. So in practice `classifyByStreamName`/`classifyByStrongField`/`classifyByWeakField`/`refineByBody` (explicitly labeled "EXPLICITLY LAST-RESORT") run and the icon can claim a kind the connector never declared. By the strict bar, the GLYPH is a small cosmetic sub-SLVP spot.

## The SLVP-ideal fix (minimal — NO new annotation)
`classifyByDeclaredTypes` ALREADY derives 7 of 8 kinds purely from declared `x_pdpp_type` signals: money, location (geo), activity, message (person+text), titled (text), event (temporal); reader needs a long body; generic is the fallback. So declared field-types ALREADY encode kind — no separate `x_pdpp_kind` needed.

1. **Make kind declaration-driven**: connectors declare `x_pdpp_type` on the kind-bearing fields (money fields → money; a text/body field → message/titled; geo → location; a measured-quantity → activity; a temporal field on a genuine event → event). The manifest-authoring lane is ALREADY adding `x_pdpp_type` on money fields; extend to the few text/geo/temporal signals that change the glyph.
2. **DELETE the name/field-guessing fallback**: remove `classifyByStreamName`, `classifyByStrongField`, `classifyByWeakField`, `refineByBody`, and the manifest-field-name heuristic branch. When types aren't declared → `generic` + a neutral glyph (the SAME honest-generic posture we built for content: traceable to the manifest, or honestly neutral — never guessed).
3. Keep `classifyByDeclaredTypes` as the SINGLE kind source. `reader` (long-body) either stays as a body-measured refinement (it's a data-shape fact, not a name guess — arguably acceptable) OR is dropped to generic; decide at build time.

## Why this is the ideal (not the cheap option)
Just "feed x_pdpp_type and keep the heuristic as fallback" leaves the name-guessing engine alive — it WILL fire and mis-glyph un-authored streams. That keeps a sub-SLVP heuristic in the code, less often. Deleting it makes the rule uniform with everything else this thread established: every presentation fact is manifest-authored or honestly-generic; the UI never guesses from names. Also removes a whole heuristic engine (less machinery).

## Sequencing (coupled to the authoring lane — do NOT parallelize, it races the same files/tests)
Do this AFTER the manifest-role-authoring lane lands (that lane adds the `x_pdpp_type` declarations the declared path needs). Then: delete the heuristic, update record-kind.test.ts (the name-guess tests become declared-type tests + a "no declaration → generic neutral glyph" test), gate (tsc, record-kind + record-preview + declared-roles tests, the assembler feed tests, openspec if kind semantics are spec'd), Codex end-review, deploy, live re-walk that glyphs are declared-driven (or neutral), never name-guessed. >95% Claude+Codex.

## Guard
Do NOT touch the content honesty gate (already correct). Do NOT reintroduce field-name guessing anywhere. `x_pdpp_type` stays presentation-only (gates kind + formatting), never enforcement.
