import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { issueOwnerToken } from "./orchestrator.ts";

test("issueOwnerToken approves device flow without owner login when owner password is unset", async () => {
  const previousPassword = process.env.PDPP_OWNER_PASSWORD;
  delete process.env.PDPP_OWNER_PASSWORD;
  const server = await createOwnerTokenServer({ requireOwnerCookie: false });
  try {
    const token = await issueOwnerToken(server.url, "owner_no_password");

    assert.equal(token, "token_owner_no_password");
    assert.equal(server.state.loginRequests, 0);
    assert.equal(server.state.approveCookie, null);
  } finally {
    restoreEnv("PDPP_OWNER_PASSWORD", previousPassword);
    await server.close();
  }
});

test("issueOwnerToken carries owner session cookie when owner password is configured", async () => {
  const previousPassword = process.env.PDPP_OWNER_PASSWORD;
  process.env.PDPP_OWNER_PASSWORD = "correct-password";
  const server = await createOwnerTokenServer({ requireOwnerCookie: true });
  try {
    const token = await issueOwnerToken(server.url, "owner_with_password");

    assert.equal(token, "token_owner_with_password");
    assert.equal(server.state.loginRequests, 1);
    assert.equal(server.state.loginBody, "password=correct-password");
    assert.equal(server.state.approveCookie, "pdpp_owner_session=test-session");
  } finally {
    restoreEnv("PDPP_OWNER_PASSWORD", previousPassword);
    await server.close();
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function createOwnerTokenServer({ requireOwnerCookie }: { requireOwnerCookie: boolean }): Promise<{
  close: () => Promise<void>;
  state: {
    approveCookie: string | null;
    loginBody: string | null;
    loginRequests: number;
    subjectId: string | null;
  };
  url: string;
}> {
  const state = {
    approveCookie: null as string | null,
    loginBody: null as string | null,
    loginRequests: 0,
    subjectId: null as string | null,
  };
  const server = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/owner/login") {
      state.loginRequests += 1;
      state.loginBody = await readRequestBody(req);
      if (state.loginBody !== "password=correct-password") {
        sendText(res, 401, "bad password");
        return;
      }
      res.statusCode = 302;
      res.setHeader("set-cookie", "pdpp_owner_session=test-session; Path=/; HttpOnly");
      res.setHeader("location", "/dashboard");
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/oauth/device_authorization") {
      sendJson(res, 200, { device_code: "device-code", user_code: "USER-CODE" });
      return;
    }

    if (req.method === "POST" && req.url === "/device/approve") {
      state.approveCookie = req.headers.cookie ?? null;
      const body = new URLSearchParams(await readRequestBody(req));
      state.subjectId = body.get("subject_id");
      if (requireOwnerCookie && state.approveCookie !== "pdpp_owner_session=test-session") {
        sendText(res, 401, "owner session required");
        return;
      }
      sendText(res, 200, "approved");
      return;
    }

    if (req.method === "POST" && req.url === "/oauth/token") {
      sendJson(res, 200, { access_token: `token_${state.subjectId ?? "missing_subject"}` });
      return;
    }

    sendText(res, 404, "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    state,
    url: `http://127.0.0.1:${address.port}`,
  };
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(body);
}
