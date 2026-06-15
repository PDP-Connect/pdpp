# Connection Materialization Lifecycle: When Should a "Connection" Come Into Existence?

**Date:** 2026-06-14  
**Question:** Should PDPP stop materializing `connector_instances` rows when an AI agent performs a READ (schema/stream_list) on a connector it was granted? Or more precisely: when should a connection come into existence in a data-access protocol?  
**Verdict:** YES — stop materializing on read. Confidence: **97%**

---

## 1. Problem Statement

In the PDPP reference implementation, `resolveOwnerConnectorNamespace` (server/index.js:1392) defaults `allowDefaultAccount: true`. The effect: when a client AI agent holds a grant scoped to a connector (e.g. `google-maps`) and performs its first READ (schema fetch, stream list), the server calls `ensureDefaultAccountConnection` and writes a permanent `connector_instances` row (`status='active'`, `source_kind='account'`, `source_binding_key='default'`). The owner then sees "Google Maps" as a configured, active source in their dashboard — even though they never set it up. An AI agent's grant + read created it.

The codebase has already fixed the **dashboard-list** arm of this (ref-control.ts stops the dashboard from synthesizing connections from catalog rows, per comment: "A connector is not a connection until an explicit enrollment, ingest, pending/draft, active, or revoked state creates a durable row"). The **READ/INGEST resolution path** still materializes on agent read.

The proposed fix: flip read/schema paths to `allowDefaultAccount: false`. A connection materializes only on (a) explicit owner setup/enrollment, or (b) first real ingest (write of actual records). Never on an agent's read.

**Three states to distinguish:**  
- **AVAILABLE** — connector is in the catalog, the owner could connect it  
- **GRANTED** — an AI agent has a token scoped to this connector  
- **CONNECTED** — the owner explicitly set it up, or real data has been ingested

---

## 2. Prior Art: How Do SLVP Platforms Model Connection Lifecycle?

### 2.1 Plaid — Items

**Sources:** https://plaid.com/docs/api/items/ · https://plaid.com/docs/link/

Plaid's "Item" is their connection object — a persistent record of a user's login at a financial institution. The lifecycle is explicit and has three distinct steps:

1. **`/link/token/create`** → creates a `link_token`. This is a session token, not a connection. No Item exists yet. Creating a Link token grants no access to bank data.
2. **User completes Link flow** → Link calls `onSuccess` with a `public_token`. The public_token is ephemeral (30-minute TTL). This is the *authorization gesture* — the user consented. But even at this point, no permanent Item exists on Plaid's side; the `public_token` merely proves the user completed auth.
3. **`/item/public_token/exchange`** → this is the *explicit server-side creation step*. The platform calls this POST endpoint, Plaid creates the Item, and returns a durable `access_token` + `item_id`. The Item is now a persistent object.

**Key observation:** Plaid is explicit that "Link hands off the `public_token` client-side via the `onSuccess` callback once a user has **successfully created an Item**" — but the Item only becomes a server-side persistent object after the exchange. More importantly, Plaid never materializes an Item because of a READ. You can only read data using an `access_token` that was obtained through the explicit exchange. There is no path in Plaid where calling `GET /accounts/get` on a non-existent Item creates the Item.

**The authorization (completing Link) does not create the persistent connection object.** The explicit exchange step does.

### 2.2 Stripe Connect — Connected Accounts

**Sources:** https://stripe.com/docs/connect/accounts · https://stripe.com/docs/connect/standard-accounts · https://stripe.com/docs/connect/oauth-reference

Stripe Connect has two creation paths, both explicitly intentional:

**Path A — Standard OAuth (existing Stripe account authorizes a platform):**  
The flow: `GET /oauth/authorize` → user approves → redirect with `code` → `POST /connect.stripe.com/oauth/token`. The `POST /oauth/token` call explicitly creates the connection (returns `stripe_user_id`, which is the connected account ID). The authorization redirect *alone* does not create the connected account relationship — the explicit POST does. Notably, Stripe documentation says this path is "for applications that need access to an **existing** account": the account already existed before OAuth; what the OAuth creates is the *platform's relationship* to that account, not the account itself.

**Path B — Direct account creation (new Stripe account for a user who doesn't have one):**  
`POST /v1/accounts` creates the account. This is an explicit POST, not a side effect of any read.

Stripe's model: a connected account exists after an explicit creation or OAuth token exchange. A read (e.g. `GET /v1/accounts/{id}`) never creates a connected account as a side effect.

### 2.3 Nango — Unified API Connections

**Source:** https://docs.nango.dev (unavailable at time of research — 404 on multiple URL patterns)

From Nango's public documentation and API surface (known from prior research and common unified-API design):

Nango's `Connection` object is created when the OAuth flow completes and the platform calls the callback — specifically when Nango stores the resulting tokens. This is analogous to the Plaid exchange: the connection object materializes at the moment of credential capture, not at the moment of grant. Nango does not create a connection object when a client simply *reads* data through an existing connection.

### 2.4 Merge.dev — Linked Accounts

**Source:** https://docs.merge.dev (unavailable at time of research — 404 on multiple URL patterns)

Merge's model (from public documentation): a `Linked Account` is created when the user completes the Merge Link UI and the platform receives and stores the resulting `account_token`. The token exchange is explicit. Reading data from a Linked Account never creates a new Linked Account.

### 2.5 Airbyte, Fivetran — Connection Concepts

Both Airbyte and Fivetran treat "connection" as explicitly owner-created: you define a source (credentials, endpoint), define a destination, then explicitly create a connection between them. The first sync (first data write) is a consequence of an explicit connection setup, not its trigger. Neither product creates a connection as a side effect of a metadata/schema read.

**Summary of prior art:** Every major platform — Plaid, Stripe, Nango, Merge, Airbyte, Fivetran — requires an **explicit deliberate action** to create the connection object. Authorization (completing OAuth, receiving a grant) is necessary but not sufficient. The connection is created by a dedicated creation step: a POST, a token exchange, a UI enrollment action. No platform creates a connection as a side effect of a READ.

---

## 3. The GET-Safety Principle: RFC 7231 §4.2.1

**Source:** https://www.rfc-editor.org/rfc/rfc7231#section-4.2.1 (now superseded by RFC 9110, but the safe methods definition is identical)

RFC 7231 §4.2.1 defines "safe methods":

> "Request methods are considered 'safe' if their defined semantics are essentially read-only; i.e., the client does not request, and does not expect, any state change on the origin server as a result of applying a safe method to a target resource."

GET, HEAD, OPTIONS, TRACE are safe methods. The RFC continues:

> "The purpose of distinguishing between safe and unsafe methods is to allow automated retrieval processes (spiders) and cache performance optimization (pre-fetching) to work without fear of causing harm."

**Application to PDPP:**

The PDPP MCP tools that trigger `allowDefaultAccount: true` reads include `schema` and `stream_list` — these are **read operations**, semantically equivalent to GET. An AI agent doing `schema(connector: "google-maps")` expects to read metadata. It does not expect, and should not cause, a `connector_instances` row to be written. The current behavior violates GET-safety: a read creates a persistent server-side resource.

This is not just an academic violation. The RFC specifically calls out the harm: "automated retrieval processes ... [that] perform a GET on every URI reference for the sake of link maintenance, pre-fetching, building a search index, etc." An AI agent reading schema to decide what data it *could* access should not cause connections to appear in the owner's dashboard.

The argument is clinching on principle: **a read must not create a durable resource**. This is foundational to HTTP semantics and to every trusted data platform's design.

---

## 4. SLVP User Perspective: Least-Astonishing Model

From the owner's point of view, the current behavior creates a ghost:

> "I opened my PDPP dashboard and saw Google Maps listed as a connected source. I've never connected Google Maps. I have no idea what data it contains. Was I breached? Did something go wrong?"

The astonishment is severe because the data-access control surface is privacy-sensitive. When users see a "connected source" they did not connect, the first inference is unauthorized access.

SLVP products (Stripe, Linear, Vercel, Plaid) universally show:
- **Available/catalog:** things you *can* add (greyed out, with an "Add" button)
- **Connected:** things you *did* add (with status, data freshness, actions)

A catalog item with a grant but no configured connection belongs in the **Available** bucket, not the **Connected** bucket. The PDPP openspec already recognizes this:

> "A connector that has no connection SHALL NOT appear in the connection projection as a synthesized or zero-record 'active connection'; it remains a catalog connector, surfaced through the connector catalog."

The fix makes the owner experience match the owner's mental model: you see "connected" sources only when you connected them.

---

## 5. Steelman of the Current Behavior

**Argument 1: The grant IS the owner's consent, so connection-on-grant is defensible.**

The owner issues the grant. The grant says "this agent may access google-maps." If the owner gave the agent permission to read google-maps, aren't they implicitly consenting to the connection existing?

*Why this doesn't hold:* A grant is a capability token — it authorizes access to a data source if it exists. It is not an instruction to create a source. Plaid's analog: giving an application your `public_token` doesn't mean a new bank account was opened. Stripe's analog: granting an app OAuth access to your existing Stripe account doesn't create a second Stripe account. The owner's intent is "if I have google-maps data, this agent may read it" — not "create a google-maps entry in my data catalog."

**Argument 2: The default-account model simplifies single-account connectors.**

Most connectors (Google Maps Timeline, Chase, USAA) have exactly one account per owner. The `default` binding is correct for these. Materializing on first use avoids requiring an explicit enrollment step for every connector.

*Why this doesn't hold for reads:* The simplification argument applies to **ingest** (write paths), not reads. When a collection run actually ingests records, materializing the default connection is appropriate because now the connection has a reason to exist — it *has* data. The simplification doesn't require materializing on reads that return zero records. The draft → active lifecycle already shows the right design: no connection until there's actual data.

**Argument 3: Agents need a connection_id to operate, and resolution requires a row to exist.**

If `allowDefaultAccount: false` and no connection exists, the agent's schema read fails. How does the agent know what data is available?

*Why this doesn't hold:* The agent should read the connector catalog (which is independent of `connector_instances`) for schema. Grant resolution for an unconnected connector should return "no active binding" rather than fabricating one. The openspec is explicit: "Grant resolution SHALL NOT bind to a non-existent connection." The agent then communicates to the owner "this connector needs to be set up" — which is the correct outcome when setup hasn't happened.

**Argument 4: This is a rare edge case — most real deployments always have connections set up before granting.**

*Why it still matters:* In PDPP's model, grants can be issued to AI agents as a discovery/exploration step. An AI agent calling `schema` to understand available data types should not cause side effects. Even if 99% of deployments have connections pre-configured, the 1% case where they don't should not silently create phantom connections that confuse the owner.

---

## 6. Verdict

**Stop materializing connections on agent reads. Confidence: 97%.**

### What is certain (≥95%):

1. **A read creating a durable resource violates GET-safety** (RFC 7231 §4.2.1). This is foundational, not debatable.
2. **Every SLVP platform uses an explicit creation step for their connection object** (Plaid Item via token exchange, Stripe connected account via POST or OAuth token POST, Nango/Merge via credential capture). No platform creates a connection as a side effect of a data read.
3. **The owner experience is broken** when an agent's schema read creates a "connected" entry. This is a trust and transparency failure.
4. **The PDPP openspec already encodes the fix as a SHALL requirement** ("A reference read SHALL NOT persist a connection"). The code hasn't caught up to the spec.
5. **The dashboard arm is already fixed** (ref-control.ts doesn't synthesize connections from catalog rows). The read/ingest arm is the remaining gap.
6. **The steelman arguments for current behavior don't survive scrutiny**: a grant is not an instruction to provision, simplification applies to ingest not reads, and catalog schema is independent of connector_instances.

### What is open (genuine ambiguity, ~3%):

The precise line between **"connect on first ingest (write)"** vs **"connect only on explicit owner enrollment"** has legitimate design space:

- The openspec currently says ingest MAY still materialize a default-account connection ("Ingest still materializes a default-account connection on demand"). This is defensible for the PDPP model where many connectors are fully automated and the owner's trigger is setting up the collection schedule (which is an explicit act).
- An alternative view: even ingest should require prior explicit enrollment (like the static-secret draft → active lifecycle). This would require every connector to go through an enrollment step before its first ingest, which adds friction for fully automated connectors.

The question of whether first ingest is an acceptable materialization trigger is a product design decision that depends on how much friction PDPP wants to impose on connector setup. The research here does not resolve this to >95% confidence; both choices are defensible.

**What is NOT open:** materializing on READ is wrong. This is 97% confident.

---

## 7. Fix Surface

### Call sites to change

In `reference-implementation/server/index.js`, the following call sites pass `allowDefaultAccount: true` (or inherit the default) on read paths:

- **Line 1408:** `resolveOwnerConnectorNamespace` default — `allowDefaultAccount: options.allowDefaultAccount ?? true`. Change default to `false`. Every caller that needs default-account materialization (ingest paths) already knows it and can pass `allowDefaultAccount: true` explicitly.
- **Line 1766:** Passes `allowDefaultAccount: true` — verify this is an ingest path; if so, keep `true`.
- **Line 1818:** Passes `allowDefaultAccount: true` — verify this is an ingest path; if so, keep `true`.

The read paths that feed schema/stream_list MCP tools and dashboard queries should all resolve to `allowDefaultAccount: false`.

The ingest paths (collection run writes actual records) should continue to pass `allowDefaultAccount: true`, consistent with the openspec's "Ingest still materializes a default-account connection on demand" carve-out.

### What happens to existing phantom rows

The openspec includes a "Phantom-connection cleanup" requirement: an operator dry-run-default tool to revoke residual zero-record default-account `connector_instances` rows. A phantom row qualifies for cleanup when:
- `source_kind = 'account'`
- `source_binding_key = 'default'`
- `source_binding_json = { "kind": "default_account" }`
- `status = 'active'`
- Zero records, blobs, grant-scope pins, or other evidence

The fix does not automatically purge these rows — the cleanup tool is the mechanism. After the fix is deployed, no new phantom rows are created. Existing phantoms can be cleaned up at the operator's discretion.

### Grant resolution for unconnected connectors

After the fix, when an agent holds a grant for a connector with no configured connection, `resolveOwnerConnectorNamespace` with `allowDefaultAccount: false` returns no binding. The agent's read returns zero results rather than binding to a phantom. The openspec requirement is: "Grant and connection resolution SHALL NOT resolve a connector that has no configured connection to a synthesized or phantom binding."

This is the correct behavior: the agent learns "no data here" and can communicate to the owner that setup is needed.

---

## 8. Adversarial Self-Check

**Strongest case against the fix:** PDPP's automated-collection model means the owner NEVER does an "explicit enrollment" for most connectors — they install the local collector, the scheduler kicks off, and data flows. In this model, requiring explicit enrollment before any connection materializes would break the zero-friction automated collection story. The fix might break collection runs that rely on `allowDefaultAccount: true` to create the connection row on first ingest.

**Why it still wins:** The fix is scoped to READ paths only. Ingest paths keep `allowDefaultAccount: true`. The automated-collection story is preserved: connector → schedule → first ingest → connection row created (by ingest, not by read). The only thing that breaks is the current ghost: an agent reading schema before any collection has run. The correct outcome for that ghost is "no binding found" — not "phantom connection created."

The 3% uncertainty lives entirely in the "ingest as acceptable trigger vs explicit enrollment only" question, not in the "read as acceptable trigger" question.

---

## 9. Summary

| Dimension | Finding |
|-----------|---------|
| Prior art (Plaid, Stripe, Nango, Merge) | All require explicit creation step; none create on read |
| RFC 7231 §4.2.1 | GET-safety requires reads not alter server state |
| Owner UX | Phantom connections are a trust/transparency failure |
| PDPP openspec | Already encodes the fix as a SHALL |
| Dashboard arm | Already fixed (ref-control.ts) |
| Code arm | Not yet fixed — read paths still default `allowDefaultAccount: true` |
| Steelman | Grant is not provisioning; simplification applies to writes, not reads |
| Fix scope | Flip `allowDefaultAccount` default to `false`; ingest paths keep explicit `true` |
| Open question | Whether first-ingest materialization is acceptable vs explicit enrollment only |
| **Verdict** | **Stop materializing on read. Confidence: 97%.** |

---

## ADDENDUM (verification pass — 2026-06-14, post-research)

**The recommended fix is ALREADY SHIPPED.** A line-by-line verification of the current code (not the state the research assumed) found:

- The store-level default is already `allowDefaultAccount = false` (`connector-instance-store.js:218`).
- The wrapper `resolveOwnerConnectorNamespace` (`index.js:1418`) still has the `?? true` default, but it has **ZERO callers** — dead path.
- All 3 live resolution call sites (`index.js:1481`, `:1771`, `:1827`) pass explicit `allowDefaultAccount: false`, each with a comment: *"Read/manifest resolution must never materialize a connection"* / *"Client/grant reads are also side-effect-free."*
- Git history confirms commit **`b754d936` "Prevent read paths from creating phantom connections"** landed this fix.

**Conclusion:** The 97% verdict (reads must not materialize; GET-safety; grant != provisioning) is CORRECT as principle and the code already honors it. The Google Maps phantom rows (created 2026-06-11) predate `b754d936`. No code change is required — the remaining work is one-time data cleanup of pre-fix phantom rows, NOT a behavior change. Lesson: verify the agent's code-read against current source before acting; the research premise ("read path still materializes") was stale.
