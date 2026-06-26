# Record presentation — SLVP-ideal field/title selection (2026-06-22)

Targeted research on THE question the live rewalk surfaced: when a connector has NOT declared display roles, how does an SLVP record explorer choose a row's primary line? Weighed against PDPP's trust principle: 'stream display.detail is manifest-authored, never client-authored.' The live feed showed 'Id: <uuid>' / 'Cc: []' because generic fallback picks fields[0] by raw key order.

## schema-driven-display-fields

I have the canonical phrasing locked. I have more than enough across all named products. Here is my synthesis.

---

# SLVP prior art: how data platforms decide the record TITLE / primary display field

## (a) Findings — each tied to a named product/spec + URL

**1. Airtable — AUTHORED primary field, positionally fixed, explicitly NOT the key.** Every table has exactly one "primary field" that is *always the first column*, *cannot be deleted, moved, or hidden*, and is used as the record's title throughout the UI (the linked-record name, the Kanban card name, etc.). Critically, Airtable documents that it is *not* the database primary key — "The real primary key is handled behind the scenes by Airtable" via an internal alphanumeric record ID — and that the primary field "doesn't even have to be unique or filled in." So the title is a *human-meaning slot the author fills*, decoupled from the identity key. Best practice when the value is weak (e.g. duplicate names) is to author a formula primary field concatenating name+address. Authorship is the user's job, not auto-detected.
- https://support.airtable.com/docs/the-primary-field
- https://blog.airtable.com/the-primary-column/
- https://support.airtable.com/docs/using-formulas-in-airtables-primary-field

**2. Notion — title is a REQUIRED, schema-level property; the API FORBIDS having zero or two.** The Notion API property-object spec states verbatim: *"All data sources require exactly one `title` property. The API throws errors if you create a data source without a `title` property, or attempt to add or remove a `title` property."* The title property "controls the title that appears at the top of a page when a data source row is opened," always has `id: "title"`, and always holds text. This is the strongest "MUST be declared" precedent: the platform makes a titleless record structurally impossible rather than auto-guessing one.
- https://developers.notion.com/reference/property-object
- https://www.notion.com/help/database-properties

**3. Metabase — AUTO-DETECTED via the "Entity Name" semantic type, with explicit author override.** Metabase picks a record's display name from a field tagged with the **Entity Name** semantic type (its sibling, **Entity Key**, marks the unique identifier — a deliberate separation of "name" from "key"). The Entity Name is *guessed during database sync* from column names/characteristics, and admins override it in Admin → Table Metadata. The auto-detection is documented as *fallible*: issue #49783 ("Schema sync should not add multiple columns with the Entity Name type") shows the heuristic mis-tagging `fullName`/`firstName`/`lastName` all at once, which then displays the wrong field in filters. This is the canonical example of the convenience-vs-trust failure mode.
- https://www.metabase.com/docs/latest/data-modeling/semantic-types
- https://github.com/metabase/metabase/issues/49783

**4. Directus — AUTHORED "Display Template" per collection, distinct from the key.** A collection's **Display Template** (Settings → Data Model → [collection]) "is used to represent an item in relationship fields — for example to show the value of the Name field when displaying a post's author." The admin picks the field(s); nothing is auto-guessed for relational display. Without it, references fall back to the raw primary key. Authorship is a first-class data-model setting.
- https://directus.com/docs/guides/data-model/collections
- https://docs.directus.io/user-guide/content-module/display-templates

**5. Strapi — AUTHORED "Entry title" in the Content-Manager view config; relations degrade to `id` when unauthored.** Strapi lets the author choose the **Entry title** field via "Configure the view," and the docs explicitly recommend choosing it well for relations "as the more comprehensive it is, the easier it will be… to manage the content." Strapi also documents the *failure when it's not authorable*: for component/relation fields you "cannot select relation fields… so the editor falls back to the very non-descript `id` attribute." That falling-back-to-`id` is exactly the anti-pattern a trust model wants to avoid.
- https://docs.strapi.io/user-docs/content-manager/configuring-view-of-content-type
- https://github.com/strapi/strapi/issues/8280

**6. Salesforce — AUTHORED standard "Name" field on every object, separate from the immutable Record ID.** Every standard/custom object ships with a standard **Name** field that is the user-facing record identifier in the UI, lookups, and page layouts; it is either free-text (author-supplied) or an Auto-Number. Salesforce documents that Name is mutable and *should not be relied on programmatically* — the immutable 15/18-char Record ID is the real identity. Same architecture as Airtable: a meaningful authored display label, deliberately distinct from the system key.
- https://help.salesforce.com/s/articleView?id=sf.dev_objectfields.htm&type=5

**7. Sentry — the title is DERIVED-but-typed, and the system declares when it can't title honestly.** Sentry stores `issue_title` in event `metadata`, derived from typed exception data (type/value), with `culprit` ("where the problem occurred") and `subtitle` as separate honest slots — grouping (fingerprint) is *independent* of titling. The Issue Platform spec treats `issue_title` as a *declared field a producer supplies*, not a column the renderer guesses. When inference is wrong (issue #21433, "Incorrect inferred title from native callstack") it's tracked as a defect, reinforcing that derived titles are a liability surface.
- https://develop.sentry.dev/backend/issue-platform/
- https://docs.sentry.io/api/events/retrieve-an-issue/

**8. Supabase/PostgREST & Retool — NO authored display field → they show the RAW key and push label-resolution to the author.** Supabase's table editor has no "display column" concept: foreign-key cells render the *raw referenced value* (the key); there is no setting to substitute a friendly label. Retool likewise recommends selecting a primary key per row and tells users to JOIN the lookup table in SQL to surface a label and *hide* the ID. The lesson: tools that *don't* give the schema a way to author a display field end up showing IDs/UUIDs — the precise outcome a trust-first system must design against.
- https://supabase.com/docs/guides/database/tables
- https://docs.retool.com/apps/guides/data/table
- https://community.retool.com/t/foreign-key-column-display/25187

## (b) The consensus pattern

Across all nine products there is a clear, near-universal architecture:

1. **There IS a dedicated "title / primary-display" concept, and the trustworthy products make it AUTHORED, not guessed.** Airtable primary field, Notion title property, Directus display template, Strapi entry title, Salesforce Name — all are author/schema-declared. Notion goes furthest: *exactly one, required, API-enforced.*
2. **The display field is deliberately SEPARATED from the identity key.** Every mature product distinguishes "the human label" from "the unique key" (Airtable primary field vs internal record ID; Metabase Entity Name vs Entity Key; Salesforce Name vs Record ID; Sentry title vs fingerprint). None reuses the id/uuid/FK as the title by design.
3. **Auto-detection exists only as a convenience layer and is documented as a liability.** Only Metabase truly auto-detects (Entity Name during sync), and its own issue tracker shows the heuristic mis-firing and an override being the fix. Heuristics seen in the wild: "field literally named Title/Name," "Entity-Name semantic type," "first column on import" (Airtable assigns the imported file's first column as primary — a *positional* guess it warns you to pre-arrange).
4. **When no display field is declared, the honest behavior is to fall back to the KEY and make the gap obvious** (Supabase shows raw FK, Strapi shows `id`) — not to silently fabricate a title from an arbitrary column. Products treat "we couldn't find a name" as a visible, author-fixable state, not something to paper over.
5. **No product silently scans arbitrary columns and promotes the "longest text" or "first non-id string" as a confident title.** The closest (Metabase's name-matching heuristic) is explicitly fallible and override-backed; everyone else requires declaration.

## (c) RECOMMENDATION for "display is manifest-authored, never client-authored"

**For a record whose connector did NOT declare a display/title field: show a principled, honest, NEUTRAL fallback that is visibly system-generated and self-discloses the gap — never auto-guess a title from the record's own field values.**

Concretely:

- **Do NOT auto-pick a title from data** (first string field, longest text, name-like column, etc.). That is exactly the *client-authored* display your trust model forbids: the value would be chosen by render-time heuristics over arbitrary record content, not by the manifest. Adopting Metabase-style column-scanning would import its documented failure mode (issue #49783 — wrong column, looks authoritative, isn't) and would silently violate the authorship principle while *appearing* trustworthy, which is the worst case. The principle isn't "always show something pretty"; it's "everything shown is traceable to the manifest."

- **DO render a neutral, system-owned label** derived only from manifest-level identity that the system legitimately owns — e.g. the record type/kind from the manifest plus a stable identifier ("GitHub record · #a1b2c3" / "Untitled {RecordType}"), rendered in the same de-emphasized "this is generated, not authored" treatment your design system already uses for null/empty values (italic/muted tokens). This mirrors Notion's "Untitled" and Strapi/Supabase's honest fall-through to the key: the record stays identifiable and openable without the system *claiming* a title it wasn't given.

- **Surface the gap as an author-fixable signal, not a dead end.** Like Metabase (override in Table Metadata) and Directus/Strapi (configure the display template/entry title), the right long-term move is to make "no declared display field" a visible, attributable state — ideally a manifest-authoring affordance ("this connector hasn't declared a display field") — so the fix lands where authorship lives: the manifest. This is the SLVP "honest generic fallback + no field-name guessing on the SLVP path" posture your own Slice 4 work already chose, and it's the one consistent with every trust-first product surveyed.

**Why this beats the convenient auto-picked title, weighed against the trust principle:** an auto-picked title is *indistinguishable to the user from an authored one* — it looks exactly as authoritative — yet it was authored by the renderer, not the manifest. That is a silent breach of "never client-authored," and the breach is invisible precisely when it's wrong (Metabase #49783, Sentry #21433). A neutral honest fallback costs a little polish on un-declared records but keeps the invariant *legible*: a user (or auditor) can always tell authored-display from system-fallback, and the only path to a "real" title runs through the manifest. Trust is preserved by making the absence of authorship honestly visible rather than hidden behind a plausible guess.

---

**Sources:**
- https://support.airtable.com/docs/the-primary-field
- https://blog.airtable.com/the-primary-column/
- https://support.airtable.com/docs/using-formulas-in-airtables-primary-field
- https://developers.notion.com/reference/property-object
- https://www.notion.com/help/database-properties
- https://www.metabase.com/docs/latest/data-modeling/semantic-types
- https://github.com/metabase/metabase/issues/49783
- https://directus.com/docs/guides/data-model/collections
- https://docs.directus.io/user-guide/content-module/display-templates
- https://docs.strapi.io/user-docs/content-manager/configuring-view-of-content-type
- https://github.com/strapi/strapi/issues/8280
- https://help.salesforce.com/s/articleView?id=sf.dev_objectfields.htm&type=5
- https://develop.sentry.dev/backend/issue-platform/
- https://docs.sentry.io/api/events/retrieve-an-issue/
- https://supabase.com/docs/guides/database/tables
- https://docs.retool.com/apps/guides/data/table
- https://community.retool.com/t/foreign-key-column-display/25187

---

## honest-fallback-field-ranking

I have more than enough authoritative material across all five sub-questions. I don't need the bobdc fetch (the search result already extracted the key precedence/fallback guidance and the "don't put descriptive text in the URI" caveat). Let me compose the final deliverable.

# SLVP-grade prior art: honest, non-guessing field ranking for a one-line record summary

The core distinction you're protecting — manifest-authored display, never client-authored — maps cleanly onto a distinction that recurs across every mature system below: **selecting among declared data by its DATA SHAPE is honest; inferring meaning from a field's NAME is guessing.** Every system that does the latter (well-known-field-name maps) is candid that it's convention/heuristic, not truth. That's the line your trust model already draws.

## (a) Findings, each tied to a named product/spec

**1. JSON log viewers prove the field-NAME approach is convention, not truth — and they say so.** The widely-used terminal viewers default to a fixed set of magic names (`timestamp`/`level`/`message`) and otherwise require explicit config. d10xa's viewer ships a *configurable mapping* (timestamp→`ts`, message→`msg`, etc.) precisely because the names aren't guessable; hedhyw's defaults to `timestamp`/`level`/`message` and falls back to user config when absent. The takeaway for you: name-matching is a per-deployment *config*, never a universal inference — which is exactly why your manifest authoring is the principled home for it.
- https://github.com/d10xa/json-log-viewer , https://github.com/hedhyw/json-log-viewer

**2. YScope's refreshed viewer separates field SELECTION from VALUE formatting — and routes id-like types (UUID/IP) by a declared format string, not by sniffing the name.** Users select which fields to view; UUID/IP get dedicated *formatters* "without adding more syntax sugar." This is the cleanest real-world separation of the two layers: *which* field is a config/authoring decision; *how a value renders* (and whether it looks id-like) is a data-shape decision.
- https://blog.yscope.com/a-refreshed-log-viewer-for-text-and-json-logs-85f4990ee2f5

**3. Google Cloud Logging and Loggly, when they DO pick "most relevant field" automatically, use STRUCTURAL/STATISTICAL signals — frequency and cardinality — not name semantics.** Cloud Logging offers a "JSON payload (most frequent)" dimension surfacing the most frequent `json_payload` fields in the current result set; Loggly builds a real-time structural map and ranks fields by "JSON field counts and other metrics … instead of relying on guesswork." This is the data-shape-not-name pattern at platform scale.
- https://docs.cloud.google.com/logging/docs/view/logs-explorer-interface , https://www.loggly.com/solution/json-logging/

**4. Automatic primary-key / "primary column" detection (DBAutoDoc, arXiv 2603.23050) is the canonical multi-factor, shape-based ranking — with HARD-REJECTION filters that push id-like and low-signal columns the right way.** Confidence = weighted blend of **uniqueness (50%), naming pattern (20%), data type (15%), data pattern (15%)**, with **hard rejection** of nulls, mostly-empty/zero columns, and a semantic blacklist (dates, quantities, money, *descriptive free-text*). Critically: **high cardinality → good ROW IDENTIFIER, not good HUMAN LABEL.** For a *display* summary you want the inverse weighting of a PK detector — you want the *descriptive free-text* the PK detector throws away.
- https://arxiv.org/pdf/2603.23050

**5. SQL cardinality theory gives you the three-tier shape taxonomy directly.** High-cardinality = unique IDs/emails (best for *identifying* a row, worst for *labeling* it). Normal-cardinality = names, addresses, types (the human-meaningful middle). Low-cardinality = status flags, booleans, enums. This is a pure data-shape signal you can compute without reading a single field name.
- https://en.wikipedia.org/wiki/Cardinality_(SQL_statements) , https://www.thedataschool.co.uk/eamonn-woodham/high-cardinality-vs-low-cardinality/

**6. "Human-readable vs opaque" is a measurable DATA-SHAPE property — Shannon entropy + word boundaries + dictionary/n-gram ratio — and the meaningful zone is the MIDDLE of the entropy scale, not an extreme.** Yelp's `detect-secrets` uses high-entropy scoring (length-weighted: longer all-digit strings score closer to max-entropy) to flag opaque tokens; entity-classification work flags hashed/encoded strings as high-entropy vs English words as low-entropy (a documented ~3.5 cutoff). The complexity research (PMC12025590, "Local Compositional Complexity") warns that **entropy alone is insufficient** — random noise AND uniform data both score "extreme," while human-readable text sits in the middle — so you must pair entropy with structural signals (spaces/word boundaries, dictionary-match ratio, repeated substrings).
- https://github.com/Yelp/detect-secrets/blob/master/detect_secrets/plugins/high_entropy_strings.py , https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12025590/

**7. UUID/hash/all-digit detection has stable, well-known structural regexes — necessary but NOT sufficient, so combine with a parse/entropy check.** Canonical UUID `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`; compact UUID/MD5 `^[0-9a-fA-F]{32}$` (SHA-1 `{40}`, SHA-256 `{64}`); all-digit `^\d+$`; general hex `^[0-9a-fA-F]+$`+length. Sources stress "not everything that looks like a UUID is one" — so these are *demotion* signals for ranking, never hard claims about meaning.
- https://www.guidsgenerator.com/wiki/uuid-regex , https://ihateregex.io/expr/uuid/

**8. RDF/Linked-Data label selection is the closest formal precedent to your problem — and it answers it with a DECLARED precedence chain plus an explicit "don't read meaning from the URI" rule.** The convention: try the most-specific *declared* label (`skos:prefLabel`), fall back to `rdfs:label` (and, via subPropertyOf, `schema:name`/`foaf:name`/`dcterms:title`), apply language preference, and **only as a last resort** derive from the URI local-name — while explicitly warning that putting descriptive text in URIs is "bad practice." This is your manifest model in another vocabulary: **labels are for display via a DECLARED property; the identifier is never the label.** ("Things, not strings.")
- https://www.bobdc.com/blog/rdflabels/ , https://patterns.dataincubator.org/book/preferred-label.html , https://www.w3.org/2004/12/q/doc/rdf-labels.html

**9. Elasticsearch `significant_text`/`significant_terms` ("uncommonly common") shows the principled way to rank *content* relevance without name semantics — foreground-vs-background statistical surprise.** "The most popular word in the car's fault reports is 'the' but that is hardly significant." Relevance comes from statistical shape (JLH / chi-square / mutual-information over frequency), never from the field being *named* "summary." A good antidote to the temptation to call the field named `subject` the title.
- https://www.elastic.co/blog/significant-terms-aggregation , https://www.elastic.co/docs/reference/aggregations/search-aggregations-bucket-significantterms-aggregation

**10. Algolia is explicit that picking the primary display/searchable attribute is "more an art than a science … no magic formula," and the order is AUTHORED by the integrator.** `searchableAttributes` is ordered-by-importance config; `attributesToSnippet` truncates long descriptive text for display; `customRanking` breaks ties on business signals. The honest position is identical to yours: **the primary field is a declared/authored choice, validated against real records — not auto-divined from names.**
- https://www.algolia.com/doc/guides/managing-results/must-do/searchable-attributes/how-to/configuring-searchable-attributes-the-right-way

## (b) The consensus pattern

Across log viewers, search engines, knowledge graphs, and schema-discovery tools, the convergent design is a **two-layer model with a hard wall between them**:

1. **Declared/authored layer wins first.** Manifest/config/preferred-property (`x_pdpp_role`, `searchableAttributes`, `skos:prefLabel`, viewer config). This is the only layer permitted to assert *meaning*. RDF's "things not strings" and Algolia's "art not science" both insist the primary field is authored, not inferred.
2. **When nothing is declared, fall back to DATA-SHAPE ranking — never NAME-meaning inference.** The shared shape signals are: **is the value a non-empty human-readable string (mid-entropy + word boundaries + dictionary hits) vs an id/uuid/hash/all-digits/empty-collection (structural regex + high-entropy/length)**, **cardinality tier** (id-like high-card and boolean/enum low-card both demote relative to the normal-card descriptive middle), **type** (timestamps, money, raw numbers, empty `[]`/`{}`/`null` demote), and **text mass** (word-count / readable length). PK-detectors invert these to *find* identifiers; you invert the inversion to *avoid* them. **Statistical "uncommonly common" relevance (Elasticsearch) and frequency/cardinality ranking (Loggly/Cloud Logging) are the platform-scale honest equivalents.**

The universal caveat: structural matches are *demotion/promotion signals for ranking*, never assertions of semantics — "not everything that looks like a UUID is one."

## (c) RECOMMENDATION — a concrete honest field-ranking algorithm for row-primary among UNDECLARED fields

A strict reviewer accepts this because **every input is a property of the VALUE'S SHAPE, and zero inputs read the field NAME.** It selects the most-readable already-present value; it never claims a field *means* "title."

**Step 0 — Authored short-circuit (the trust wall).** If the manifest declares a display field (`x_pdpp_role` / `display.detail`), use it. Done. Data-shape ranking runs *only* when nothing is declared, and the UI must label this state honestly (generic fallback, not a confident title). This preserves manifest-authored-not-client-authored: the client never *upgrades* a guess into an authored claim; it only orders already-present data and presents it as such.

**Step 1 — Hard reject (cannot be a row-primary).** Drop: `null`, empty string, empty array/object, and pure structural id/hash/opaque values — `^\d+$` long-digit IDs, UUID (`…8-4-4-4-12…`), compact-hex `^[0-9a-fA-F]{32,64}$`, and any short string failing a human-readability check (Step 3). These sort *last*, never primary.

**Step 2 — Type tier (shape only).**
- Tier A (eligible primary): **non-empty string** that passes readability (Step 3).
- Tier B (weak fallback): enum/boolean, single number, timestamp — usable only if no Tier-A field exists; a timestamp is a defensible *secondary* line, not a primary.
- Tier C (never primary): rejected in Step 1.

**Step 3 — Human-readability score for each Tier-A string (the heart of it).** Score each candidate string by VALUE shape:
- **Word/structure signal:** contains spaces or word boundaries; ≥2 "words"; passes a dictionary/n-gram readable check. (PMC12025590 + detect-secrets: structure matters, not entropy alone.)
- **Entropy band:** mid-range entropy preferred; reject high-entropy opaque tokens (~>3.5 length-weighted) and trivially low-entropy single tokens. Length-weight per detect-secrets so short all-digit junk demotes.
- **Text mass:** higher readable word-count ranks higher, **capped** (a 5,000-char body should not beat a clean one-line name — clamp/snippet it à la Algolia `attributesToSnippet`).
- **Cardinality demotion (if you have a sample of records):** demote both extremes — very-high-cardinality (id-like) and very-low-cardinality (status/enum) — favoring the normal-cardinality descriptive middle (SQL cardinality tiers + DBAutoDoc's PK-uniqueness signal, *inverted* for labeling).

**Step 4 — Deterministic tiebreak.** Equal scores → stable order (e.g., declared schema field order, then first-appearance). Never a name-meaning tiebreak.

### Is "the longest human-readable text field" a defensible honest default?

**Almost — but use "highest readability score (which includes capped text mass)," not raw longest.** "Longest" alone fails the way Algolia and Elasticsearch warn: a 10KB raw body or an opaque token both win on length. The defensible honest default is **"the highest-scoring human-readable string by data shape, with text mass capped/snippeted"** — that is *selection among declared data by readability* (explicitly the OK side of your line), not *field-name guessing* (the NOT-OK side). It's the same posture RDF takes when it falls back to `rdfs:label` rather than parsing the URI, and the same posture Loggly/Cloud Logging take with frequency over name-divination.

### The line, stated for your reviewers
- **OK (honest data-shape ranking):** "Among the values present, this one is a mid-entropy multi-word readable string and the others are a UUID, a timestamp, and an empty array — so show the readable one." Provable from value shape; reproducible; makes no semantic claim.
- **NOT OK (field-name guessing):** "There's a field named `subject`, so that's the title." Infers meaning from a name the manifest never declared — exactly what your trust model forbids, and exactly what every system here treats as authored-config, not inference.

**Weighing the manifest principle:** data-shape ranking does NOT violate manifest-authored-not-client-authored, because it never manufactures a semantic claim — it orders already-present values by intrinsic readability and renders the winner as an honest generic preview (not "Title: …"). The trust wall is Step 0: a declared field always wins, and the absence of one is surfaced honestly rather than papered over with a confident guess. RDF's "things, not strings" and the subPropertyOf precedence chain are the closest formal blessing of exactly this stance.

Sources:
- https://github.com/d10xa/json-log-viewer
- https://github.com/hedhyw/json-log-viewer
- https://blog.yscope.com/a-refreshed-log-viewer-for-text-and-json-logs-85f4990ee2f5
- https://docs.cloud.google.com/logging/docs/view/logs-explorer-interface
- https://www.loggly.com/solution/json-logging/
- https://arxiv.org/pdf/2603.23050
- https://en.wikipedia.org/wiki/Cardinality_(SQL_statements)
- https://www.thedataschool.co.uk/eamonn-woodham/high-cardinality-vs-low-cardinality/
- https://github.com/Yelp/detect-secrets/blob/master/detect_secrets/plugins/high_entropy_strings.py
- https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12025590/
- https://www.guidsgenerator.com/wiki/uuid-regex
- https://ihateregex.io/expr/uuid/
- https://www.bobdc.com/blog/rdflabels/
- https://patterns.dataincubator.org/book/preferred-label.html
- https://www.w3.org/2004/12/q/doc/rdf-labels.html
- https://www.elastic.co/blog/significant-terms-aggregation
- https://www.elastic.co/docs/reference/aggregations/search-aggregations-bucket-significantterms-aggregation
- https://www.algolia.com/doc/guides/managing-results/must-do/searchable-attributes/how-to/configuring-searchable-attributes-the-right-way

---

## manifest-display-authoring-prior-art

I now have comprehensive, well-grounded material across all the requested platforms and the key trust-model precedent (Backstage's verbatim "for display purposes... ignored by some parts of the code... references always use name not title"). I have enough to synthesize the findings, consensus, and recommendation. No further searches needed.

---

# SLVP prior art: manifest-authored record display annotations

Research grounded in primary docs/specs (URLs cited). The decision: how PDPP scales display authoring across many connectors with low burden, while preserving the manifest-authored-not-client-authored trust principle.

## (a) Findings — each tied to a named product/spec + URL

**1. Backstage: a per-entity, optional, display-only `metadata.title` that explicitly does NOT replace the identity key — the exact trust model PDPP is reaching for.** Backstage's descriptor format declares `title` `[optional]` as "A display name of the entity, to be presented in user interfaces instead of the `name` property above, when available… Note that this is only for display purposes, and may be ignored by some parts of the code. Entity references still always make use of the `name` property for example, not the title." Profile display data for `User`/`Group` is a small, all-optional `spec.profile` block (`displayName`, `email`, `picture`) — "mainly for display purposes. All fields of this structure are also optional." This is the canonical separation of *authored display label* from *machine identity*, authored in the source descriptor (the manifest), with a graceful fallback to `name` when absent.
https://backstage.io/docs/features/software-catalog/descriptor-format/

**2. JSON Schema 2020-12: `title`/`description` are first-class annotation keywords (no validation effect), and any unknown/`x-` keyword is automatically collected as an annotation.** "None of these 'annotation' keywords are required… `title` … is a placeholder for a concise human-readable string summary." Core spec: "A JSON Schema MAY contain properties which are not schema keywords. Unknown keywords SHOULD be treated as annotations, where the value of the keyword is the value of the annotation." This is the spec basis that makes PDPP's `x_pdpp_role` legal and forward-compatible: it rides the standard annotation mechanism rather than fighting validation.
https://json-schema.org/understanding-json-schema/reference/annotations and https://json-schema.org/draft/2020-12/json-schema-core

**3. Directus: a per-collection display *template* string — `{{ field }}` placeholders mixed with literal text — used to represent a record in relationships, layouts, and lists.** "Display templates are used to represent an item in relationship fields… let you mix field values with your own text." Authored once per collection (stored in `directus_collections` metadata), e.g. an author relationship shows `{{ name }}`, and richer templates interpolate multiple fields plus literal glue text. This is the template/format-string archetype (vs. per-field roles).
https://directus.com/features/display-templates and https://docs.directus.io/user-guide/content-module/display-templates

**4. Strapi: per-content-type `mainField` (single primary display field) plus per-field `metadatas`.** Settings carry `"mainField": "title"` — "determines which field is used to represent an entry — for example, it's used to display relations to that content-type" — alongside per-field `metadatas` (`label`, `description`). This is the *single-role minimal declaration* pattern: declare just the one field that names the record; everything else defaults.
https://docs.strapi.io/user-docs/content-manager/configuring-view-of-content-type

**5. Salesforce: object-level `nameField` (the record's identifying field) + a `CompactLayout` whose *first field is the primary/prominent display field*.** `nameField` is the standard Name field on a `CustomObject`; the primary compact layout's first field "is the first field shown and serves as the prominent display field" and is what surfaces in mobile, Lightning, and Chatter digests. Two layers: one declared *primary/title* field, then an ordered short list of secondary fields — a tiered model authored in metadata, not guessed by the client.
https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_compactlayout.htm

**6. Singer SDK / Meltano & Airbyte: the connector (tap/source) author declares structural role metadata per stream — `primary_keys`, `replication_key`; `source_defined_primary_key`, `default_cursor_field` — and the platform respects source-declared values over inference.** Singer: "The Catalog object… defines schema, primary and replication keys." Airbyte's discover output carries `source_defined_primary_key` and `default_cursor_field` (an *array*, never null). These prove the established ELT pattern: *the source author owns role declarations* (which field is the key, which is the time cursor) and the consuming platform does not re-derive them. PDPP's `event-time`/`amount`/`actor` roles are the display-layer analog of `replication_key`/`primary_key`.
https://sdk.meltano.com/en/latest/classes/singer_sdk.Stream.html and (Airbyte catalog shape) https://github.com/airbytehq/airbyte/issues/48829

**7. Plaid: the *source/platform* normalizes raw rows into authored display primitives (`merchant_name`, `logo_url`, `personal_finance_category` + icon, `counterparties[]`) so clients never parse raw descriptions — with explicit graceful-null fallback.** "merchant_name… a more human-readable version… For some bank transactions (checks, transfers) where there is no meaningful merchant name, this value will be null"; the PFC icon exists specifically "when a merchant logo is not available." Plaid is the SLVP exemplar of *server/manifest-side authoring* of the title (merchant), the amount, the category, and a graceful default when a role can't be filled — exactly the transactions case PDPP cares about.
https://plaid.com/docs/api/products/enrich/ and https://plaid.com/docs/api/products/transactions/

**Supporting note (form-schema world): role/label hints live in a separate authored layer, not the client.** react-jsonschema-form keeps presentation in a `uiSchema` (`ui:title`, `ui:order`) distinct from the data schema; JSON Forms / `@koumoul/vjsf` use `x-display`. Confirms the cross-industry pattern of an *authored* presentation annotation layer rather than UI heuristics.
https://rjsf-team.github.io/react-jsonschema-form/docs/api-reference/uiSchema/

## (b) Consensus pattern

Across all seven, the same shape recurs:

1. **One required-ish anchor: a single declared "title/name/primary" field** (Backstage `metadata.title`, Strapi `mainField`, Salesforce `nameField`, Directus template's lead field). This is the highest-value, lowest-burden declaration and the only one most authors ever set.
2. **A short ordered set of secondary roles, all optional, with sensible defaults** (Salesforce compact-layout fields; Plaid amount/category/counterparty; Singer key/cursor roles). Declared per-record-type, not per-instance.
3. **Graceful degradation when nothing is declared:** fall back to the identity key/name (Backstage: "instead of `name`… when available"; Plaid: null + a generic icon). Never a hard failure, never client invention beyond an honest generic fallback.
4. **Two mechanical idioms coexist — per-field *roles* vs. a per-type *template string*.** Roles (Salesforce/Strapi/Singer/Backstage) are the dominant, composable, i18n-friendly, lower-burden choice; template strings (Directus) are more expressive for "`{{merchant}} — {{amount}}`"-style glue but push formatting/locale/escaping concerns into the authored string and are harder to validate.
5. **Authorship lives with the data-source author and is versioned with the schema/manifest, not the client.** Backstage states it outright (display title is in the descriptor, references use `name`); Singer/Airbyte make `source_defined_*` authoritative over inference; Merge.dev even treats end-user/client field remapping as a *separate, override* surface (GET-only Common Model overrides) so the source-authored mapping stays the default. The trust line is consistently drawn: client may *consume* the authored display, the client does not *author* it.

## (c) Recommendation for PDPP

**Keep the per-field `x_pdpp_role` model as the primary mechanism, formalize it as a small tiered role vocabulary with strong defaults, and explicitly do NOT add a client-evaluated template-string layer. Add an optional per-record-type template only as a manifest-authored, escape-safe convenience — never as a fallback the client fills in.** Concretely:

1. **Tier 0 — one declaration buys 80% of the value: `primary-title`.** Mirror Strapi `mainField` / Salesforce `nameField` / Backstage `metadata.title`. If a connector declares *only* `primary-title`, the explorer renders a correct title and a body that defaults to the next-most-salient declared role or an honest generic. This is the minimum-burden path and should be the documented "do at least this" for every connector.

2. **Tier 1 — a small, fixed, optional role set** (you already have it): `secondary`/`actor`/`amount`/`event-time`. Keep it a *closed vocabulary* (like Salesforce's typed compact-layout slots and Singer's named keys), so the renderer can reason about each role (format `amount` as money, `event-time` as a date, link `actor`) without per-record-type bespoke UI code. This is what lets messages declare `actor`+`secondary(body)` and transactions declare `amount`+`secondary(merchant)` with zero new components — the explicit goal.

3. **Tier 2 — sensible role defaults so "declare nothing" still degrades gracefully** (Backstage/Plaid pattern). When a connector declares nothing, fall back to the record's identity/name and an honest generic body — *never* field-name guessing on the SLVP path (this matches your already-shipped "honest generic fallback, no field-name guessing" decision and the Plaid null-merchant precedent). Defaults are computed, but the *honest-generic* nature of the fallback is the contract, not an invented title.

4. **Optional template string — only manifest-authored, only as expressive sugar, never as the trust surface.** If you ever want Directus-style `{{merchant}} — {{amount}}` composition, add it as an *additional* `x_pdpp_display_template` field **authored in the manifest and resolved against already-role-declared fields**, with server-side validation that every placeholder references a declared role/field. Treat it like Backstage's title: display-only, ignorable, with the role-based render as the guaranteed fallback. Do not let the client synthesize or edit it (that's Merge.dev's lesson — client remapping is a separate, GET-only *override* layer, not the default authorship).

**Weighing the trust principle explicitly:** the manifest-authored-not-client-authored rule is *exactly* the line Backstage draws ("only for display purposes… Entity references still always make use of the `name` property, not the title") and that Singer/Airbyte enforce (`source_defined_*` beats inference). Per-field roles uphold this best: each role is an atomic, validatable claim authored in the manifest and versioned with it, so the client's job is narrowed to "render the declared role" — it can never *invent* a title, only fall back to an honest generic when a role is absent. A template string, by contrast, smuggles formatting/locale/escaping logic into authored text and is the one place where "the client renders what the author wrote" can blur into "the client interprets a mini-language"; keeping it optional, manifest-only, validated-against-declared-roles, and strictly fallback-backed preserves the principle. **Net: tiered per-field roles (primary-title required-by-convention, a closed optional role set, honest generic defaults) is the SLVP-ideal scaling path; the template string is a manifest-authored convenience, not the foundation and not a client capability.**

## Sources
- Backstage descriptor format (title/profile, display-only, references use name): https://backstage.io/docs/features/software-catalog/descriptor-format/
- JSON Schema annotations + core (title/description; unknown keywords as annotations): https://json-schema.org/understanding-json-schema/reference/annotations · https://json-schema.org/draft/2020-12/json-schema-core
- Directus display templates (`{{ field }}` per-collection template string): https://directus.com/features/display-templates · https://docs.directus.io/user-guide/content-module/display-templates
- Strapi mainField + per-field metadatas: https://docs.strapi.io/user-docs/content-manager/configuring-view-of-content-type
- Salesforce CompactLayout / nameField (primary display field): https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_compactlayout.htm
- Singer SDK stream metadata (primary_keys/replication_key authored by tap): https://sdk.meltano.com/en/latest/classes/singer_sdk.Stream.html
- Airbyte catalog (`source_defined_primary_key`, `default_cursor_field`): https://github.com/airbytehq/airbyte/issues/48829
- Plaid Enrich/Transactions (merchant_name/logo/PFC/counterparties + null fallback): https://plaid.com/docs/api/products/enrich/ · https://plaid.com/docs/api/products/transactions/
- Merge.dev Field Mapping & Common Model overrides (client remap is a separate GET-only override): https://docs.merge.dev/supplemental-data/field-mappings/overview/ · https://help.merge.dev/en/articles/8593316-guide-to-overriding-common-model-fields
- OpenAPI `x-` vendor extensions (display hints ride x- annotations): https://swagger.io/docs/specification/v3_0/openapi-extensions/
- react-jsonschema-form uiSchema (presentation layer separate from data schema): https://rjsf-team.github.io/react-jsonschema-form/docs/api-reference/uiSchema/
- JSON:API (no spec display-label; `title` is an ordinary attribute / meta): https://jsonapi.org/format/

---
