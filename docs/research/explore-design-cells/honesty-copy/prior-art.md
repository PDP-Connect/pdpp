# Prior art — honesty-copy framing + default-view URL state

Cell: **honesty-copy + URL-state cleanup**. Two questions:
(A) How do SLVP products word "this is a ranked/best-match result" to **users** without exposing
retrieval internals? (B) Do SLVP products encode default-list state in the URL (shareable default)?

Captured live 2026-06-23 (sources indexed via ctx_fetch_and_index; see citations).

---

## (A) Ranked / "hybrid" search-result framing to USERS

The universal pattern across SLVP search products: **the user is told WHAT matched and HOW it's
ordered (relevance / recency), never the RETRIEVAL MECHANISM** (BM25, lexical, semantic, embeddings,
vector, hybrid, dedup-by-key). Mechanism words are developer/marketing vocabulary, kept off the
result surface.

- **Linear (`linear.app/docs/search`)** — The product copy is: *"Quickly find issues, projects and
  documents with Search… Search retrieves issues, projects, and documents across…"*. The only ordering
  language a user sees is the sort control: *"order these by **relevance**, **last updated** or **last
  created**."* No "lexical", no "semantic", no "hybrid", no "deduplicated". Stop-word behavior is
  documented in a collapsed Q&A, not on the result surface. **Canonical reference: name the ordering
  ("relevance" / "newest"), never the engine.**

- **Algolia (`algolia.com/.../what-is-algolia`)** — Even Algolia's *own* docs, describing a hybrid
  lexical+vector retrieval platform, address the end-user experience as **"relevance"** and
  **"matching, ranking, and filtering"** ("Improve relevance — Tune matching, ranking, and filtering
  to improve results"). The words "vector", "BM25", "embeddings" live in the *engineering* guides, not
  in user-facing result copy. **Confirms: "relevance/matching/ranking" is the honest user vocabulary
  for exactly the engine PDPP runs.**

- **Stripe (`docs.stripe.com/search`)** — Search is framed by the OBJECTS you find and the FIELDS that
  match (a query language over fields), never by the index implementation. The user reasons about
  *what* matched, not *how* it was retrieved.

- **Internal corroboration (authoritative, `explore-slvp-redesign/03-critic-verdict.md`)** — the
  multi-model critic already flagged this exact class on the live prototype: *"The HYBRID badge is a
  'developer told you' element — Stripe/Things would hide this from the end user. It's noise."* This
  is not a new opinion; it is the standing verdict the cell executes.

**The named ANTI-PATTERN to avoid:** the *"developer-told-you" retrieval badge/sentence* — surfacing
the engine's internal mode ("HYBRID", "lexical", "semantic", "deduplicated by record key") on the
result. It reads as machine output to a human (THE-LENS Part 0: *"Anything that reads as machine/AI
output to a human… developer labels (MATCH:, HYBRID)"*). Honest ≠ exhaustive-disclosure-of-mechanism;
honest = a true claim a human can act on.

**The honesty nuance (do NOT over-correct):** the set-descriptor contract still forbids claiming
"newest first" over a relevance-ordered set. So the user-facing framing is **"Top matches"** /
**"best matches for '<q>'"** (relevance, bounded) — NOT "newest first" — and the existing labelled
escape door **"Browse all matching records, newest first"** (explore-canvas.tsx:1202) stays as the
honest exit to the chronological set. Removing the mechanism word does not relax the ordering claim.

---

## (B) Default list/view state in the URL (shareable default)

Two distinct sub-patterns; PDPP already follows the right one and must NOT regress to the wrong one.

- **Linear (`linear.app/docs/custom-views`)** — Views are first-class share primitives ("save and
  share with others"), and a user can set a **favorited view as their default page**. But the DEFAULT
  list itself (e.g. "All Issues") is a **clean canonical route**, not a query-string of every implicit
  filter. Linear does NOT stuff `?status=all&sort=default&order=desc` onto the default URL to "reflect
  state"; the empty/canonical route *is* the state. Filters appear in the URL only when the user
  *applies* one. **Reference: the default view is a real, canonical, shareable URL — achieved by the
  route being canonical, not by serializing implicit defaults.**

- **The anti-pattern: "echo every implicit default into the querystring."** Writing
  `?lens=recent&sort=newest&order=desc` onto the default produces (i) a second representation of the
  same state — the bare path AND the param-soup both mean "default" (a THE-LENS Part-0 "same thing two
  ways" violation), and (ii) collateral breakage of any "is this the default view?" predicate that
  keys off "no filters present." It also makes copied links uglier for zero honesty gain.

**How this maps to PDPP's actual mechanism (verified in code, not assumed):** PDPP's "All" / default
view is detected by `isAllView(href) === (canonicalViewIdentity(href) === "")`
(`apps/console/.../explore-saved-views.ts:76`). `canonicalViewIdentity` strips a fixed VOLATILE set
(`peek, cursor, cursors, ucursors, anchor`) and treats **every remaining param as a filter**. So the
**bare `/dashboard/explore` IS the canonical identity of "All"** — it is the Linear-correct pattern,
not a bug to "fix" by adding params. (See `design.md` for why the owner's 6/18 note is satisfied by an
honest-empty-state recommendation, not by param-injection.)

---

## One-line takeaways for the design
- **Search copy:** say *relevance / matches / newest-first-escape*; never *hybrid / lexical / semantic
  / deduplicated / embeddings*. (Linear, Algolia, Stripe; internal critic verdict.)
- **Per-row retrieval badge / engine sentence = the named anti-pattern** ("developer told you"). Cut it.
- **Default URL:** the canonical route already IS the shareable default-view identity (Linear pattern).
  Do not serialize implicit defaults into the querystring — that is the anti-pattern and it breaks
  `isAllView`. The fix is to make the bare default honestly *legible as canonical state* (and ensure
  share/copy works from it), not to invent params.
