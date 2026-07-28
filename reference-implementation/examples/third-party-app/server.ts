// SPDX-FileCopyrightText: The PDP-Connect Contributors
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Reference-local example third-party client app.
 *
 * What this is:
 * - a small Node + Express app that demonstrates the *current* thin PDPP
 *   reference provider-connect flow, end to end
 * - scoped to run against a local reference AS + RS (defaults:
 *   AS http://localhost:7662, RS http://localhost:7663)
 * - uses only the existing public reference endpoints:
 *     POST /oauth/register, POST /oauth/par, POST /consent/approve (inline
 *     JSON shortcut), GET /consent (hosted approval page), POST /introspect,
 *     GET {rs}/v1/streams, GET {rs}/v1/streams/:stream/records
 *
 * What this is NOT:
 * - not a generic OAuth authorization-code redirect client
 * - not a PKCE / code-exchange client
 * - not the PDPP server UI; this is a third-party client illustration
 *
 * In-memory single-session state keeps the reference demo obvious. Restart
 * the process to start over.
 */
type RequestBody = Record<string, string | undefined>;
interface Request {
  body: RequestBody;
}
interface Response {
  redirect: (path: string) => void;
  send: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
}
type Handler = (...args: [Request, Response]) => unknown;
interface ExpressApp {
  get: (path: string, handler: Handler) => void;
  listen: (port: number, callback: () => void) => { close: () => void };
  post: (path: string, handler: Handler) => void;
  use: (handler: unknown) => void;
}
interface Draft {
  accessMode: string;
  clientName: string;
  initialAccessToken: string;
  pastedToken: string;
  purposeCode: string;
  purposeDescription: string;
  queryStream: string;
  sourceId: string;
  sourceKind: string;
  streamName: string;
  subjectId: string;
}
interface StagedRequest {
  authorization_url?: string;
  request_uri: string;
}
interface TokenInfo {
  grant: unknown;
  grantId: string | null;
  source: string;
  token: string;
}
interface QueryInfo {
  body: unknown;
  label: string;
}
interface ExampleState {
  clientId: string;
  draft: Draft;
  introspection: unknown | null;
  lastApprovalError: string | null;
  lastIntrospectError: string | null;
  lastParError: string | null;
  lastQuery: QueryInfo | null;
  lastQueryError: string | null;
  lastRegistrationError: string | null;
  ownerAuthSuspected: boolean;
  registeredClient: Record<string, unknown> | null;
  stagedRequest: StagedRequest | null;
  tokenInfo: TokenInfo | null;
}

function parseSourceKind(value: string): "connector" | "provider_native" {
  if (value === "connector" || value === "provider_native") {
    return value;
  }
  throw new Error("sourceKind must be 'connector' or 'provider_native'");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ownerAuthEnabled(error: unknown): boolean {
  return error instanceof Error && "ownerAuthEnabled" in error && error.ownerAuthEnabled === true;
}

import express from "express";
import {
  approveInline,
  buildHostedApprovalUrl,
  buildParRequest,
  denyInline,
  introspectToken,
  queryStreamRecords,
  queryStreams,
  registerClient,
  stageParRequest,
} from "./lib/flow.ts";

const PORT = Number.parseInt(process.env.PORT || "7674", 10);
const TRAILING_SLASHES_RE = /\/+$/;
const HTML_ESCAPE_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/&/g, "&amp;"],
  [/</g, "&lt;"],
  [/>/g, "&gt;"],
  [/"/g, "&quot;"],
  [/'/g, "&#39;"],
];
const AS_URL = stripSlash(process.env.AS_URL || "http://localhost:7662");
const RS_URL = stripSlash(process.env.RS_URL || "http://localhost:7663");
const CLIENT_LABEL = process.env.CLIENT_LABEL || "Reference Client (Longview)";

function stripSlash(value: string): string {
  return value.replace(TRAILING_SLASHES_RE, "");
}

function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return HTML_ESCAPE_REPLACEMENTS.reduce(
    (escaped, [pattern, replacement]) => escaped.replace(pattern, replacement),
    String(value)
  );
}

// Default draft values shipped with the example app. These match the
// reference Spotify connector manifest
// (`reference-implementation/manifests/spotify.json`) so a developer can run
// the example against a local reference stack (after registering that
// manifest) and stage a PAR request, approve it, and query records without
// having to edit the form. Exported so tests can prove the defaults remain
// usable when the example app ships.
export function buildDefaultDraft() {
  return {
    accessMode: "single_use",
    clientName: CLIENT_LABEL,
    initialAccessToken: "",
    pastedToken: "",
    purposeCode: "https://pdpp.org/purpose/personalization",
    purposeDescription: "Recommend concerts based on your listening history.",
    queryStream: "",
    sourceId: "https://registry.pdpp.org/connectors/spotify",
    sourceKind: "connector",
    streamName: "top_artists",
    subjectId: "owner_local",
  };
}

// ───── In-memory demo state ─────
const state: ExampleState = {
  clientId: "",
  draft: buildDefaultDraft(),
  introspection: null,
  lastApprovalError: null,
  lastIntrospectError: null,
  lastParError: null,
  lastQuery: null,
  lastQueryError: null,
  lastRegistrationError: null,
  ownerAuthSuspected: false,
  registeredClient: null,
  stagedRequest: null,
  tokenInfo: null,
};

function updateDraft(body: RequestBody = {}) {
  for (const key of Object.keys(state.draft) as Array<keyof Draft>) {
    if (typeof body[key] === "string") {
      state.draft[key] = body[key].trim();
    }
  }
}

function conditionalHtml(condition: unknown, content: string): string {
  return condition ? content : "";
}

function renderPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PDPP Reference — Example Third-Party Client</title>
<style>
  body { font: 14px/1.5 system-ui, -apple-system, sans-serif; color: #111; background: #f7f7f8; margin: 0; padding: 24px; }
  main { max-width: 920px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px 0; }
  h2 { font-size: 16px; margin: 28px 0 8px 0; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  .tag { display: inline-block; font-size: 11px; background: #eef; color: #225; padding: 2px 6px; border-radius: 3px; margin-right: 6px; }
  section { background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 16px; margin-bottom: 16px; }
  form.inline { display: grid; grid-template-columns: 180px 1fr; gap: 8px 12px; align-items: center; }
  form.inline label { font-weight: 600; }
  form.inline input, form.inline textarea { padding: 4px 6px; border: 1px solid #bbb; border-radius: 3px; font: inherit; width: 100%; }
  form.actions { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
  button { background: #225; color: #fff; border: none; padding: 6px 12px; border-radius: 3px; cursor: pointer; font: inherit; }
  button.secondary { background: #777; }
  button.danger { background: #a33; }
  pre { background: #f0f0f2; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 12px; }
  .muted { color: #666; }
  .err { color: #a33; white-space: pre-wrap; }
  .ok { color: #285; }
  code { background: #f0f0f2; padding: 1px 4px; border-radius: 3px; }
</style>
</head>
<body>
<main>
  <header>
    <h1>${escapeHtml(CLIENT_LABEL)}</h1>
    <div class="muted">
      Reference-local example third-party client for PDPP. Demonstrates the current
      <strong>thin reference provider-connect flow</strong>: register &rarr; PAR &rarr; owner approval &rarr; token &rarr; RS query.
    </div>
    <div class="muted" style="margin-top: 6px;">
      This is <em>not</em> a generic OAuth authorization-code redirect client.
    </div>
  </header>

  <section>
    <h2><span class="tag">1</span>App setup</h2>
    <div><strong>AS:</strong> <code>${escapeHtml(AS_URL)}</code></div>
    <div><strong>RS:</strong> <code>${escapeHtml(RS_URL)}</code></div>
    <div style="margin-top: 6px;"><strong>Client ID:</strong> ${conditionalHtml(state.clientId, `<code>${escapeHtml(state.clientId)}</code>`) || '<span class="muted">(not yet registered)</span>'}</div>
    ${conditionalHtml(state.registeredClient, `<details><summary>Registered client metadata</summary><pre>${escapeHtml(JSON.stringify(state.registeredClient, null, 2))}</pre></details>`)}
    ${conditionalHtml(state.lastRegistrationError, `<div class="err">${escapeHtml(state.lastRegistrationError || "")}</div>`)}

    <form method="post" action="/register" class="inline" style="margin-top: 12px;">
      <label for="clientName">client_name</label>
      <input id="clientName" name="clientName" value="${escapeHtml(state.draft.clientName)}" />
      <label for="initialAccessToken">initial access token (optional)</label>
      <input id="initialAccessToken" name="initialAccessToken" value="${escapeHtml(state.draft.initialAccessToken)}" />
      <div></div>
      <div class="actions">
        <button type="submit">Dynamically register client</button>
      </div>
    </form>
  </section>

  <section>
    <h2><span class="tag">2</span>Request staging (PAR)</h2>
    <form method="post" action="/par" class="inline">
      <label for="sourceKind">source.kind</label>
      <input id="sourceKind" name="sourceKind" value="${escapeHtml(state.draft.sourceKind)}" />
      <label for="sourceId">source.id</label>
      <input id="sourceId" name="sourceId" value="${escapeHtml(state.draft.sourceId)}" />
      <label for="streamName">stream name</label>
      <input id="streamName" name="streamName" value="${escapeHtml(state.draft.streamName)}" />
      <label for="purposeCode">purpose_code</label>
      <input id="purposeCode" name="purposeCode" value="${escapeHtml(state.draft.purposeCode)}" />
      <label for="purposeDescription">purpose_description</label>
      <input id="purposeDescription" name="purposeDescription" value="${escapeHtml(state.draft.purposeDescription)}" />
      <label for="accessMode">access_mode</label>
      <input id="accessMode" name="accessMode" value="${escapeHtml(state.draft.accessMode)}" />
      <div></div>
      <div class="actions">
        <button type="submit">Stage PAR request</button>
      </div>
    </form>
    ${conditionalHtml(state.lastParError, `<div class="err" style="margin-top: 10px;">${escapeHtml(state.lastParError || "")}</div>`)}
    ${
      state.stagedRequest
        ? `
      <div style="margin-top: 10px;">
        <div><strong>request_uri:</strong> <code>${escapeHtml(state.stagedRequest.request_uri || "")}</code></div>
        ${state.stagedRequest.authorization_url ? `<div><strong>authorization_url:</strong> <code>${escapeHtml(state.stagedRequest.authorization_url)}</code></div>` : ""}
        <details><summary>Full PAR response</summary><pre>${escapeHtml(JSON.stringify(state.stagedRequest, null, 2))}</pre></details>
      </div>
    `
        : ""
    }
  </section>

  <section>
    <h2><span class="tag">3</span>Owner approval</h2>
    ${
      state.stagedRequest?.request_uri
        ? `
      <div>
        <a href="${escapeHtml(buildHostedApprovalUrl({ asUrl: AS_URL, requestUri: state.stagedRequest.request_uri }))}" target="_blank" rel="noopener noreferrer">Open hosted consent page &rarr;</a>
        <div class="muted">Use this path when the reference server has <code>PDPP_OWNER_PASSWORD</code> set — the hosted page is the authoritative approval surface.</div>
      </div>
      <form method="post" action="/approve" class="inline" style="margin-top: 12px;">
        <label for="subjectId">subject_id</label>
        <input id="subjectId" name="subjectId" value="${escapeHtml(state.draft.subjectId)}" />
        <div></div>
        <div class="actions">
          <button type="submit">Inline approve (reference-local shortcut)</button>
          <button type="submit" formaction="/deny" class="danger">Inline deny</button>
        </div>
      </form>
      ${conditionalHtml(state.ownerAuthSuspected, `<div class="muted" style="margin-top: 8px;">Inline approval is unavailable because owner authentication is enabled. Use the hosted page above, then paste the issued token below.</div>`)}
      ${conditionalHtml(state.lastApprovalError, `<div class="err" style="margin-top: 8px;">${escapeHtml(state.lastApprovalError || "")}</div>`)}
    `
        : '<div class="muted">Stage a PAR request first.</div>'
    }
  </section>

  <section>
    <h2><span class="tag">4</span>Token</h2>
    ${
      state.tokenInfo?.token
        ? `
      <div class="ok">Token acquired via <code>${escapeHtml(state.tokenInfo.source)}</code></div>
      <div style="margin-top: 6px;"><strong>access_token:</strong> <code>${escapeHtml(state.tokenInfo.token)}</code></div>
      ${conditionalHtml(state.tokenInfo.grantId, `<div><strong>grant_id:</strong> <code>${escapeHtml(state.tokenInfo.grantId || "")}</code></div>`)}
      <details><summary>Issued grant snapshot</summary><pre>${escapeHtml(JSON.stringify(state.tokenInfo.grant || state.tokenInfo, null, 2))}</pre></details>
      <form method="post" action="/introspect" class="actions">
        <button type="submit" class="secondary">Introspect token</button>
      </form>
      ${conditionalHtml(state.introspection, `<details open><summary>Introspection result</summary><pre>${escapeHtml(JSON.stringify(state.introspection, null, 2))}</pre></details>`)}
      ${conditionalHtml(state.lastIntrospectError, `<div class="err">${escapeHtml(state.lastIntrospectError || "")}</div>`)}
    `
        : '<div class="muted">No token yet. Approve the request above, or paste a token obtained from the hosted consent page.</div>'
    }

    <form method="post" action="/token/paste" class="inline" style="margin-top: 16px;">
      <label for="pastedToken">paste access_token</label>
      <input id="pastedToken" name="pastedToken" value="${escapeHtml(state.draft.pastedToken)}" placeholder="Paste a token issued by the hosted consent page" />
      <div></div>
      <div class="actions">
        <button type="submit" class="secondary">Use pasted token</button>
      </div>
    </form>
  </section>

  <section>
    <h2><span class="tag">5</span>Resource query</h2>
    ${
      state.tokenInfo?.token
        ? `
      <form method="post" action="/query/streams" class="actions">
        <button type="submit">List streams (GET /v1/streams)</button>
      </form>
      <form method="post" action="/query/records" class="inline" style="margin-top: 12px;">
        <label for="queryStream">stream name</label>
        <input id="queryStream" name="queryStream" value="${escapeHtml(state.draft.queryStream || state.draft.streamName)}" />
        <div></div>
        <div class="actions">
          <button type="submit">Query records (GET /v1/streams/:stream/records)</button>
        </div>
      </form>
      ${conditionalHtml(state.lastQueryError, `<div class="err" style="margin-top: 10px;">${escapeHtml(state.lastQueryError || "")}</div>`)}
      ${conditionalHtml(state.lastQuery, `<details open style="margin-top: 10px;"><summary>${escapeHtml(state.lastQuery?.label || "")}</summary><pre>${escapeHtml(JSON.stringify(state.lastQuery?.body, null, 2))}</pre></details>`)}
    `
        : '<div class="muted">Acquire a token first.</div>'
    }
  </section>

  <section>
    <form method="post" action="/reset" class="actions">
      <button type="submit" class="danger">Reset demo state</button>
    </form>
  </section>
</main>
</body>
</html>`;
}

const app = express() as ExpressApp;
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderPage());
});

app.post("/register", async (req: Request, res: Response) => {
  updateDraft(req.body);
  state.lastRegistrationError = null;
  try {
    const registered = await registerClient({
      asUrl: AS_URL,
      initialAccessToken: state.draft.initialAccessToken,
      metadata: {
        client_name: state.draft.clientName,
        token_endpoint_auth_method: "none",
      },
    });
    state.registeredClient = registered;
    state.clientId = registered.client_id;
  } catch (err) {
    state.lastRegistrationError = errorMessage(err);
  }
  res.redirect("/");
});

app.post("/par", async (req: Request, res: Response) => {
  updateDraft(req.body);
  state.lastParError = null;
  try {
    const request = buildParRequest({
      accessMode: state.draft.accessMode,
      clientId: state.clientId,
      clientName: state.draft.clientName,
      purposeCode: state.draft.purposeCode,
      purposeDescription: state.draft.purposeDescription,
      sourceId: state.draft.sourceId,
      sourceKind: parseSourceKind(state.draft.sourceKind),
      streamName: state.draft.streamName,
    });
    const staged = await stageParRequest({ asUrl: AS_URL, request });
    state.stagedRequest = staged;
  } catch (err) {
    state.lastParError = errorMessage(err);
  }
  res.redirect("/");
});

app.post("/approve", async (req: Request, res: Response) => {
  updateDraft(req.body);
  state.lastApprovalError = null;
  state.ownerAuthSuspected = false;
  const requestUri = state.stagedRequest?.request_uri;
  if (!requestUri) {
    state.lastApprovalError = "No staged request to approve.";
    return res.redirect("/");
  }
  try {
    const { token, grantId, grant } = await approveInline({
      asUrl: AS_URL,
      requestUri,
      subjectId: state.draft.subjectId,
    });
    state.tokenInfo = { grant, grantId, source: "inline approval", token };
  } catch (err) {
    state.lastApprovalError = errorMessage(err);
    if (ownerAuthEnabled(err)) {
      state.ownerAuthSuspected = true;
    }
  }
  res.redirect("/");
});

app.post("/deny", async (_req: Request, res: Response) => {
  state.lastApprovalError = null;
  state.ownerAuthSuspected = false;
  const requestUri = state.stagedRequest?.request_uri;
  if (!requestUri) {
    state.lastApprovalError = "No staged request to deny.";
    return res.redirect("/");
  }
  try {
    await denyInline({ asUrl: AS_URL, requestUri });
    state.lastApprovalError = "Request denied.";
  } catch (err) {
    state.lastApprovalError = errorMessage(err);
    if (ownerAuthEnabled(err)) {
      state.ownerAuthSuspected = true;
    }
  }
  res.redirect("/");
});

app.post("/token/paste", (req: Request, res: Response) => {
  updateDraft(req.body);
  const pasted = state.draft.pastedToken;
  if (pasted) {
    state.tokenInfo = { grant: null, grantId: null, source: "pasted from hosted approval", token: pasted };
    state.introspection = null;
    state.lastIntrospectError = null;
  } else {
    state.lastApprovalError = "No token pasted.";
  }
  res.redirect("/");
});

app.post("/introspect", async (_req: Request, res: Response) => {
  state.lastIntrospectError = null;
  if (!state.tokenInfo?.token) {
    state.lastIntrospectError = "No token to introspect.";
    return res.redirect("/");
  }
  try {
    state.introspection = await introspectToken({ asUrl: AS_URL, token: state.tokenInfo.token });
  } catch (err) {
    state.lastIntrospectError = errorMessage(err);
  }
  res.redirect("/");
});

app.post("/query/streams", async (_req: Request, res: Response) => {
  state.lastQueryError = null;
  if (!state.tokenInfo?.token) {
    state.lastQueryError = "No token.";
    return res.redirect("/");
  }
  try {
    const body = await queryStreams({ rsUrl: RS_URL, token: state.tokenInfo.token });
    state.lastQuery = { body, label: "GET /v1/streams" };
  } catch (err) {
    state.lastQueryError = errorMessage(err);
  }
  res.redirect("/");
});

app.post("/query/records", async (req: Request, res: Response) => {
  updateDraft(req.body);
  state.lastQueryError = null;
  if (!state.tokenInfo?.token) {
    state.lastQueryError = "No token.";
    return res.redirect("/");
  }
  const stream = state.draft.queryStream || state.draft.streamName;
  if (!stream) {
    state.lastQueryError = "stream name required.";
    return res.redirect("/");
  }
  try {
    const body = await queryStreamRecords({ rsUrl: RS_URL, streamName: stream, token: state.tokenInfo.token });
    state.lastQuery = { body, label: `GET /v1/streams/${stream}/records` };
  } catch (err) {
    state.lastQueryError = errorMessage(err);
  }
  res.redirect("/");
});

app.post("/reset", (_req: Request, res: Response) => {
  state.clientId = "";
  state.registeredClient = null;
  state.lastRegistrationError = null;
  state.stagedRequest = null;
  state.lastParError = null;
  state.tokenInfo = null;
  state.lastApprovalError = null;
  state.ownerAuthSuspected = false;
  state.introspection = null;
  state.lastIntrospectError = null;
  state.lastQuery = null;
  state.lastQueryError = null;
  res.redirect("/");
});

if (process.argv[1]?.endsWith("examples/third-party-app/server.ts")) {
  app.listen(PORT, () => {
    console.error(`[pdpp-reference-example-client] Listening on http://localhost:${PORT}`);
    console.error(`[pdpp-reference-example-client] AS ${AS_URL} / RS ${RS_URL}`);
  });
}

export { app };
