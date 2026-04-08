# PDPP Demo v2 — Implementation Plan

## Goal

A single-page, Docker-based demo that makes the full PDPP spec visible and visceral to a non-technical audience (CEO, product, engineering). The demo uses a **real browser scraping real Instagram**, no mocks. Every spec feature that can be shown, is shown.

---

## What the demo proves (in order of appearance)

| # | Feature | Spec section | Visual moment |
|---|---|---|---|
| 1 | **Consent with purpose binding** | §5, §6 | Consent card shows purpose URI + human description + exact fields + access mode |
| 2 | **AI training explicit consent** | §5 | Second consent step for `ai_training` purpose code — extra affirmative checkbox required |
| 3 | **Field projection** | §8 | Client receives `id`+`username` only; `full_name` and `is_verified` stripped by RS |
| 4 | **Stream isolation** | §8 | `ad_targeting` collected and on server; client grant never touched it |
| 5 | **Temporal gating** (`consent_time_field`) | §7 | Client queries `posts`; RS filters to post-consent timestamp only |
| 6 | **Owner self-export** | §8 | Same RS, owner token sees all fields on all streams |
| 7 | **`single_use` expiry** | §6 | After first successful query, token is spent; second query → 403 |
| 8 | **Grant revocation** | §6 | Presenter clicks Revoke; next client query → 403 `grant_revoked` |
| 9 | **Incremental sync** (`changes_since`) | §4 | Terminal shows `next_changes_since` cursor; second run fetches only delta |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (user's machine)                                        │
│                                                                  │
│  ┌───────────────┐  ┌─────────────────────┐  ┌───────────────┐ │
│  │ ClientPanel   │  │  ServerPanel        │  │ TerminalPanel │ │
│  │ (left)        │  │  (center, widest)   │  │ (right)       │ │
│  │               │  │                     │  │               │ │
│  │ Grant request │  │ ConnectionFlow UI   │  │ xterm.js      │ │
│  │ Results       │  │  - consent card     │  │ log stream    │ │
│  │ Comparison    │  │  - cred form        │  │               │ │
│  │ Revoke btn    │  │  - live canvas      │  │               │ │
│  │               │  │  - stream bars      │  │               │ │
│  └───────────────┘  └──────┬──────────────┘  └───────────────┘ │
│                            │ WebSocket (frames + control)        │
└────────────────────────────┼────────────────────────────────────┘
                             │
              ┌──────────────▼──────────────┐
              │  browser-server (port 3100)  │
              │  Node.js + Playwright        │
              │  Runs instagram script       │
              │  Streams CDP JPEG frames     │
              │  Handles input:request       │
              └──────┬──────────────────────┘
                     │  HTTP ingest
         ┌───────────▼──────────────┐
         │  pdpp-server             │
         │  AS  (port 7662)         │
         │  RS  (port 7663)         │
         │  SQLite, in-memory       │
         └──────────────────────────┘
```

**Docker Compose services:**
- `pdpp-server` — existing e2e AS+RS, no changes needed
- `browser-server` — rewritten to speak the context-gateway WebSocket protocol
- `app` — Next.js, completely rewritten

**Deleted:** `mock-platform` (no longer needed)

---

## Instagram connector design

### Streams

```
connector_id: https://registry.pdpp.org/connectors/instagram
```

| Stream | Semantics | `consent_time_field` | Fields |
|---|---|---|---|
| `profile` | `mutable_state` | null | `username`, `full_name`, `bio`, `follower_count`, `following_count`, `is_verified`, `profile_pic_url` |
| `following_accounts` | `mutable_state` | null | `id`, `username`, `full_name`, `is_verified` |
| `posts` | `append_only` | `taken_at` | `id`, `shortcode`, `caption`, `like_count`, `comment_count`, `taken_at`, `media_type` |
| `ad_targeting` | `mutable_state` | null | `topics`, `advertisers`, `categories` |

### Views

On `following_accounts`:
- `social_graph` — fields: `id`, `username` (what "Audience Lens" gets)
- `full_social_graph` — fields: `id`, `username`, `full_name`, `is_verified`

On `posts`:
- `summary` — fields: `id`, `shortcode`, `taken_at`, `media_type`
- `full` — all fields

### Demo grant scenario

**Requesting app:** "Audience Lens" — a research tool studying influencer networks

**Grant A (the demo grant, `single_use`):**
```json
{
  "purpose_code": "https://pdpp.org/purpose/research",
  "purpose_description": "Analyze your social graph for an influencer network study",
  "access_mode": "single_use",
  "streams": [
    { "name": "following_accounts", "view": "social_graph" },
    { "name": "posts", "view": "summary", "time_range": { "since": "<grant_issued_at>" } }
  ]
}
```

**Grant B (the AI training grant, second demo beat):**
```json
{
  "purpose_code": "https://pdpp.org/purpose/ai_training",
  "purpose_description": "Use your social connections to improve recommendation models",
  "access_mode": "ongoing",
  "streams": [
    { "name": "following_accounts", "view": "social_graph" }
  ]
}
```

Grant B demonstrates the mandatory explicit affirmative consent for `ai_training`. The consent card must show an additional "I explicitly consent to AI training use" checkbox that the user must check before Allow is enabled.

---

## Demo flow (linear, auto-advancing with optional manual override)

```
idle
  → [presenter clicks "Connect Instagram"]
requesting (1s)
  → grant request constructed, shown in ClientPanel
consenting_research (4s auto or manual click)
  → consent card shown in ServerPanel (purpose, fields, access mode)
  → presenter can click "Allow Access" early
consenting_ai_training (5s auto or manual click)
  → second consent card for ai_training purpose
  → extra checkbox required; auto-checks after 3s for demo flow
  → presenter can manually check + click
authenticating
  → credential form appears in ServerPanel (input:request from script)
  → presenter enters real Instagram username + password
  → (this is the only manual step in the flow)
scraping
  → live CDP canvas visible, browser navigating Instagram
  → stream progress bars filling: following_accounts, posts, ad_targeting
  → logs streaming in terminal
done_comparison
  → split view: client got 2 fields, owner sees 4 fields + ad_targeting
  → posts filtered to post-consent (likely 0 if account is older)
  → presenter can click "Revoke" or "Query Again (expired)"
revoked / expired
  → 403 shown in terminal and ClientPanel
```

---

## File structure to build

```
pdpp/demo/
├── docker-compose.yml          (rewrite: drop mock-platform)
├── Dockerfile.pdpp-server      (unchanged)
│
├── browser-server/
│   ├── Dockerfile              (unchanged: mcr.microsoft.com/playwright:v1.43.0-jammy)
│   ├── package.json            (playwright pinned to 1.43.0, add ws, express)
│   └── index.js                (REWRITE — see spec below)
│
└── app/
    ├── Dockerfile              (unchanged)
    ├── package.json            (unchanged)
    ├── next.config.mjs         (unchanged)
    ├── src/
    │   ├── app/
    │   │   ├── globals.css     (unchanged)
    │   │   ├── layout.tsx      (unchanged)
    │   │   ├── page.tsx        (unchanged)
    │   │   └── api/
    │   │       ├── setup/route.ts          (REWRITE for Instagram manifest)
    │   │       ├── grant/route.ts          (unchanged)
    │   │       ├── grant/approve/route.ts  (unchanged)
    │   │       ├── grant/[grantId]/revoke/route.ts  (NEW)
    │   │       └── query/route.ts          (unchanged)
    │   └── components/
    │       ├── DemoPage.tsx        (REWRITE — new state machine)
    │       ├── DemoHeader.tsx      (minor update — new steps)
    │       ├── ClientPanel.tsx     (REWRITE — Instagram data, revoke button)
    │       ├── ServerPanel.tsx     (REWRITE — ConnectionFlow pattern)
    │       │   ├── ConsentCard.tsx     (extract, add AI training variant)
    │       │   ├── CredentialForm.tsx  (NEW — input:request handler)
    │       │   ├── BrowserCanvas.tsx   (extract + fix scaling)
    │       │   └── StreamProgress.tsx  (extract)
    │       └── TerminalPanel.tsx   (unchanged)
```

---

## Component specifications

### `browser-server/index.js` — REWRITE

This is the most critical file. It must implement the **context-gateway WebSocket protocol** so the frontend can use the same `useSession`-style hook.

**WebSocket protocol (server → client):**
```js
{ type: 'frame', data: '<base64 jpeg>' }
{ type: 'status', status: 'idle'|'running'|'done'|'error' }
{ type: 'log', level: 'info'|'warn'|'error', message: string }
{ type: 'stream-complete', stream: string, count: number }
{ type: 'result', data: any }
{ type: 'automation:data', key: string, value: any }  // for status text updates
{ type: 'input:request', requestId: string, input: { title, description, schema, uiSchema, submitLabel } }
```

**WebSocket protocol (client → server):**
```js
{ type: 'start-scrape', connectorId: string, ownerToken: string, grantIssuedAt: string }
{ type: 'input:response', requestId: string, values: { username: string, password: string } }
{ type: 'input:cancel', requestId: string }
{ type: 'mouse', action: string, x: number, y: number }
{ type: 'keyboard', action: string, key: string }
{ type: 'reset' }
```

**`input:request` flow:**
1. Instagram script calls `requestInput(config)` (a helper function in index.js)
2. Server sends `{ type: 'input:request', requestId, input: config }` to WS client
3. Server awaits a Promise stored in `inputWaiters` Map
4. Client renders credential form, user fills it, client sends `input:response`
5. Server resolves the Promise with submitted values
6. Script proceeds with credentials

**Instagram scraping script** (inline in index.js as a string, executed via `runScript()`):

The script is adapted from `context-gateway/public/automations/instagram-headless.js` with these changes:
- Replace `page.getInput()` with the local `requestInput()` helper
- Replace `page.setData()` with WS `automation:data` broadcast
- Ingest each record to PDPP RS immediately after scraping (no batching delay needed, but add `waitForTimeout(150)` for visual effect)
- Ingest `following_accounts`, `posts`, and `ad_targeting` streams
- Broadcast `stream-complete` after each stream
- The `grantIssuedAt` timestamp (received in `start-scrape`) is stored and passed to `ingestRecord` so `posts.taken_at` can be tested against it

**Canvas scaling fix:**
The current canvas is blurry because `canvas.width/height` (pixel dimensions) don't match the CSS `width/height: 100%`. Fix by:
```js
// Server side: use consistent viewport
const VIEWPORT = { width: 1280, height: 800 };
// When screencasting, maxWidth/maxHeight must match
await cdpSession.send('Page.startScreencast', {
  format: 'jpeg', quality: 85,
  maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height,
  everyNthFrame: 1,
});
```
```tsx
// Client side: canvas intrinsic size matches viewport exactly
<canvas
  width={VIEWPORT.width}   // intrinsic pixel dimensions
  height={VIEWPORT.height}
  style={{ width: '100%', height: '100%', objectFit: 'contain' }}
/>
```
The key: `objectFit: 'contain'` on the canvas CSS, and canvas `width/height` attributes matching the screencast dimensions exactly.

---

### `DemoPage.tsx` — REWRITE

**State machine:**
```ts
type DemoPhase =
  | 'idle'
  | 'requesting'
  | 'consenting_research'   // first consent card
  | 'consenting_ai'         // second consent card (ai_training)
  | 'authenticating'        // waiting for user to enter Instagram creds
  | 'scraping'              // browser running
  | 'done'                  // comparison visible
  | 'error';
```

**Key state:**
```ts
interface DemoState {
  phase: DemoPhase;
  ownerToken: string | null;
  connectorId: string | null;
  // Grant A (research)
  researchDeviceCode: string | null;
  researchToken: string | null;
  researchGrant: Grant | null;
  researchGrantIssuedAt: string | null;
  // Grant B (ai_training)
  aiDeviceCode: string | null;
  // Scrape results
  streamCounts: Partial<Record<string, number>>;
  clientResults: Record<string, unknown[]>;   // under research grant
  rawResults: Record<string, unknown[]>;      // owner self-export
  // Post-demo state
  tokenSpent: boolean;
  grantRevoked: boolean;
  error: string | null;
}
```

**Auto-advance timers:**
- `consenting_research` → after 4s, call `handleApproveResearch()`
- `consenting_ai` → after 5s (to show the extra checkbox moment), call `handleApproveAi()`
- Presenters can always click buttons to advance early

**WS connection:**
- Connect on mount (not lazily) so the canvas is ready when scraping starts
- Use `addEventListener('open', ..., { once: true })` to send `start-scrape`

**After scrape done (`browserStatus === 'done'`):**
1. Fetch `following_accounts` with research token → `clientResults`
2. Fetch `following_accounts` with owner token → `rawResults` (full fields)
3. Fetch `posts` with research token → `clientResults.posts` (should be empty or near-empty due to time_range)
4. Fetch `ad_targeting` with owner token → `rawResults.ad_targeting`
5. Set phase to `done`

**Revocation:**
- `handleRevoke()` → calls `DELETE /api/grant/[grantId]/revoke`
- Sets `grantRevoked: true`
- Triggers a re-query attempt that logs the 403 in the terminal

**Single-use expiry demonstration:**
- After first successful query, attempt a second query with the same token
- The `single_use` logic in auth.js marks the grant `consumed` on first token issuance
- But the token itself is still valid for 24h in the current impl — **this needs a change** (see AS changes below)

---

### `ServerPanel.tsx` + sub-components — REWRITE

The center panel is now a **ConnectionFlow** — it transitions between states, not just shows a browser viewport.

#### `ConsentCard.tsx`

Props:
```ts
interface ConsentCardProps {
  variant: 'research' | 'ai_training';
  onApprove: () => void;
  autoApproveIn: number; // seconds, for countdown display
}
```

**Research variant:**
- App: "Audience Lens" with a graph icon
- Purpose: "Analyze your social graph for an influencer network study"
- Purpose code displayed: `pdpp.org/purpose/research` (shown as a badge, not hidden)
- Streams: `following_accounts` (view: `social_graph` — fields: id, username) ✓, `posts` (view: `summary`, time-gated) ✓, `ad_targeting` ✗ not requested
- Access mode: `single_use` badge
- Auto-approve countdown timer visible (e.g. "Auto-approving in 4s...")
- Allow + Deny buttons (Deny resets)

**AI training variant:**
- Same app, same purpose URI shown
- Additional red warning banner: "This request includes AI training use"
- Extra checkbox: "I explicitly consent to my data being used to train AI models"
- Checkbox is auto-checked after 3s in demo (but visually shows the check happening)
- Allow button disabled until checkbox is checked
- Spec quote shown: "The AS MUST obtain explicit affirmative consent for ai_training"

#### `CredentialForm.tsx`

Shown when `phase === 'authenticating'`.

```ts
interface CredentialFormProps {
  onSubmit: (values: { username: string; password: string }) => void;
  onCancel: () => void;
  error?: string; // from previous failed attempt
}
```

- Instagram logo
- "Enter your Instagram credentials" heading
- Username input (text)
- Password input (password, with show/hide toggle)
- "Your credentials are used once and never stored" disclaimer
- Submit button
- Note: "The browser will handle 2FA if required"

#### `BrowserCanvas.tsx`

```ts
interface BrowserCanvasProps {
  onFrame: (cb: (data: string) => void) => void;
  sendInput: (msg: unknown) => void;
  status: 'idle' | 'running' | 'done' | 'error';
}
```

Fix the blur: `canvas width={1280} height={800}` (intrinsic) + CSS `width: 100%; height: auto; display: block;` on the containing div with `aspect-ratio: 1280/800`. The canvas element itself: `style={{ width: '100%', height: '100%' }}` inside the aspect-ratio container.

#### `StreamProgress.tsx`

Three bars for `following_accounts`, `posts`, `ad_targeting`. Same as before but with record counts and "NOT REQUESTED" label on `ad_targeting` for client view (vs "COLLECTED" for owner view).

---

### `ClientPanel.tsx` — REWRITE

**Idle:** "Connect Instagram" button

**Requesting / consenting:** Show the grant request being constructed:
- Client ID: `audience_lens_app`
- Purpose code: `pdpp.org/purpose/research`
- Streams requested: `following_accounts (social_graph view)`, `posts (summary, time-gated)`
- NOT requesting: `ad_targeting`, `profile`

**Scraping:** "Awaiting data collection..."

**Done:** Three-part comparison:

*Part 1 — Following accounts*
```
CLIENT RECEIVED (under grant)          OWNER SELF-EXPORT
─────────────────────────────          ─────────────────────────────
150 accounts                           150 accounts
fields: id, username only              fields: id, username, full_name, is_verified
─────────────────────────────          ─────────────────────────────
@radiohead                             @radiohead  Radiohead  ✓verified
@kendricklamar                         @kendricklamar  Kendrick Lamar  ✓verified
+148 more                              +148 more
```

*Part 2 — Posts (temporal gating)*
```
CLIENT RECEIVED (posts after consent)  OWNER SELF-EXPORT (all posts)
─────────────────────────────          ─────────────────────────────
0 posts (granted since: <now>)         847 posts (all time)
time_range enforced by RS              no time restriction
```

*Part 3 — Ad targeting (stream isolation)*
```
CLIENT                                 OWNER
─────────────────────────────          ─────────────────────────────
[stream not in grant]                  23 targeting categories
Access denied — not in grant           47 advertisers
                                       "Fashion & Style", "Music", ...
```

**Revoke button** (prominent, shown in Done phase):
- `onClick={handleRevoke}`
- After click: shows "Grant revoked" in red, next query attempt shows 403

**Query Again button** (shown after first comparison):
- Uses the same client token
- For `single_use`: should return 403 `grant_expired` or the token should be invalidated
- For revoked: 403 `grant_revoked`

---

### `api/setup/route.ts` — REWRITE

Register the Instagram manifest (all 4 streams with proper schemas, views, consent_time_field on posts). Issue owner token for demo subject `instagram_demo_user`.

**Instagram manifest:**
```ts
const INSTAGRAM_MANIFEST = {
  protocol_version: '0.1.0',
  connector_id: 'https://registry.pdpp.org/connectors/instagram',
  version: '1.0.0',
  display_name: 'Instagram',
  streams: [
    {
      name: 'profile',
      semantics: 'mutable_state',
      schema: { type: 'object', properties: {
        username: { type: 'string' },
        full_name: { type: 'string' },
        bio: { type: 'string' },
        follower_count: { type: 'integer' },
        following_count: { type: 'integer' },
        is_verified: { type: 'boolean' },
        profile_pic_url: { type: 'string' },
      }, required: ['username'] },
      primary_key: ['username'],
      consent_time_field: null,
      selection: { fields: true, resources: false },
      views: [
        { id: 'public', label: 'Public profile', fields: ['username', 'full_name', 'follower_count', 'following_count', 'is_verified'] },
      ],
    },
    {
      name: 'following_accounts',
      semantics: 'mutable_state',
      schema: { type: 'object', properties: {
        id: { type: 'string' },
        username: { type: 'string' },
        full_name: { type: 'string' },
        is_verified: { type: 'boolean' },
      }, required: ['id', 'username'] },
      primary_key: ['id'],
      consent_time_field: null,
      selection: { fields: true, resources: false },
      views: [
        { id: 'social_graph', label: 'Social graph (usernames only)', fields: ['id', 'username'] },
        { id: 'full_social_graph', label: 'Full social graph', fields: ['id', 'username', 'full_name', 'is_verified'] },
      ],
    },
    {
      name: 'posts',
      semantics: 'append_only',
      schema: { type: 'object', properties: {
        id: { type: 'string' },
        shortcode: { type: 'string' },
        caption: { type: 'string' },
        like_count: { type: 'integer' },
        comment_count: { type: 'integer' },
        taken_at: { type: 'string', format: 'date-time' },
        media_type: { type: 'string', enum: ['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM'] },
      }, required: ['id', 'taken_at'] },
      primary_key: ['id'],
      consent_time_field: 'taken_at',
      selection: { fields: true, resources: false },
      views: [
        { id: 'summary', label: 'Post summaries', fields: ['id', 'shortcode', 'taken_at', 'media_type'] },
        { id: 'full', label: 'Full post data', fields: ['id', 'shortcode', 'caption', 'like_count', 'comment_count', 'taken_at', 'media_type'] },
      ],
      incremental: true,
    },
    {
      name: 'ad_targeting',
      semantics: 'mutable_state',
      schema: { type: 'object', properties: {
        topics: { type: 'array', items: { type: 'string' } },
        advertisers: { type: 'array', items: { type: 'string' } },
        categories: { type: 'array', items: { type: 'string' } },
      } },
      primary_key: ['record_id'],  // single synthetic record
      consent_time_field: null,
      selection: { fields: true, resources: false },
      views: [],
    },
  ],
};
```

Also add `DELETE` handler to this route (fixes the 405 error on reset):
```ts
export async function DELETE() {
  // No-op for now (in-memory DB resets on server restart)
  // Could clear tables if needed
  return NextResponse.json({ ok: true });
}
```

### `api/grant/[grantId]/revoke/route.ts` — NEW

```ts
export async function POST(req, { params }) {
  const { grantId } = await params;
  const resp = await fetch(`${AS_URL}/grants/${grantId}/revoke`, { method: 'POST' });
  const data = await resp.json();
  return NextResponse.json(data);
}
```

---

## AS changes needed

### 1. Single-use token enforcement

Currently `single_use` marks the grant `consumed` but the token remains valid. The spec implies the token should be invalid after the first query (or more precisely, the grant allows only one data retrieval session).

**Required change in `e2e/server/auth.js`:**

In `introspect()`, after checking `active` status:
```js
// For single_use grants, check if consumed
if (row.token_kind === 'client') {
  const grantRows = await db.query(sql`
    SELECT access_mode, consumed FROM grants WHERE grant_id = ${row.grant_id}
  `);
  if (grantRows.length && grantRows[0].access_mode === 'single_use' && grantRows[0].consumed) {
    return { active: false };  // token spent
  }
}
```

And in the RS query handler (`e2e/server/index.js`), after a successful query response is built (not on error), mark the grant consumed:
```js
// After successful query for single_use grants
if (tokenInfo.pdpp_token_kind === 'client' && tokenInfo.grant?.access_mode === 'single_use') {
  await db.query(sql`UPDATE grants SET consumed = 1 WHERE grant_id = ${tokenInfo.grant.grant_id}`);
}
```

### 2. AI training purpose validation in AS

In `approveGrant()` in `e2e/server/auth.js`, add:
```js
// The AS MUST obtain explicit affirmative consent before issuing ai_training grants.
// In demo mode, the frontend passes `ai_training_consented: true` when the user checks the box.
if (params.purpose_code === 'https://pdpp.org/purpose/ai_training' && !params.ai_training_consented) {
  throw new Error('Explicit affirmative consent required for ai_training purpose');
}
```

The approve-api endpoint passes `ai_training_consented` from the request body. The frontend only sends this when the checkbox was checked.

### 3. Grant revocation endpoint

Already exists in auth.js (`revokeGrant()`) and is exposed at `POST /grants/:grantId/revoke` — no changes needed.

---

## Instagram scraping script (browser-server/instagram-script.js)

This is a separate file (not inline) required by `index.js`. It is adapted from `context-gateway/public/automations/instagram-headless.js`.

**Adaptations required:**

1. Replace `page.getInput(config)` → `await requestInput(config)` (local function injected by runner)
2. Replace `page.setData(key, value)` → `broadcastData(key, value)` (local function)
3. After scraping `following_accounts`, call:
   ```js
   for (const account of followingAccounts) {
     await ingestRecord(connectorId, ownerToken, 'following_accounts', {
       key: account.pk_id || account.id,
       data: { id: account.pk_id || account.id, username: account.username,
               full_name: account.full_name, is_verified: account.is_verified },
       emitted_at: new Date().toISOString(),
     });
   }
   broadcast({ type: 'stream-complete', stream: 'following_accounts', count: followingAccounts.length });
   ```
4. After scraping posts (timeline), ingest to `posts` stream with `taken_at` from each post's timestamp (convert unix timestamp → ISO string).
5. After scraping ad targeting, ingest a single record to `ad_targeting`:
   ```js
   await ingestRecord(connectorId, ownerToken, 'ad_targeting', {
     key: 'targeting',
     data: { topics: adsData.ad_topics, advertisers: adsData.advertisers, categories: adsData.targeting_categories },
     emitted_at: new Date().toISOString(),
   });
   broadcast({ type: 'stream-complete', stream: 'ad_targeting', count: 1 });
   ```
6. The `grantIssuedAt` timestamp (from `start-scrape` message) is passed through and stored — it is used for the `time_range.since` parameter when requesting the grant, not at ingest time.

**ingestRecord helper** (in browser-server/index.js):
```js
async function ingestRecord(connectorId, ownerToken, stream, record) {
  const url = `${PDPP_RS_URL}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ownerToken}`, 'Content-Type': 'application/x-ndjson' },
    body: JSON.stringify(record),
  });
  if (!resp.ok) throw new Error(`Ingest failed: ${resp.status} ${await resp.text()}`);
}
```

---

## Grant request flow in DemoPage

### Step 1: Setup (`handleStart`)
- POST `/api/setup` → `{ ownerToken, connectorId }`
- Phase → `requesting`

### Step 2: Request research grant (`handleRequestResearchGrant`)
- POST `/api/grant` with:
  ```json
  {
    "connectorId": "https://registry.pdpp.org/connectors/instagram",
    "clientId": "audience_lens_app",
    "purposeCode": "https://pdpp.org/purpose/research",
    "purposeDescription": "Analyze your social graph for an influencer network study",
    "accessMode": "single_use",
    "streams": [
      { "name": "following_accounts", "view": "social_graph" },
      { "name": "posts", "view": "summary", "time_range": { "since": "<NOW_ISO>" } }
    ]
  }
  ```
  Note: `time_range.since` is set to the current timestamp at request time.
- Returns `{ device_code }`
- Store `researchGrantIssuedAt = new Date().toISOString()` at this moment
- Phase → `consenting_research`

### Step 3: Approve research grant (`handleApproveResearch`)
- POST `/api/grant/approve` with `{ device_code: researchDeviceCode }`
- Returns `{ token, grant }`
- Store `researchToken`, `researchGrant`
- Phase → `consenting_ai`

### Step 4: Request AI training grant (`handleRequestAiGrant`)
- POST `/api/grant` with:
  ```json
  {
    "connectorId": "...",
    "clientId": "audience_lens_app",
    "purposeCode": "https://pdpp.org/purpose/ai_training",
    "purposeDescription": "Use your social connections to improve recommendation models",
    "accessMode": "ongoing",
    "streams": [{ "name": "following_accounts", "view": "social_graph" }]
  }
  ```
- Phase stays `consenting_ai` (showing AI training consent card)

### Step 5: Approve AI training grant (`handleApproveAi`)
- POST `/api/grant/approve` with `{ device_code: aiDeviceCode, ai_training_consented: true }`
- Phase → `authenticating`
- Connect WebSocket to browser-server

### Step 6: WS input:request → user enters credentials
- `input:request` arrives → `CredentialForm` shown in ServerPanel
- User fills form → `input:response` sent → script proceeds
- Phase → `scraping` (on first `status: running` WS message)

### Step 7: Scraping completes
- `status: done` WS message
- Phase → `done` after fetching results (750ms delay for visual effect)

### Step 8: Fetch results
```ts
// Client view (field-projected, time-gated)
clientFollowing = GET /api/query?stream=following_accounts&token=<researchToken>&connectorId=<connectorId>
clientPosts = GET /api/query?stream=posts&token=<researchToken>&connectorId=<connectorId>
// → should be 0 records (posts.taken_at before consent time)

// Owner self-export (all fields, all streams)
ownerFollowing = GET /api/query?stream=following_accounts&token=<ownerToken>&connectorId=<connectorId>
ownerPosts = GET /api/query?stream=posts&token=<ownerToken>&connectorId=<connectorId>
ownerAds = GET /api/query?stream=ad_targeting&token=<ownerToken>&connectorId=<connectorId>
```

---

## Environment variables

### browser-server
```
PDPP_AS_URL=http://pdpp-server:7662
PDPP_RS_URL=http://pdpp-server:7663
PORT=3100
```

### app (build-time, baked by Next.js)
These must be passed as Docker build args and set in next.config.mjs `env:` so they are available at runtime without being `NEXT_PUBLIC_`:
```
PDPP_AS_URL=http://pdpp-server:7662   (server-side only)
PDPP_RS_URL=http://pdpp-server:7663   (server-side only)
```

The browser WebSocket URL must be runtime-derived (from `window.location.hostname + port 3101`) as implemented in the current DemoPage fix.

---

## docker-compose.yml final structure

```yaml
services:
  pdpp-server:
    build: { context: ../e2e, dockerfile: ../demo/Dockerfile.pdpp-server }
    ports: ["7662:7662", "7663:7663"]
    environment: [AS_PORT=7662, RS_PORT=7663]
    networks: [demo]

  browser-server:
    build: { context: ./browser-server }
    ports: ["${BROWSER_SERVER_HOST_PORT:-3101}:3100"]
    environment:
      - PDPP_AS_URL=http://pdpp-server:7662
      - PDPP_RS_URL=http://pdpp-server:7663
    depends_on: [pdpp-server]
    networks: [demo]
    shm_size: '2gb'

  app:
    build: { context: ./app }
    ports: ["${APP_HOST_PORT:-3002}:3000"]
    environment:
      - PDPP_AS_URL=http://pdpp-server:7662
      - PDPP_RS_URL=http://pdpp-server:7663
    depends_on: [pdpp-server, browser-server]
    networks: [demo]

networks:
  demo:
    driver: bridge
```

---

## Key implementation gotchas

1. **`NEXT_PUBLIC_*` vars are baked at build time** — the browser WS URL must be derived at runtime from `window.location.hostname`. See current `getBrowserWsUrl()` in DemoPage.tsx — keep this pattern.

2. **Canvas blur** — always match `canvas.width`/`canvas.height` attributes to the screencast `maxWidth`/`maxHeight`. Use `objectFit: contain` on the parent container, not on the canvas itself. The canvas element should fill its container with `width: 100%; height: 100%; display: block;`.

3. **`input:request` race** — the browser-server must NOT start sending frames until the WebSocket is established. Initialize Playwright and start screencasting before waiting for `start-scrape`, or start screencasting immediately after browser launch (before the input:request), so the canvas shows the Instagram login page while the credential form overlay is shown in the UI.

4. **Playwright version must be 1.43.0** (pinned) to match the Docker base image `mcr.microsoft.com/playwright:v1.43.0-jammy`.

5. **`time_range` in grant vs. query** — `time_range.since` goes in the grant (via `/api/grant`), not the query. The RS reads it from `streamGrant.time_range` and applies it in `passesTimeRange()`. The current RS code already does this — just make sure the grant request includes `time_range: { since: <ISO timestamp> }` on the posts stream.

6. **`single_use` enforcement** — requires the AS change described above. Without it, the "token spent" demo beat won't work.

7. **`ai_training_consented` flag** — the approve-api endpoint needs to forward this from request body to `approveGrant()`. Add it to the function signature and the validation in `approveGrant()`.

8. **WS send before open** — always use `addEventListener('open', fn, { once: true })` to send the initial `start-scrape` message rather than `onopen =` assignment, to avoid clobbering existing handlers.

9. **Instagram login may require 2FA** — the script from context-gateway already handles OTP via a second `input:request`. The `CredentialForm` component should handle both the initial credential request and the OTP request (detected by `schema.properties.otp` presence).

10. **Demo credentials** — the plan requires real Instagram credentials. These should be entered live by the presenter. The demo must NOT pre-fill or hardcode credentials. The `CredentialForm` handles this at runtime.

---

## Files NOT to change

- `e2e/server/db.js` — schema is complete
- `e2e/server/records.js` — all enforcement logic is correct
- `app/src/app/globals.css` — design tokens are fine
- `app/src/components/TerminalPanel.tsx` — no changes
- `app/src/components/DemoHeader.tsx` — minor step label updates only
- `app/Dockerfile` — unchanged
- `Dockerfile.pdpp-server` — unchanged

---

## Definition of done

- [ ] `docker compose up` starts all services with no errors
- [ ] Presenter navigates to `http://localhost:3002`
- [ ] Clicking "Connect Instagram" initiates the full flow
- [ ] Research consent card shows with correct fields, purpose URI, access mode badge
- [ ] AI training consent card shows with extra checkbox; Allow is disabled until checked
- [ ] Credential form appears; entering real Instagram creds allows scraping to proceed
- [ ] Live canvas shows real Instagram being navigated
- [ ] Terminal streams real log events
- [ ] Stream progress bars fill: following_accounts (N accounts), posts (M posts), ad_targeting (1 record)
- [ ] Comparison panel shows: client got 2 fields, owner got 4; client got 0 posts, owner got M; client has no ad_targeting, owner sees categories
- [ ] "Query Again" button returns 403 (single_use token spent)
- [ ] "Revoke" button causes next query to return 403 `grant_revoked`
- [ ] Canvas is sharp (not blurry/stretched)
- [ ] No 405 errors on reset
