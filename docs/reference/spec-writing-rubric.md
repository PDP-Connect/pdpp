# Spec writing rubric

Audience: anyone editing a root `spec-*.md`, and the grader pass that reviews the edit.

`scripts/spec-prose-lint.mjs` decides the six questions a regex can decide. This rubric
carries the ten that need a reader. Run the linter first; it is the cheaper half and a
failing lint usually means the rubric will fail too.

The linter reports every finding, but the `spec-prose-gate` job fails only on `hard-wrap`
and on judgment findings your change introduced (see CONTRIBUTING.md). A pre-existing
judgment finding is a warning there, which is precisely a case this rubric exists to
resolve: clearing one means rewriting a normative sentence, so it needs a grader's read
rather than a mechanical fix.

Each criterion below has a one-line test you can apply to a diff without loading the whole
specification into your head, and the published authority the criterion comes from. Where a
criterion is our own convention rather than a standard, it says so.

## How to grade

Grade a diff, not the file. For each criterion, answer PASS, FAIL, or N/A, and quote the
line you judged. A criterion with no line to quote is N/A, not PASS.

The grader must be a different pass from the writer. A writer checking their own prose
against this rubric reliably passes text a fresh reader fails, which is the entire reason
the judged half exists.

## The ten criteria

### 1. Requirement level is carried by a capitalized key word

**Test:** Every sentence that constrains an implementation uses a capitalized RFC 2119 key
word, and every capitalized key word sits in a section the document treats as normative.

**Cite:** RFC 2119; RFC 8174 — the key words apply "only when they appear in all capitals",
and lowercase ones "have their normal English meanings". `spec-core.md` §"Requirements
Language" carries the BCP 14 boilerplate.

**Why it needs a reader:** the linter flags only lowercase `must`/`shall` after a named role.
It deliberately ignores lowercase `may`, because "a resource server may hold pre-collected
data" states a possibility rather than granting a permission, and flagging that shape
produced nine false positives for every real finding on the current specs. So the linter
cannot tell you that a permission was meant to be normative, nor that a paragraph should have
imposed a requirement and did not.

### 2. Normative and informative content are separated, and notes are informative

**Test:** Each note, example, and figure would still be correct if a reader ignored it
entirely. Nothing a conformant implementation must do appears only inside one.

**Cite:** W3C Manual of Style — "Figures, examples and notes are assumed to always be
informative" and "If some sections are informative, say so at the start of each section, and
do not use RFC 2119 keywords in those sections." `spec-core.md:112` states the same rule for
this repository: the document is normative "except where content is explicitly marked as an
example, a note, or otherwise non-normative."

### 3. Obligations name the role that bears them

**Test:** For every requirement, you can answer "who must do this?" from that sentence
alone — authorization server, resource server, client, or connector — without reading up.

**Cite:** RFC 7322 §2 (consistency within the document); the actor and role tables in
`spec-core.md` §2 are the vocabulary to use. OpenID Connect Core is the exemplar: it names
the OP or the RP in essentially every normative sentence.

### 4. Terms are the ones the concept inventory already defines

**Test:** Every domain noun in the diff appears in `docs/reference/concept-inventory.md` or
`spec-core.md` §2, spelled the same way. No new synonym for an existing concept.

**Cite:** RFC 7322 §2 — the RFC Editor strives for consistency within the document, the
document cluster, and the series. `docs/reference/voice-and-framing.md` §10 makes the same
demand and lists the load-bearing identifiers.

### 5. Abbreviations are expanded on first use

**Test:** The first occurrence of each abbreviation in the file spells it out, with the
abbreviation following in parentheses.

**Cite:** RFC 7322 §3.6 — "Abbreviations should be expanded in document titles and upon first
use in the document. The full expansion of the text should be followed by the abbreviation
itself in parentheses."

### 6. Cross-references point at sections, and the target says what the reader will find

**Test:** Every internal reference names a section (number or anchor), not a page or a vague
"see above", and the sentence says why the reader would follow it.

**Cite:** RFC 7322 §3.5 — "Cross-references within the body of the memo and to other RFCs must
use section numbers rather than page numbers."

### 7. Registry sections document policy, not just initial contents

**Test:** Any section defining a registry states its name, the registration policy for future
entries, what a registrant must supply, and the initial assignments.

**Cite:** RFC 8126 §2.2, "Documentation Requirements for Registries". Known gap as of this
writing: `spec-core.md` Appendix A (Purpose Code Registry) gives the name, governance, and
initial contents, but no registration policy in RFC 8126's vocabulary and no required-fields
list for a new entry.

### 8. One requirement per sentence

**Test:** No sentence carries two obligations joined by "and" or "or" where an implementer
could satisfy one and miss the other.

**Cite:** ASD-STE100 rule 3.2 (one idea per sentence; descriptive sentences capped at 25
words) and W3C Manual of Style, Grammar — "Break long sentences." The linter's 40-word
threshold is a deliberately loose operating point between those two; a 30-word sentence with
two obligations still fails this criterion.

### 9. No filler, no meta-commentary, no unfalsifiable adjectives

**Test:** Delete the sentence. If the specification says exactly the same thing to an
implementer, the sentence was filler.

**Cite:** Zinsser, *On Writing Well*, ch. 2-3 (clutter — "the secret of good writing is to
strip every sentence to its cleanest components"); ASD-STE100 §1 (one meaning per word). The
repository's own list of banned framings is `docs/reference/voice-and-framing.md` §4.

**Applies to:** phrases that announce what the prose is about to do ("this section
describes"), and adjectives with no test attached ("robust", "seamless", "leverage").

### 10. Framing matches the surface the document governs

**Test:** The text describes the protocol, not the reference implementation, the hosted
deployment, or the roadmap — unless it explicitly labels that shift.

**Cite:** `docs/reference/voice-and-framing.md` §§1-3 (the framing stack and the surface
taxonomy) and §9 (aspiration and roadmap must be labeled). This is a repository convention,
not an external standard, and it is the one criterion here with no RFC behind it.

## Relationship to the linter

| Linter rule | Rubric criterion it partly covers |
| --- | --- |
| `lowercase-normative` | 1 |
| `keyword-in-note` | 2 |
| `long-sentence` | 8 |
| `filler` | 9 |
| `hard-wrap` | 4 (consistency), mechanically |
| `duplicate-paragraph` | 4 (consistency), mechanically |

Criteria 3, 5, 6, 7, and 10 have no mechanical counterpart. They are why the judged pass
exists.
