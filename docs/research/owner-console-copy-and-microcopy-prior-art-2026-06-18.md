# Owner Console Copy & Microcopy — Prior Art (Lens 8)

Date: 2026-06-18
Owner: RI owner
Status: Net-new prior-art research on status labels, error/empty/recovery copy, and
the owner/operator/protocol VOCABULARY BOUNDARY, in support of OpenSpec change
`redesign-owner-console-product-experience` and `docs/inbox/owner-feedback-2026-06-18.md`.

## Why this note exists (and what it extends)

The existing corpus covers the *structures* the copy sits inside —
`explorer-workbench-and-access-transparency-prior-art-2026-06-18.md` (workbench + access
lists), `slvp-connector-health-FINAL-design-2026-06-15.md` (health projection),
`slvp-ideal-stuck-run-liveness-2026-06-14.md` (run liveness), `control-plane-prior-art.md`,
and `trace-surface-patterns.md`. A sibling synthesis in this same workstream,
`owner-console-feedback-synthesis-2026-06-18.md` (present in this repo's
`docs/research/`, verified at edit time), names the cure at the *system* level and assigns
root codes: R1 "Source truth/projection drift," R2 "Noun and route drift," R4 "Recovery
agency/progress failure," R7 "Evidence-layer overload," with a P1 to "Remove owner-facing
implementation/debug leakage by enforcing an owner/operator/protocol vocabulary boundary"
(tagged R2/R7). This note cites those codes as scoping shorthand only; its
recommendations stand on the prior-art sources below regardless of that sibling doc.

What none of those docs do is provide the *word-level* substrate: a lexicon mapping
internal runtime states to owner-facing labels, reusable error/empty-state templates, and
a banned-vocabulary list. This note fills that gap (the sibling synthesis cures the
*system* level — nouns, IA, demoting evidence; this lens cures the *lexicon* level — the
exact words). It anchors to three the owner complaints that are specifically copy failures, not
layout failures:

1. **Wall-of-text runtime leakage** — "Suppressed evidence. Drain detail gap backlog is
   system here" rendered to an owner. This is internal scheduler/collector vocabulary
   escaping onto an owner surface (R7).
2. **Priority confusion** — "One Thing Needs You" headline contradicted by "three things
   wrong" below it. The headline microcontent lies about state (R1/R4).
3. **Route/nav name mismatch** — routes named differently than the nav that links to them,
   forcing the owner to translate (R2).
4. **Unlabeled status semantics** — "no indication of what yellow and green mean";
   "Collected" ambiguous (no-change vs new records); "1 needs review" with no path to the
   one (R1).

## (1) Prior-art sources

### Stripe — error object taxonomy and user-facing message split

Source: <https://stripe.com/docs/error-handling> (retrieved 2026-06-18) and
<https://docs.stripe.com/error-low-level> (retrieved 2026-06-18).

Stripe splits every error into a **machine `type` + `code`** (e.g. `card_error`,
`invalid_request_error`, `api_connection_error`, `api_error`, `authentication_error`,
`idempotency_error`, `rate_limit_error`) versus a **user-facing string**. The taxonomy
is explicitly two-layer: the typed code is for the integrator's branching logic; the
`error.message` "can be shown to your users" only for `card_error` / payment errors, and
for everything else the developer is told *not* to surface the raw message because it
describes a programming mistake, not something the end user can act on. Critically the
docs editorialize the severity in plain words inline: API errors are flagged "(These are
rare.)" and authentication/permission errors are described as "the API key used for this
request doesn't have the necessary permissions" — human cause, not a code. This is the
canonical pattern of **separating the diagnostic identifier from the human sentence, and
only promoting the human sentence to the end user when the end user can act on it.**

Stripe's voice in operator-facing flows (the dispute-response docs,
<https://stripe.com/docs/disputes/responding>, retrieved 2026-06-18) consistently leads
with the consequence and the deadline in plain language ("respond before the deadline or
the dispute is automatically lost") rather than the internal state name.

### GitHub — OAuth scope descriptions written for the grantor

Source: <https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps>
(retrieved 2026-06-18).

Every scope token is paired with a **plain-language capability sentence written from the
data owner's point of view**, leading with the verb the owner cares about:
`(no scope)` → "Grants read-only access to public information"; `repo` → "Grants full
access to public and private repositories including **read and write** access to code…";
`repo:status` → "Grants read/write access to commit statuses…**without** granting access
to the code." The descriptions consistently (a) front-load **read vs write**, (b) name the
**concrete resource** (code, statuses, deployments), and (c) call out the *negative* scope
boundary ("without granting access to the code") so the owner understands what is *not*
exposed. The scope token itself (`repo:status`) is the protocol identifier; the sentence
is the owner copy. They are never collapsed into one.

### GitHub — danger-zone / destructive-action copy

Source: <https://docs.github.com/en/repositories/creating-and-managing-repositories/deleting-a-repository>
(retrieved 2026-06-18).

The destructive-action copy pattern: a **Warning** callout that states the consequence in
bold absolute terms before the action — "Deleting a repository will **permanently** delete
team permissions. This action **cannot** be undone." — immediately followed by the *escape
hatch / reversibility window* ("Some deleted repositories can be restored within 90 days").
The live UI (well-documented "Danger Zone" pattern, observed product behavior) requires the
owner to **type the exact repository name** and confirm "I understand the consequences"
before the button enables. Pattern: state consequence → state reversibility → force
deliberate confirmation proportional to the blast radius.

### Sentry — issue status lexicon and triage states

Source: <https://docs.sentry.io/product/issues/states-triage/> (retrieved 2026-06-18) and
<https://docs.sentry.io/product/issues/issue-details/> (retrieved 2026-06-18).

Sentry uses a **small, closed vocabulary of owner-legible statuses**, each with a one-line
*condition* definition and a searchable term: `New` ("created in the last 7 days"),
`Ongoing` ("created more than 7 days ago or manually marked as reviewed"), `Escalating`
("exceeded its forecasted event volume"), `Regressed` ("a resolved issue that's come up
again"), `Archived`, `Resolved` ("marked as fixed"). Two rules worth copying: **"an issue
can only have one status at a time"** (single source of truth for the headline state), and
the statuses are grouped into a default "Unresolved" tab so the front door shows only the
states that need a human. Every status word is something a human triaging would say, and
each ships with its definition inline rather than relying on color alone.

### Vercel — deployment state language and reversibility framing

Source: <https://vercel.com/docs/deployments/managing-deployments> (retrieved 2026-06-18).

Vercel's deployment states are short adjectives an owner reads at a glance (Ready, Error,
Building, Queued, Canceled — observed product behavior across the dashboard). The docs copy
foregrounds **reversibility and consequence** for destructive actions in plain language:
deleting a deployment "prevents you from using **instant rollback** on it and might break
the links used in integrations." The verb is concrete ("Delete"), and the warning is about
the owner's *future capability loss*, not the internal record lifecycle.

### Railway — deployment lifecycle state names

Source: <https://docs.railway.com/reference/deployments> (retrieved 2026-06-18).

Railway exposes a deployment lifecycle with **gerund/adjective state names that read as
status, not as internal events**: `Building` ("Railway will attempt to create a deployable
Docker image…"), `Active`, `Completed`, `Crashed`, plus a transition pair `Removing` →
`Removed` for superseded deploys. Each state has a one-sentence definition of *what the
system is doing while in that state*. Note the discipline: the user sees `Crashed`
(legible failure word), and the internal cleanup churn (`Removing`/`Removed`) is named but
clearly marked as the *previous* deploy being retired, so a removed old deploy never reads
as "your service failed."

### Trigger.dev — run lifecycle states (background-job analogue closest to PDPP runs)

Source: <https://trigger.dev/docs/runs> (retrieved 2026-06-18).

Trigger.dev is the nearest analogue to PDPP's run/collector model: a "run" has a unique ID,
a current status, a payload, and metadata, and moves through a documented lifecycle with
**named initial states** ("Pending version": "waiting for a version update because it
cannot execute without additional information"; "Delayed": a run scheduled for later). The
takeaway is that each waiting/blocked state has an **owner-readable reason embedded in the
state's definition** ("waiting for X because Y") rather than a bare internal token — which
is exactly the antidote to PDPP's "Drain detail gap backlog" leak.

### Shopify Polaris — "write like merchants talk" voice rules and actionable language

Source: <https://polaris-react.shopify.com/content/actionable-language> (retrieved
2026-06-18) and <https://polaris-react.shopify.com/content/help-content> (retrieved
2026-06-18). (Note: the first page's URL slug is `actionable-language`, but the live page
renders under the heading **"Fundamentals — Designing content for experiences"**; the
quoted blocks below appear verbatim on that page under the sub-headings "Write like
merchants talk" and "Inspire action".)

Polaris's content fundamentals are blunt and directly usable: **"Write like merchants
talk… just focus on sounding human"**, use plain language, use contractions ("don't" not
"do not"), "some jargon is okay, as long as it's what actual merchants say," aim for a 7th
grade reading level, and the ship test: "Read it out loud. Does it sound like something a
human would say? Ship it." Help content guidance is progressive-disclosure-first: add help
text only when it clarifies, keep it concise, and put the essential message in the primary
copy rather than a help blurb.

### Nielsen Norman Group — error-message guidelines

Source: <https://www.nngroup.com/articles/error-message-guidelines/> (retrieved 2026-06-18).

NN/g's core rules: **"Use human-readable language… Avoid technical jargon"** and "Hide or
minimize the use of obscure error codes or abbreviations; show them for technical
diagnostic purposes only." **"Concisely and precisely describe the issue"** — generic
"An error occurred" lacks context — but **"beware of excessive technical precision… that
can undermine understandability"** because the user's mental model differs from the code's.
And **"Offer constructive advice"** — stating the problem is not enough, offer a remedy. It
also warns against hiding the situation behind cleverness (the cited Disney example
obscures "no results" with puns instead of saying it plainly).

### Nielsen Norman Group — empty-state design

Source: <https://www.nngroup.com/articles/empty-state-interface-design/> (retrieved
2026-06-18).

Empty states are a *learning* surface, not a blank: use them to provide **in-context
learning cues ("pull revelations")** that appear only when the user hits the empty element,
rather than forced upfront tutorials. The cited risk: when a panel is empty, "users may
wonder whether an error has occurred or whether they have accurately created the
parameters" — so an empty state must distinguish **"nothing here yet (expected)"** from
**"something is broken."** A brief system-status line ("there are no alerts") removes that
ambiguity.

### Nielsen Norman Group — microcontent (headlines/titles) and UI copy (commands)

Sources: <https://www.nngroup.com/articles/microcontent-how-to-write-headlines-page-titles-and-subject-lines/>
(retrieved 2026-06-18) and <https://www.nngroup.com/articles/ui-copy/> (retrieved
2026-06-18).

Headlines/titles must **work out of context** and **"tell readers something useful"** —
"avoid broad and generic headings," "remove nonessential words," and **"move the keywords
to the front."** UI copy (command labels) is distinct from microcontent and from link text:
commands "change the state of the system" and must be concise and specific. This is the
prior art for both the "One Thing Needs You" headline (a vague headline that fails the
out-of-context and accuracy tests) and for button labels.

## (2) Observed patterns (cross-source synthesis)

1. **Two-layer status: a closed set of owner adjectives + an internal event log.** Sentry,
   Railway, Vercel, Trigger.dev, and Stripe all keep a *small, fixed* vocabulary of
   owner-facing states, each with a one-line plain definition, separate from the rich
   internal event/code stream. The owner word is never the internal token.
2. **Single status at a time + a "needs human" front tab.** Sentry's "one status at a time"
   and default Unresolved tab is the convergent answer to PDPP's "One Thing Needs You vs
   three things wrong" contradiction: the headline must be a *deterministic projection* of
   one count, and the front door shows only states that need the human.
3. **Reason-embedded waiting states.** Trigger.dev ("waiting for X because Y"), Railway,
   and Stripe ("These are rare.") all embed the *why* in the state's own definition, so the
   owner never sees a bare token like "draining."
4. **Error copy = what / why / what to do, with the code demoted.** NN/g + Stripe converge:
   describe the issue precisely in human language, offer a remedy, and keep the diagnostic
   code present-but-secondary (copyable, not the headline).
5. **Scope/access copy is owner-POV, verb-first, with the negative boundary.** GitHub's
   scope sentences lead with read/write, name the concrete resource, and state what is
   *not* granted.
6. **Destructive copy: consequence → reversibility → proportional confirmation.** GitHub
   and Vercel both state the irreversible consequence in bold, then the recovery window,
   then force a confirmation matched to blast radius.
7. **Empty ≠ broken.** NN/g insists empty states disambiguate "nothing yet" from "error,"
   and double as in-context teaching.
8. **The voice test is "read it out loud."** Polaris + NN/g: plain language, contractions,
   ~7th-grade reading level, jargon only if it's the owner's own word.

## (3) PDPP implications

- **The "Suppressed evidence. Drain detail gap backlog is system here" leak** is a
  textbook violation of NN/g "avoid technical jargon / show codes for diagnostics only" and
  Trigger.dev "waiting for X because Y." `drain`, `detail gap`, `backlog`, `suppressed
  evidence` are scheduler/collector internals. They belong on the *evidence layer*
  (Runs/traces), never on an owner source headline. The owner-facing projection of that
  same runtime condition is one calm adjective + one reason sentence (see lexicon).
- **"One Thing Needs You" vs "three things wrong"** maps directly to Sentry's "one status
  at a time" rule. The hero headline must be a pure function of a single
  `needs_owner_action` count: if the count is 3, the headline says "3 sources need you," and
  the body lists exactly those three. The headline microcontent must pass NN/g's
  out-of-context test — it must be true and specific when read alone.
- **"No indication of what yellow and green mean."** Color is never the carrier of meaning
  (NN/g, Sentry — every status ships its definition inline). Each badge needs a text label
  *and* a one-line definition on hover/expand, drawn from the lexicon below.
- **"Collected" ambiguity (no-change vs new records).** "Collected" is a verb pretending to
  be a status. Following Sentry/Railway one-line definitions, split it into a state +
  delta: `Up to date` ("Last refresh added 0 new records") vs `Updated` ("Last refresh
  added 142 new records"). The owner word answers "is it current?"; the delta answers "did
  anything change?"
- **"1 needs review" with no path to the one.** Sentry's status *is* a saved search
  (`is:new`). PDPP's "needs review" headline must be a link/filter that lands on exactly
  the one subject, never a dead count.
- **Route/nav name mismatch.** This is a microcontent consistency failure (NN/g: titles
  must be specific and work out of context). The nav label, the page `<title>`/H1, and the
  route segment must be the *same owner noun* (`Source`/`Sources`). The internal route
  (`/connections/:id`) is protocol; the owner never reads it as a different word than the
  nav they clicked.
- **Access transparency copy.** Per GitHub scope sentences, the per-client "what can it
  read" answer (already structured in the access-transparency doc) must render each grant
  as a verb-first owner sentence: "Read your Amazon orders and Chase transactions" — not
  "package grant 19 child scopes."

## (4) Concrete affordance / copy / IA recommendations

### (a) Status-label lexicon — internal runtime term → owner-facing word + definition

The left column is internal vocabulary that currently leaks; the right is the owner label
plus its one-line definition (Sentry/Railway model: every word ships its definition).

| Internal runtime term (banned on owner paths) | Owner label | One-line owner definition |
|---|---|---|
| `checking`, `probing`, `reconciling` | **Checking…** | "Confirming the current state of this source." |
| `draining`, `drain detail gap backlog`, `detail gap` | **Catching up** | "Still pulling the rest of the records from the last refresh." |
| `suppressed evidence`, `evidence suppressed` | (never shown) → fold into | **Working** / **Catching up** | (internal; surfaces only in Runs detail) |
| `source-pressure cooldown`, `cooldown` | **Paused briefly** | "Waiting before the next try so we don't overload <Source>." |
| `degraded` (assisted, awaiting scheduled refresh) | **Idle** + stale badge | "Up to date as of <time>; next refresh is scheduled." |
| `degraded` (unattended, truly broken) | **Needs you** | "<Source> stopped refreshing. <one cause sentence>." |
| `needs_human_auth`, `otp_likely`, `manual_action_likely` | **Needs you** | "<Source> needs you to sign in / approve before it can refresh." |
| `stale` | **Out of date** | "Last refreshed <relative time>; newer data may exist." |
| `fresh`, `succeeded`, last run added 0 | **Up to date** | "Last refresh added 0 new records." |
| `succeeded`, last run added N>0 | **Updated** | "Last refresh added <N> new records." |
| `run_already_active`, `409 active run` | **Refreshing now** | "A refresh is already running." |
| `dead_letter`, `retry-dead-letters` | **Some items failed** | "<N> items couldn't be collected. Retry?" |
| `connection`, `connector_instance`, `grant_connector_state` | **Source** (owner) | (internal/API only) |
| `connector key` (e.g. `amazon-orders`) | **<Friendly source name>** | (token stays in evidence/diagnostics) |
| Run/sink/sync/watermark/cursor/emitted_at | **Refresh** / **Activity** | (Runs evidence layer only) |

Headline-state projection (Sentry "one status at a time"): per-source headline = the single
highest-severity state in priority order **Needs you > Refreshing now > Catching up >
Some items failed > Paused briefly > Out of date > Up to date**. The dashboard hero headline
= a pure count of sources in **Needs you**: 0 → "Everything's up to date." / 1 → "1 source
needs you." / N → "<N> sources need you," each linking to the filtered list.

### (b) Error-copy template — what happened / why / what to do

Three lines max on the owner path; the code is present but demoted (NN/g + Stripe).

```
<What happened — plain, specific, owner noun>
<Why — one human-cause sentence, no internal token>
[Primary action verb]   [Secondary]   ·  details ⌄ (code: <type/code>, copyable)
```

Worked example, replacing the leak:

- BAD (current): "Suppressed evidence. Drain detail gap backlog is system here."
- GOOD: "**Chase is still catching up.** The last refresh pulled your transactions; a few
  detail records are still loading. — *No action needed; check back in a few minutes.*
  · details ⌄"

- BAD: "degraded — needs_human_auth"
- GOOD: "**ChatGPT needs you to sign in.** Its saved session expired, so it can't refresh.
  — **Reconnect ChatGPT**  ·  details ⌄ (auth_expired)"

Rules: lead with the **owner subject** (the Source name), one cause sentence, one concrete
action verb (Polaris: "sounds like a human"), code only behind "details" and copyable for
support. Never start an owner error with a verb the owner didn't cause ("Drain…",
"Suppress…").

### (c) Empty-state template

Empty states must answer "is this empty because it's new, or because it's broken?" (NN/g)
and teach the next step in context.

```
<Icon>
<Headline: the expected reason, specific>      e.g. "No records yet from GitHub"
<One line: why this is normal + when it changes>  e.g. "Your first refresh is running.
                                                    Records appear here when it finishes."
[Primary CTA, verb-first]  (only if there is a real action)
```

Variants:
- **Not connected yet:** "You haven't added <Source>." + **[Add <Source>]**.
- **Connected, first refresh running:** "No records yet — first refresh is running." +
  live progress, **no** error styling.
- **Connected, genuinely zero results:** "No <records> match these filters." + **[Clear
  filters]** (distinct from "broken").
- **Broken:** route to the error template, not the empty template.

For Explore's bounded sample (owner: "6 of 1,183 without a basis label"): the result region
is never empty-state copy; it carries a **basis line** — "Showing 6 of 1,183 records
(newest first). [View all]" — so a small list never reads as missing data.

### (d) Banned-internal-vocabulary list (must not appear on any owner path)

Enforce as a lint/test over owner-facing console source strings (extends the
owner-journey acceptance scanner pattern in repo memory). Owner paths must not render:

- **Scheduler/collector internals:** `drain`, `draining`, `detail gap`, `gap backlog`,
  `backlog`, `suppressed evidence`, `evidence suppressed`, `cooldown` (raw), `watermark`,
  `cursor`, `emitted_at`, `sink`, `dead_letter`, `dead-letter`, `materialize`,
  `materialization`, `reconcile`/`reconciliation` (raw), `pacer`, `GCRA`, `AIMD`, `lane`.
- **Protocol/data-model nouns where an owner noun exists:** `connection`,
  `connector_instance`, `connector key`, `grant_connector_state`, `controller_active_runs`,
  `run_already_active`, `invalid_request`, `409`, raw HTTP/error codes in the headline,
  `BM25`, `pg_lexical_backfill`, `polyfill-connectors`, package/monorepo paths,
  `node reference-implementation/server/index.js`.
- **Status verbs masquerading as states:** bare `Collected`, bare `degraded`, bare
  `suppressed`, bare `checking` without a reason clause.

Allowed where the technical contract genuinely requires it: `Connection` in API/SDK docs
and developer surfaces; connector keys and codes **inside** the Runs/evidence layer and
behind "details," always copyable for support.

### (e) Microcontent rules for headlines, labels, and buttons

- Headlines pass the **out-of-context test** (NN/g): true and specific when read alone;
  keyword front-loaded; no clever puns hiding state.
- Nav label == page H1 == owner noun. One word: **Sources** (and **Apps with access**,
  **Activity**) — never a nav/route name mismatch.
- Buttons are **verb-first and specific** (NN/g UI copy, Polaris): "Add source",
  "Reconnect ChatGPT", "Retry failed items", "Refresh now" — never "OK", "Submit", or a
  noun.
- Voice: contractions, ~7th-grade reading level, read-it-out-loud test (Polaris).

## (5) Anti-patterns to avoid

- **Leaking the internal token as the owner state** ("draining", "drain detail gap
  backlog") — NN/g: codes are for diagnostics only.
- **Headline that contradicts the body** ("One Thing Needs You" over three problems) —
  violates Sentry "one status at a time" and NN/g headline-accuracy.
- **Color without words** ("what do yellow and green mean") — every status ships a label +
  definition.
- **Generic errors** ("An error occurred", "Something went wrong") with no cause and no
  remedy — NN/g.
- **Verb-as-status** ("Collected") that can't answer "is it current / did anything change."
- **Empty state that looks like an error** (or vice versa) — NN/g empty-state ambiguity.
- **Showing a raw bounded sample with no basis line** ("6 of 1,183") — reads as data loss.
- **Destructive action with no consequence/reversibility copy and no confirmation
  proportional to blast radius** — counter to GitHub/Vercel.
- **Clever/jokey copy that hides the real state** (NN/g Disney pun example).
- **Nav/route/title using three different words for the same object.**

## (6) Acceptance checks (owner-walkable, testable)

1. **No banned vocabulary on owner paths.** A string-scan test over the owner console
   surfaces (dashboard + source pages, not the Runs/evidence layer) finds zero occurrences
   of the banned list in (d). The specific phrase "Drain detail gap backlog" and the word
   "Suppressed evidence" appear nowhere on an owner path.
2. **Every status badge has a text label and an inline definition.** No source/grant state
   is conveyed by color alone; hovering/expanding any badge shows its one-line definition
   verbatim from the lexicon. An owner can answer "what does yellow mean" from the UI.
3. **Hero headline equals the needs-you count.** With N sources in **Needs you**, the hero
   reads "<N> source(s) need you" (or "Everything's up to date" at 0); it never says "One
   Thing Needs You" while >1 source is broken. The headline links to the filtered list of
   exactly those N.
4. **"Needs review/needs you" is a working link to the subject(s).** Clicking the count
   lands on exactly the named source(s); there is no dead count.
5. **Every error follows what/why/what-to-do.** Each owner error shows an owner-subject
   line, a one-sentence human cause, at least one verb-first action, and the code only
   behind "details" (and copyable). No owner error opens with an internal verb.
6. **Collected ambiguity resolved.** A source whose last refresh added 0 records reads
   "Up to date — last refresh added 0 new records"; one that added N reads "Updated — last
   refresh added N new records." The owner can distinguish no-change from new-data without
   opening a run.
7. **Bounded samples carry a basis line.** Any capped result region shows
   "Showing X of Y (<sort basis>)" with a path to the full set; no capped list renders as
   bare rows.
8. **Empty ≠ broken.** A connected source mid-first-refresh shows the "first refresh
   running" empty copy (no error styling); a never-added source shows "You haven't added
   <Source>" + Add CTA; a broken source uses the error template. The three are visually and
   verbally distinct.
9. **Nav == title == noun.** For every owner destination, the nav label, the page H1, and
   the browser title use the same owner noun; the owner never has to map a nav word to a
   different page word.
10. **Destructive actions state consequence + reversibility + confirmation.** Revoke/delete
    flows show the irreversible consequence in plain bold, the recovery window if any, and
    require a confirmation proportional to blast radius (e.g. type the source name for
    delete), per the GitHub/Vercel pattern.

## Confidence

- **High** that the two-layer model (closed owner-adjective set with inline definitions +
  demoted internal codes) is the convergent, well-documented target across Stripe, Sentry,
  Railway, Vercel, Trigger.dev, GitHub, and NN/g, and that it directly fixes the named
  leak, the headline contradiction, and the color-only-status complaint.
- **High** that the banned-vocabulary list is enforceable as a string-scan test (the repo
  already runs an owner-journey scanner of this exact shape).
- **Medium** on the exact owner wording (e.g. "Catching up" vs "Still loading") — the
  lexicon column is a strong default to be confirmed in the owner-reviewed mock, not
  settled by prior art alone.

## Sources

- Stripe — Error handling — <https://stripe.com/docs/error-handling> (2026-06-18)
- Stripe — Advanced error handling — <https://docs.stripe.com/error-low-level> (2026-06-18)
- Stripe — Respond to disputes (operator voice) — <https://stripe.com/docs/disputes/responding> (2026-06-18)
- GitHub — Scopes for OAuth apps — <https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps> (2026-06-18)
- GitHub — Deleting a repository (danger zone) — <https://docs.github.com/en/repositories/creating-and-managing-repositories/deleting-a-repository> (2026-06-18)
- Sentry — Issue status / triage states — <https://docs.sentry.io/product/issues/states-triage/> (2026-06-18)
- Sentry — Issue Details — <https://docs.sentry.io/product/issues/issue-details/> (2026-06-18)
- Vercel — Managing deployments — <https://vercel.com/docs/deployments/managing-deployments> (2026-06-18)
- Railway — Deployments (lifecycle states) — <https://docs.railway.com/reference/deployments> (2026-06-18)
- Trigger.dev — Runs (run lifecycle states) — <https://trigger.dev/docs/runs> (2026-06-18)
- Shopify Polaris — Actionable language — <https://polaris-react.shopify.com/content/actionable-language> (2026-06-18)
- Shopify Polaris — Help content — <https://polaris-react.shopify.com/content/help-content> (2026-06-18)
- NN/g — Error-message guidelines — <https://www.nngroup.com/articles/error-message-guidelines/> (2026-06-18)
- NN/g — Designing empty states — <https://www.nngroup.com/articles/empty-state-interface-design/> (2026-06-18)
- NN/g — Microcontent (headlines, titles) — <https://www.nngroup.com/articles/microcontent-how-to-write-headlines-page-titles-and-subject-lines/> (2026-06-18)
- NN/g — UI copy (command names) — <https://www.nngroup.com/articles/ui-copy/> (2026-06-18)
